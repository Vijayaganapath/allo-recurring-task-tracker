import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';

export type UserRole = 'EMPLOYEE' | 'MANAGER' | 'LEADERSHIP' | 'ADMIN';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  manager_id: number | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'super_secure_jwt_secret_for_allo_innoware_2026';

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError({
        code: 'UNAUTHORIZED',
        message: 'Authorization token is required',
        statusCode: 401
      })
    );
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch (err) {
    return next(
      new AppError({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
        statusCode: 401
      })
    );
  }
}

export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(
        new AppError({
          code: 'UNAUTHORIZED',
          message: 'User authentication required',
          statusCode: 401
        })
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError({
          code: 'FORBIDDEN',
          message: `Access denied for role '${req.user.role}'`,
          statusCode: 403
        })
      );
    }

    next();
  };
}
