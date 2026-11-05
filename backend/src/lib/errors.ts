export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) { super(message ?? code); }
}
export const notFound = (what = 'not_found') => new AppError(404, what);
export const forbidden = (what = 'forbidden') => new AppError(403, what);
export const badRequest = (code: string, details?: unknown) => new AppError(400, code, code, details);
export const conflict = (code: string) => new AppError(409, code);
export const unauthorized = (code = 'unauthorized') => new AppError(401, code);
