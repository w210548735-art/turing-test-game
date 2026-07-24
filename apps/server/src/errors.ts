export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorBody(error: unknown): {
  error: { code: string; message: string };
} {
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message } };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用，请稍后重试。",
    },
  };
}
