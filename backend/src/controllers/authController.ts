import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../middleware/errorHandler';
import { AuthUser, UserRole } from '../middleware/auth';

export const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required')
});

interface UserRecord extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  manager_id: number | null;
  active: number | boolean;
}

export class AuthController {
  constructor(private db: Pool) {}

  login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      // 1. Fetch user by email
      const [rows] = await this.db.query<UserRecord[]>(
        'SELECT id, name, email, password_hash, role, manager_id, active FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      // Task A3: Return identical error message and code for unknown user and wrong password
      if (rows.length === 0) {
        throw new AppError({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          statusCode: 401
        });
      }

      const user = rows[0];

      if (!user.active) {
        throw new AppError({
          code: 'ACCOUNT_INACTIVE',
          message: 'User account has been deactivated',
          statusCode: 403
        });
      }

      // 2. Verify password
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        throw new AppError({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          statusCode: 401
        });
      }

      // 3. Generate JWT with 8h expiry (Task A3)
      const secret = process.env.JWT_SECRET!;
      const expiresIn: SignOptions['expiresIn'] = '8h';

      const payload: AuthUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        manager_id: user.manager_id
      };

      const token = jwt.sign(payload, secret, { expiresIn });

      return res.status(200).json({
        token,
        user: payload
      });
    } catch (error) {
      next(error);
    }
  };
}
