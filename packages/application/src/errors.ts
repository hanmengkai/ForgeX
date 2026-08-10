export interface ApplicationErrorDetail {
  field: string;
  message: string;
  code: string;
}

export class ApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ApplicationErrorDetail[],
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
