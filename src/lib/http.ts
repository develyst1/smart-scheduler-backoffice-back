export class ApiException extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (message = "ไม่พบข้อมูล") =>
  new ApiException(404, "NOT_FOUND", message);

export const badRequest = (message: string, details?: unknown) =>
  new ApiException(400, "VALIDATION", message, details);

export const conflict = (code: string, message: string) =>
  new ApiException(409, code, message);

export const forbidden = (message = "ไม่มีสิทธิ์") =>
  new ApiException(403, "FORBIDDEN", message);

export const unauthorized = (message = "ไม่ได้รับอนุญาต") =>
  new ApiException(401, "UNAUTHORIZED", message);

export function pgErrorCode(e: unknown): string | undefined {
  let cur = e as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}
