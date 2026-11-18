import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Pool } from 'mysql2/promise';
import { createAuthRouter } from '../../src/routes/authRoutes';
import { authenticate, authorize } from '../../src/middleware/auth';
import { errorHandler } from '../../src/middleware/errorHandler';

describe('Auth & RBAC Unit Tests (docs/PRODUCT.md Section 8)', () => {
  let app: express.Application;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn()
    } as unknown as jest.Mocked<Pool>;

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(mockPool));

    // Test protected routes to verify RBAC middleware
    app.get('/api/protected/any', authenticate, (req, res) => {
      res.json({ message: 'authenticated', user: req.user });
    });

    app.get('/api/protected/manager', authenticate, authorize('MANAGER', 'ADMIN'), (req, res) => {
      res.json({ message: 'manager access granted' });
    });

    app.use(errorHandler);
  });

  describe('POST /api/auth/login', () => {
    test('rejects request with missing or invalid email format (400 validation)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'not-an-email', password: 'password' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    test('rejects non-existent user with 401 INVALID_CREDENTIALS', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'unknown@example.com', password: 'Password123!' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    test('rejects inactive user with 403 ACCOUNT_INACTIVE', async () => {
      const user = {
        id: 1,
        name: 'Inactive User',
        email: 'inactive@example.com',
        password_hash: 'somehash',
        role: 'EMPLOYEE',
        manager_id: null,
        active: 0
      };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[user]]);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'inactive@example.com', password: 'Password123!' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
    });

    test('rejects incorrect password with 401 INVALID_CREDENTIALS', async () => {
      const passwordHash = await bcrypt.hash('CorrectPassword123!', 8);
      const user = {
        id: 1,
        name: 'John Doe',
        email: 'john@example.com',
        password_hash: passwordHash,
        role: 'EMPLOYEE',
        manager_id: 2,
        active: 1
      };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[user]]);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'john@example.com', password: 'WrongPassword!' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    test('successfully authenticates with valid credentials, returns JWT and user payload', async () => {
      const rawPassword = 'Password123!';
      const passwordHash = await bcrypt.hash(rawPassword, 8);
      const user = {
        id: 4,
        name: 'Alex Employee',
        email: 'alex@alloinnoware.com',
        password_hash: passwordHash,
        role: 'EMPLOYEE',
        manager_id: 2,
        active: 1
      };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[user]]);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alex@alloinnoware.com', password: rawPassword });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toEqual({
        id: 4,
        name: 'Alex Employee',
        email: 'alex@alloinnoware.com',
        role: 'EMPLOYEE',
        manager_id: 2
      });

      // Verify token
      const secret = process.env.JWT_SECRET || 'super_secure_jwt_secret_for_allo_innoware_2026';
      const decoded: any = jwt.verify(res.body.token, secret);
      expect(decoded.id).toBe(4);
      expect(decoded.role).toBe('EMPLOYEE');
    });
  });

  describe('RBAC Middleware', () => {
    const secret = process.env.JWT_SECRET || 'super_secure_jwt_secret_for_allo_innoware_2026';

    test('blocks unauthenticated requests with 401 UNAUTHORIZED', async () => {
      const res = await request(app).get('/api/protected/any');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('blocks invalid token with 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .get('/api/protected/any')
        .set('Authorization', 'Bearer invalid.token.value');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('allows valid token to access protected route', async () => {
      const token = jwt.sign(
        { id: 4, name: 'Alex', email: 'alex@alloinnoware.com', role: 'EMPLOYEE', manager_id: 2 },
        secret
      );

      const res = await request(app)
        .get('/api/protected/any')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('authenticated');
    });

    test('denies EMPLOYEE access to MANAGER route with 403 FORBIDDEN', async () => {
      const token = jwt.sign(
        { id: 4, name: 'Alex', email: 'alex@alloinnoware.com', role: 'EMPLOYEE', manager_id: 2 },
        secret
      );

      const res = await request(app)
        .get('/api/protected/manager')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('allows MANAGER to access MANAGER route', async () => {
      const token = jwt.sign(
        { id: 2, name: 'Sarah Manager', email: 'manager@alloinnoware.com', role: 'MANAGER', manager_id: null },
        secret
      );

      const res = await request(app)
        .get('/api/protected/manager')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('manager access granted');
    });
  });
});
