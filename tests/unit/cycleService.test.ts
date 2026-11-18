import { calculateNextDueDate, buildDueAt, CycleService } from '../../src/services/cycleService';
import { Pool } from 'mysql2/promise';

describe('cycleService - Anchored Recurrence & Roll-forward (docs/PRODUCT.md Section 4 & Task A2)', () => {
  describe('calculateNextDueDate & Timezone behavior (Asia/Kolkata)', () => {
    test('anchors due date for 1-day daily task completed on time', () => {
      const prevDue = new Date('2026-11-01T18:00:00Z');
      const completedAt = new Date('2026-11-01T17:30:00Z');
      const nextDue = calculateNextDueDate(prevDue, 1, completedAt);

      expect(nextDue.toISOString()).toBe(new Date('2026-11-02T18:00:00Z').toISOString());
    });

    test('anchors due date for 7-day weekly task completed late without drift', () => {
      const prevDue = new Date('2026-11-01T17:00:00Z');
      const completedAt = new Date('2026-11-04T12:00:00Z');
      const nextDue = calculateNextDueDate(prevDue, 7, completedAt);

      expect(nextDue.toISOString()).toBe(new Date('2026-11-08T17:00:00Z').toISOString());
    });

    test('Task A2: month boundary (30-day from 20 Nov -> 20 Dec)', () => {
      const prevDue = new Date('2026-11-20T10:00:00+05:30');
      const completedAt = new Date('2026-11-20T09:00:00+05:30');
      const nextDue = calculateNextDueDate(prevDue, 30, completedAt);

      // November has 30 days, so 20 Nov + 30 days = 20 Dec
      expect(nextDue.getDate()).toBe(20);
      expect(nextDue.getMonth()).toBe(11); // December (0-indexed: 11)
    });

    test('Task A2: 15-day from 25 Feb (handles leap/non-leap boundaries cleanly)', () => {
      // 2026 is non-leap (Feb has 28 days)
      // 25 Feb + 15 days = 28 - 25 = 3 days left in Feb, then 12 days into March = 12 March
      const prevDue = new Date('2026-02-25T15:00:00+05:30');
      const completedAt = new Date('2026-02-25T14:00:00+05:30');
      const nextDue = calculateNextDueDate(prevDue, 15, completedAt);

      expect(nextDue.getDate()).toBe(12);
      expect(nextDue.getMonth()).toBe(2); // March (0-indexed: 2)
    });

    test('Task A2: task completed late (after due time) pins roll-forward (next due anchored and after completion)', () => {
      // Due at 17:00:00, completed 3 hours late at 20:00:00 on the same due day
      const prevDue = new Date('2026-11-01T17:00:00+05:30');
      const completedAt = new Date('2026-11-01T20:00:00+05:30');
      const nextDue = calculateNextDueDate(prevDue, 7, completedAt);

      // Must be anchored to prevDue + 7 days = 2026-11-08T17:00:00+05:30
      expect(nextDue.getTime()).toBeGreaterThan(completedAt.getTime());
      expect(nextDue.getDate()).toBe(8);
      expect(nextDue.getHours()).toBe(17);
    });

    test('rolls forward in whole periods if completion is past next due (missed by 1+ cycle)', () => {
      const prevDue = new Date('2026-11-01T17:00:00Z');
      const completedAt = new Date('2026-11-19T10:00:00Z');
      const nextDue = calculateNextDueDate(prevDue, 7, completedAt);

      expect(nextDue.toISOString()).toBe(new Date('2026-11-22T17:00:00Z').toISOString());
      
      const diffDays = Math.round((nextDue.getTime() - prevDue.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays % 7).toBe(0);
      expect(diffDays).toBe(21);
    });
  });

  describe('buildDueAt helper', () => {
    test('correctly constructs YYYY-MM-DD and dueAt datetime preserving time string', () => {
      const d = new Date('2026-11-05T00:00:00Z');
      const res = buildDueAt(d, '14:30:00');

      expect(res.dueDateStr).toBe('2026-11-05');
      expect(res.dueAt.getHours()).toBe(14);
      expect(res.dueAt.getMinutes()).toBe(30);
    });

    test('handles default fallbacks for partial time strings', () => {
      const d = new Date('2026-11-05T00:00:00Z');
      const res = buildDueAt(d, '');
      expect(res.dueDateStr).toBe('2026-11-05');
      expect(res.dueAt.getHours()).toBe(0);
    });
  });

  describe('CycleService DB constraints & only one OPEN cycle', () => {
    let mockPool: jest.Mocked<Pool>;
    let service: CycleService;

    beforeEach(() => {
      mockPool = {
        query: jest.fn()
      } as unknown as jest.Mocked<Pool>;
      service = new CycleService(mockPool);
    });

    test('ensureInitialCycle returns existing OPEN cycle if present (enforces single OPEN cycle)', async () => {
      const existingOpenCycle = {
        id: 10,
        task_id: 1,
        cycle_no: 1,
        due_date: '2026-11-01',
        due_at: new Date('2026-11-01T18:00:00Z'),
        status: 'OPEN'
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce([[existingOpenCycle]]);

      const cycle = await service.ensureInitialCycle(1);
      expect(cycle).toEqual(existingOpenCycle);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    test('ensureInitialCycle returns null if task not found or inactive', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);

      const cycle = await service.ensureInitialCycle(999);
      expect(cycle).toBeNull();
    });

    test('ensureInitialCycle creates new cycle if no OPEN cycle exists', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 1, name: 'Daily Report', frequency_days: 1, due_time: '18:00:00', start_date: '2026-11-01', active: 1 }]
      ]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[{ max_no: 0 }]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 101 }]);

      const cycle = await service.ensureInitialCycle(1);

      expect(cycle).toBeDefined();
      expect(cycle?.id).toBe(101);
      expect(cycle?.cycle_no).toBe(1);
      expect(cycle?.status).toBe('OPEN');
    });

    test('ensureInitialCycle recovers on ER_DUP_ENTRY', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 1, name: 'Daily Report', frequency_days: 1, due_time: '18:00:00', start_date: '2026-11-01', active: 1 }]
      ]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      const dupError: any = new Error('Duplicate');
      dupError.code = 'ER_DUP_ENTRY';
      (mockPool.query as jest.Mock).mockRejectedValueOnce(dupError);
      
      const existing = { id: 102, task_id: 1, cycle_no: 1, due_date: '2026-11-01', due_at: new Date(), status: 'OPEN' };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[existing]]);

      const cycle = await service.ensureInitialCycle(1);
      expect(cycle).toEqual(existing);
    });

    test('ensureInitialCycle rethrows non-duplicate error', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([
        [{ id: 1, name: 'Daily Report', frequency_days: 1, due_time: '18:00:00', start_date: '2026-11-01', active: 1 }]
      ]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      const connError = new Error('Connection lost');
      (mockPool.query as jest.Mock).mockRejectedValueOnce(connError);

      await expect(service.ensureInitialCycle(1)).rejects.toThrow('Connection lost');
    });

    test('createNextCycle returns existing OPEN cycle if already present (single OPEN cycle)', async () => {
      const openCycle = { id: 202, task_id: 2, cycle_no: 2, status: 'OPEN' };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[openCycle]]);

      const result = await service.createNextCycle(
        { id: 201, task_id: 2, cycle_no: 1, due_date: '2026-11-01', due_at: new Date('2026-11-01T17:00:00Z') },
        { frequency_days: 7, due_time: '17:00:00' },
        new Date('2026-11-01T16:00:00Z')
      );

      expect(result).toEqual(openCycle);
    });

    test('createNextCycle creates anchored next cycle if none open', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 303 }]);

      const result = await service.createNextCycle(
        { id: 201, task_id: 2, cycle_no: 1, due_date: '2026-11-01', due_at: new Date('2026-11-01T17:00:00Z') },
        { frequency_days: 7, due_time: '17:00:00' },
        new Date('2026-11-01T16:00:00Z')
      );

      expect(result).toBeDefined();
      expect(result?.id).toBe(303);
    });

    test('createNextCycle gracefully handles duplicate entry race conditions', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      const dupError: any = new Error('Duplicate entry');
      dupError.code = 'ER_DUP_ENTRY';
      (mockPool.query as jest.Mock).mockRejectedValueOnce(dupError);
      
      const existingCycle = { id: 404, task_id: 2, cycle_no: 2, status: 'OPEN' };
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[existingCycle]]);

      const result = await service.createNextCycle(
        { id: 201, task_id: 2, cycle_no: 1, due_date: '2026-11-01', due_at: new Date('2026-11-01T17:00:00Z') },
        { frequency_days: 7, due_time: '17:00:00' },
        new Date('2026-11-01T16:00:00Z')
      );

      expect(result).toEqual(existingCycle);
    });

    test('createNextCycle rethrows non-duplicate error', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
      const connError = new Error('DB Error');
      (mockPool.query as jest.Mock).mockRejectedValueOnce(connError);

      await expect(
        service.createNextCycle(
          { id: 201, task_id: 2, cycle_no: 1, due_date: '2026-11-01', due_at: new Date('2026-11-01T17:00:00Z') },
          { frequency_days: 7, due_time: '17:00:00' },
          new Date('2026-11-01T16:00:00Z')
        )
      ).rejects.toThrow('DB Error');
    });
  });
});
