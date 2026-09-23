/**
 * 给人看的错误。message 直接写成用户能懂的中文，CLI 和接力台原样显示，不再二次翻译。
 * code 供程序判断（测试、网页决定显示哪个按钮）。
 */
export class RelayError extends Error {
  readonly code: string;

  constructor(message: string, code = 'relay') {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

export function fail(message: string, code?: string): never {
  throw new RelayError(message, code);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
