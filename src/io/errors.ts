/**
 * IO 层统一错误类型。
 *
 * 引擎/CLI 侧只需捕获 `IoError` 并读取 `code` 决定退出码与错误分类：
 * - INPUT_INVALID   输入文件格式/内容非法（对应 CLI 退出码 2）
 * - FILE_NOT_FOUND  输入文件不存在（退出码 2）
 * - DB_ERROR        数据库访问失败（退出码 4）
 * - DB_NOT_FOUND    mock 库或 manifest 不存在（退出码 4）
 * - TABLE_NOT_FOUND 描述的表不存在（退出码 4）
 * - UNSUPPORTED     不支持的能力（如未安装 pg，退出码 3）
 */
export class IoError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IoError';
    this.code = code;
  }
}

/** 把任意异常包装成带中文 message 的 IoError（已是 IoError 时原样返回）。 */
export function asIoError(err: unknown, code: string, prefix: string): IoError {
  if (err instanceof IoError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new IoError(code, `${prefix}：${msg}`, { cause: err });
}
