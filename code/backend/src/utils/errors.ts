// Typed error hierarchy used by the centralized error handler to pick the
// right HTTP status code without every controller/service repeating it.
export class AppError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

// The request is fine but a dependency (e.g. the document storage backend)
// failed in a way the client cannot fix; retrying later may succeed.
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable. Please try again shortly.') {
    super(503, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super(429, message);
  }
}
