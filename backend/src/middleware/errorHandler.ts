import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export interface AppErrorOptions {
  code: string;
  message: string;
  statusCode?: number;
  details?: any;
}

export class AppError extends Error {
  public code: string;
  public statusCode: number;
  public details?: any;

  constructor({ code, message, statusCode = 400, details }: AppErrorOptions) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // If headers already sent, pass to default express handler
  if (res.headersSent) {
    return next(err);
  }

  // Zod Validation Error
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request input data',
        details: err.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message
        }))
      }
    });
  }

  // AppError instance
  if (err instanceof AppError) {
    const errorBody: any = {
      code: err.code,
      message: err.message
    };
    if (err.details !== undefined) {
      errorBody.details = err.details;
    }
    return res.status(err.statusCode).json({ error: errorBody });
  }

  // Fallback 500 Internal Server Error
  console.error('[Unhandled Error]:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred'
    }
  });
}
