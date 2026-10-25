/**
 * 零依赖 ZIP 读写（仅支持 xlsx 所需的子集）。
 *
 * 读：支持 stored(0) / deflate(8)，以**中央目录**里的尺寸为准（Excel 生成的文件带
 * data descriptor，local header 的 crc/尺寸可能为 0），支持 UTF-8 文件名与 data descriptor。
 * 写：只写 deflate，flags 置 UTF-8(bit 11)，不使用 data descriptor（尺寸/CRC 直接写进 local header）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { IoError } from './errors.js';

/* ------------------------------------------------------------------ */
/* CRC32                                                               */
/* ------------------------------------------------------------------ */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3，zip 使用）。 */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** 读取 zip，返回 `文件名 -> 解压后内容`（保持中央目录顺序）。 */
export function readZip(path: string): Map<string, Buffer> {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new IoError('FILE_NOT_FOUND', `无法读取文件：${path}`, { cause: err });
  }
  const entries = readCentralDirectory(raw, path);
  const out = new Map<string, Buffer>();
  for (const entry of entries) {
    out.set(entry.name, readEntry(raw, entry, path));
  }
  return out;
}

function readCentralDirectory(raw: Buffer, path: string): CentralEntry[] {
  const eocd = findEocd(raw);
  if (eocd < 0) {
    throw new IoError('INPUT_INVALID', `不是有效的 xlsx/zip 文件（未找到中央目录）：${path}`);
  }
  const count = raw.readUInt16LE(eocd + 10);
  const cdSize = raw.readUInt32LE(eocd + 12);
  const cdOffset = raw.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new IoError('UNSUPPORTED', `暂不支持 ZIP64 格式的 xlsx：${path}`);
  }
  if (count === 0xffff) {
    throw new IoError('UNSUPPORTED', `暂不支持超过 65534 个条目的 ZIP：${path}`);
  }
  const entries: CentralEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > raw.length || raw.readUInt32LE(offset) !== SIG_CD) {
      throw new IoError('INPUT_INVALID', `xlsx 中央目录损坏（第 ${i + 1} 项）：${path}`);
    }
    const flags = raw.readUInt16LE(offset + 8);
    const method = raw.readUInt16LE(offset + 10);
    const crc = raw.readUInt32LE(offset + 16);
    const compressedSize = raw.readUInt32LE(offset + 20);
    const uncompressedSize = raw.readUInt32LE(offset + 24);
    const nameLength = raw.readUInt16LE(offset + 28);
    const extraLength = raw.readUInt16LE(offset + 30);
    const commentLength = raw.readUInt16LE(offset + 32);
    const localHeaderOffset = raw.readUInt32LE(offset + 42);
    const name = raw.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(raw: Buffer): number {
  const min = Math.max(0, raw.length - 65557);
  for (let i = raw.length - 22; i >= min; i -= 1) {
    if (raw.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readEntry(raw: Buffer, entry: CentralEntry, path: string): Buffer {
  const lho = entry.localHeaderOffset;
  if (lho + 30 > raw.length || raw.readUInt32LE(lho) !== SIG_LOCAL) {
    throw new IoError('INPUT_INVALID', `xlsx 本地文件头损坏（${entry.name}）：${path}`);
  }
  const nameLength = raw.readUInt16LE(lho + 26);
  const extraLength = raw.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > raw.length) {
    throw new IoError('INPUT_INVALID', `xlsx 条目数据被截断（${entry.name}）：${path}`);
  }
  const compressed = raw.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(compressed);
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(compressed);
    } catch (err) {
      throw new IoError('INPUT_INVALID', `xlsx 条目解压失败（${entry.name}）：${path}`, { cause: err });
    }
  } else {
    throw new IoError('UNSUPPORTED', `不支持的 zip 压缩算法 ${entry.method}（${entry.name}）：${path}`);
  }
  if (entry.uncompressedSize > 0 && data.length !== entry.uncompressedSize) {
    // 校验失败通常是文件损坏；直接报错避免静默读出半截 XML。
    throw new IoError('INPUT_INVALID', `xlsx 条目大小校验失败（${entry.name}）：${path}`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

export interface ZipEntryInput {
  name: string;
  data: Buffer;
}

/** DOS 时间戳（固定为 2026-01-01 00:00:00，保证输出可重复）。 */
function dosDateTime(): { time: number; date: number } {
  const year = 2026;
  const month = 1;
  const day = 1;
  return { time: 0, date: ((year - 1980) << 9) | (month << 5) | day };
}

/** 写出 zip（deflate，UTF-8 文件名，无 data descriptor）。 */
export function writeZip(path: string, entries: ZipEntryInput[]): void {
  const { time, date } = dosDateTime();
  const chunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名；无 data descriptor
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    chunks.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(SIG_CD, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralChunks.push(central);

    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  try {
    writeFileSync(path, Buffer.concat([...chunks, ...centralChunks, eocd]));
  } catch (err) {
    throw new IoError('INPUT_INVALID', `写出文件失败：${path}`, { cause: err });
  }
}
