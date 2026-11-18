import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Pool, PoolConnection } from 'mysql2/promise';
import { createEmployeeRouter } from '../../src/routes/employeeRoutes';
import { errorHandler } from '../../src/middleware/errorHandler';

describe('Employee APIs Unit Tests (docs/PRODUCT.md Task B / Step 3)', () => {
  let app: express.Application;
  let mockPool: jest.Mocked<Pool>;
  let mockConn: jest.Mocked<PoolConnection>;
  const secret = process.env.JWT_SECRET || 'super_secure_jwt_secret_for_allo_innoware_2026';

  beforeEach(() => {
    mockConn = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn()
    } as unknown as jest.Mocked<PoolConnection>;

    mockPool = {
      query: jest.fn(),
      getConnection: jest.fn().mockResolvedValue(mockConn)
    } as unknown as jest.Mocked<Pool>;

    app = express();
    app.use(express.json());
    app.use('/api', createEmployeeRouter(mockPool));
    app.use(errorHandler);
  });

  const employeeToken = jwt.sign(
    { id: 4, name: 'Alex Employee', email: 'alex@alloinnoware.com', role: 'EMPLOYEE', manager_id: 2 },
    secret
  );

  describe('GET /api/me/pending', () => {
    test('returns caller OPEN cycles with computed Overdue/Open status', async () => {
      const pastDue = new Date(Date.now() - 3600000); // 1h ago
      const futureDue = new Date(Date.now() + 3600000); // 1h in future

      (mockPool.query as jest.Mock).mockResolvedValueOnce([
        [
          { cycleId: 10, task: 'Daily Report', dueAt: pastDue, status: 'OPEN', proofType: 'ACK' },
          { cycleId: 11, task: 'Weekly Triage', dueAt: futureDue, status: 'OPEN', proofType: 'TICKET' }
        ]
      ]);

      const res = await request(app)
        .get('/api/me/pending')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].cycleId).toBe(10);
      expect(res.body[0].status).toBe('Overdue');
      expect(res.body[1].cycleId).toBe(11);
      expect(res.body[1].status).toBe('Open');
    });
  });

  describe('POST /api/cycles/:id/complete', () => {
    test('rejects completing cycle assigned to a different user with 403 FORBIDDEN', async () => {
      (mockConn.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 10, assignee_id: 99, status: 'OPEN', proof_type: 'ACK', frequency_days: 1, due_time: '18:00:00' }]
      ]);

      const res = await request(app)
        .post('/api/cycles/10/complete')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    test('rejects completion with 409 Conflict if already completed', async () => {
      (mockConn.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 10, assignee_id: 4, status: 'COMPLETED', proof_type: 'ACK', frequency_days: 1, due_time: '18:00:00' }]
      ]);

      const res = await request(app)
        .post('/api/cycles/10/complete')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_COMPLETED');
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    test('rejects TICKET task completion if ticketId is missing with 400 validation error', async () => {
      (mockConn.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 10, assignee_id: 4, status: 'OPEN', proof_type: 'TICKET', frequency_days: 7, due_time: '17:00:00' }]
      ]);

      const res = await request(app)
        .post('/api/cycles/10/complete')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ note: 'Fixed without ticket' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('ticketId is required');
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    test('successfully completes ACK task with one tap and returns completion + nextCycle', async () => {
      const cycleRow = {
        id: 10,
        task_id: 1,
        cycle_no: 1,
        due_date: '2026-11-01',
        due_at: new Date('2026-11-01T18:00:00Z'),
        status: 'OPEN',
        assignee_id: 4,
        proof_type: 'ACK',
        frequency_days: 1,
        due_time: '18:00:00'
      };

      // 1. fetch cycle
      (mockConn.query as jest.Mock).mockResolvedValueOnce([[cycleRow]]);
      // 2. insert completion
      (mockConn.query as jest.Mock).mockResolvedValueOnce([{ insertId: 501 }]);
      // 3. update cycle to COMPLETED
      (mockConn.query as jest.Mock).mockResolvedValueOnce([{ affectedRows: 1 }]);
      // 4. cycleService.createNextCycle: query existing open cycles -> none
      (mockConn.query as jest.Mock).mockResolvedValueOnce([[]]);
      // 5. cycleService.createNextCycle: insert next cycle
      (mockConn.query as jest.Mock).mockResolvedValueOnce([{ insertId: 11 }]);
      // 6. insert audit_log
      (mockConn.query as jest.Mock).mockResolvedValueOnce([{ insertId: 901 }]);

      const res = await request(app)
        .post('/api/cycles/10/complete')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ note: 'WhatsApp update posted' });

      expect(res.status).toBe(200);
      expect(res.body.completion).toBeDefined();
      expect(res.body.completion.cycleId).toBe(10);
      expect(res.body.completion.completedBy).toBe(4);
      expect(res.body.nextCycle).toBeDefined();
      expect(res.body.nextCycle.id).toBe(11);
      expect(res.body.nextCycle.cycle_no).toBe(2);
      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });
  });
});
