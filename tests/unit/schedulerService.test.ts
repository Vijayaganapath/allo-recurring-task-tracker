import { SchedulerService } from '../../src/services/schedulerService';
import { NotificationService } from '../../src/services/notificationService';
import { Pool } from 'mysql2/promise';

// Helper to build a mock pool with pre-queued responses
function buildMockPool(responses: Array<Promise<any>>): jest.Mocked<Pool> {
  let idx = 0;
  const pool = {
    query: jest.fn().mockImplementation(() => {
      if (idx < responses.length) return responses[idx++];
      return Promise.resolve([[]]);
    })
  } as unknown as jest.Mocked<Pool>;
  return pool;
}

// ─── NotificationService Unit Tests ───────────────────────────────────────────

describe('NotificationService', () => {
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = { query: jest.fn() } as unknown as jest.Mocked<Pool>;
  });

  test('sends email successfully and logs SENT', async () => {
    const notif = new NotificationService(mockPool);
    (notif as any).transporter = { sendMail: jest.fn().mockResolvedValue({}) };
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 1 }]);

    const res = await notif.sendEmail({ to: 'ok@test.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(res).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_log'),
      ['ok@test.com', 'Hi', 'SENT']
    );
  });

  test('returns false and logs FAILED on sendMail error', async () => {
    const notif = new NotificationService(mockPool);
    (notif as any).transporter = { sendMail: jest.fn().mockRejectedValue(new Error('SMTP timeout')) };
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 2 }]);

    const res = await notif.sendEmail({ to: 'fail@test.com', subject: 'Test', html: '<p>Hi</p>' });

    expect(res).toBe(false);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_log'),
      ['fail@test.com', 'Test', 'FAILED']
    );
  });

  test('gracefully handles DB write failure in finally block', async () => {
    const notif = new NotificationService(mockPool);
    (notif as any).transporter = { sendMail: jest.fn().mockResolvedValue({}) };
    (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('DB write failed'));

    const res = await notif.sendEmail({ to: 'ok@test.com', subject: 'X', html: '<p>X</p>' });
    expect(res).toBe(true);
  });

  test('uses auth config when SMTP_USER and SMTP_PASS are non-empty', () => {
    process.env.SMTP_USER = 'user@smtp.com';
    process.env.SMTP_PASS = 'secret123';
    const notif = new NotificationService(mockPool);
    // transporter should exist (created with auth block)
    expect((notif as any).transporter).toBeDefined();
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  test('skips auth config when SMTP_USER is empty string', () => {
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    const notif = new NotificationService(mockPool);
    expect((notif as any).transporter).toBeDefined();
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  test('covers NotificationService custom and default SMTP host, port, and from', async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.EMAIL_FROM;
    const notifDefault = new NotificationService(mockPool);
    (notifDefault as any).transporter = { sendMail: jest.fn().mockResolvedValue({}) };
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 9 }]);
    await notifDefault.sendEmail({ to: 'def@test.com', subject: 'Def', html: '<p>Def</p>' });

    process.env.SMTP_HOST = 'custom-smtp';
    process.env.SMTP_PORT = '2525';
    process.env.EMAIL_FROM = 'custom-sender@test.com';
    const notifCustom = new NotificationService(mockPool);
    (notifCustom as any).transporter = { sendMail: jest.fn().mockResolvedValue({}) };
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 10 }]);
    await notifCustom.sendEmail({ to: 'cust@test.com', subject: 'Cust', html: '<p>Cust</p>' });

    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.EMAIL_FROM;
  });
});

// ─── SchedulerService Unit Tests ───────────────────────────────────────────────

describe('SchedulerService', () => {
  let sendEmailMock: jest.Mock;

  function buildScheduler(poolResponses: Array<Promise<any>>): SchedulerService {
    const pool = buildMockPool(poolResponses);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };
    return scheduler;
  }

  // ── L0 paths ──────────────────────────────────────────────────────────────

  test('L0: sends reminder email and marks SENT', async () => {
    const scheduler = buildScheduler([
      Promise.resolve([[]]), // active tasks
      Promise.resolve([[{ cycle_id: 1, due_at: new Date(), task_name: 'Weekly Jira', employee_email: 'emp@test.com', employee_name: 'Alex' }]]), // L0
      Promise.resolve([{ insertId: 10 }]), // insert L0 event
      Promise.resolve([{ affectedRows: 1 }]), // update SENT
      Promise.resolve([[]]), // L1
      Promise.resolve([[]]), // L2
      Promise.resolve([[]]), // L3
      Promise.resolve([[]])  // leadership
    ]);

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'emp@test.com' }));
  });

  test('L0: marks FAILED when sendEmail returns false', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 2, due_at: new Date(), task_name: 'Task', employee_email: 'emp@test.com', employee_name: 'Alex' }]]),
      Promise.resolve([{ insertId: 11 }]),
      Promise.resolve([{ affectedRows: 1 }]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(false);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
  });

  test('L0: skips item when INSERT throws (ER_DUP_ENTRY), processes next item', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[
        { cycle_id: 3, due_at: new Date(), task_name: 'Task A', employee_email: 'a@test.com', employee_name: 'Alice' },
        { cycle_id: 4, due_at: new Date(), task_name: 'Task B', employee_email: 'b@test.com', employee_name: 'Bob' }
      ]]),
      Promise.reject(Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' })), // cycle 3 fails
      Promise.resolve([{ insertId: 20 }]),   // cycle 4 ok
      Promise.resolve([{ affectedRows: 1 }]), // update cycle 4 SENT
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(1); // only Bob
  });

  // ── L1 paths ──────────────────────────────────────────────────────────────

  test('L1: sends per-manager digest email and marks items SENT', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]), // active tasks
      Promise.resolve([[]]), // L0 candidates
      Promise.resolve([[   // L1: 2 items for same manager
        { cycle_id: 10, due_at: new Date(), task_name: 'Task A', employee_name: 'Alice', manager_id: 2, manager_email: 'mgr@test.com', manager_name: 'Sarah' },
        { cycle_id: 11, due_at: new Date(), task_name: 'Task B', employee_name: 'Bob',   manager_id: 2, manager_email: 'mgr@test.com', manager_name: 'Sarah' }
      ]]),
      Promise.resolve([{ insertId: 100 }]), // insert L1 event cycle 10
      Promise.resolve([{ insertId: 101 }]), // insert ack cycle 10
      Promise.resolve([{ insertId: 102 }]), // insert L1 event cycle 11
      Promise.resolve([{ insertId: 103 }]), // insert ack cycle 11
      // sendEmail (digest) → true  (mocked outside pool)
      Promise.resolve([{ affectedRows: 1 }]), // update cycle 10 SENT
      Promise.resolve([{ affectedRows: 1 }]), // update cycle 11 SENT
      Promise.resolve([[]]), // L2
      Promise.resolve([[]]), // L3
      Promise.resolve([[]])  // leadership
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(1); // 1 digest
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'mgr@test.com' }));
  });

  test('L1: marks items FAILED when digest email fails', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[
        { cycle_id: 12, due_at: new Date(), task_name: 'Task C', employee_name: 'Charlie', manager_id: 3, manager_email: 'mgr2@test.com', manager_name: 'Dana' }
      ]]),
      Promise.resolve([{ insertId: 200 }]),
      Promise.resolve([{ insertId: 201 }]),
      // sendEmail → false (mocked outside pool)
      Promise.resolve([{ affectedRows: 1 }]), // update FAILED
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(false);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
  });

  test('L1: skips manager when all item inserts throw (itemsToEmail empty)', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[
        { cycle_id: 20, due_at: new Date(), task_name: 'Task D', employee_name: 'Dave', manager_id: 4, manager_email: 'mgr3@test.com', manager_name: 'Eve' }
      ]]),
      Promise.reject(Object.assign(new Error('Dup'), { code: 'ER_DUP_ENTRY' })), // insert throws → continue
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  test('L1: two different managers get separate digests', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[
        { cycle_id: 30, due_at: new Date(), task_name: 'Task X', employee_name: 'X', manager_id: 5, manager_email: 'mgr5@test.com', manager_name: 'Frank' },
        { cycle_id: 31, due_at: new Date(), task_name: 'Task Y', employee_name: 'Y', manager_id: 6, manager_email: 'mgr6@test.com', manager_name: 'Grace' }
      ]]),
      Promise.resolve([{ insertId: 300 }]),
      Promise.resolve([{ insertId: 301 }]),
      // digest for Frank → true
      Promise.resolve([{ affectedRows: 1 }]),
      Promise.resolve([{ insertId: 302 }]),
      Promise.resolve([{ insertId: 303 }]),
      // digest for Grace → true
      Promise.resolve([{ affectedRows: 1 }]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(2);
  });

  // ── L2 paths ──────────────────────────────────────────────────────────────

  test('L2: sends re-check email and marks SENT', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 40, due_at: new Date(), task_name: 'Task L2', employee_name: 'Hank', manager_email: 'mgr@test.com', manager_name: 'Iris' }]]),
      Promise.resolve([{ insertId: 400 }]),
      Promise.resolve([{ affectedRows: 1 }]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(1);
  });

  test('L2: marks FAILED when email fails', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 41, due_at: new Date(), task_name: 'Task L2F', employee_name: 'Jake', manager_email: 'mgr2@test.com', manager_name: 'Kim' }]]),
      Promise.resolve([{ insertId: 410 }]),
      Promise.resolve([{ affectedRows: 1 }]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(false);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
  });

  test('L2: skips row when INSERT throws', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 42, due_at: new Date(), task_name: 'Task L2D', employee_name: 'Leo', manager_email: 'mgr3@test.com', manager_name: 'Mia' }]]),
      Promise.reject(Object.assign(new Error('Dup'), { code: 'ER_DUP_ENTRY' })),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── L3 paths ──────────────────────────────────────────────────────────────

  test('L3: sends escalation email to leadership and marks SENT', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 50, due_at: new Date(), task_name: 'Task L3', employee_name: 'Ned' }]]),
      Promise.resolve([[{ id: 7, email: 'lead@test.com', name: 'Owen' }]]),
      Promise.resolve([{ insertId: 500 }]),
      Promise.resolve([{ insertId: 501 }]),
      // sendEmail → true
      Promise.resolve([{ affectedRows: 1 }]),
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'lead@test.com' }));
  });

  test('L3: marks FAILED when email to leadership fails', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 51, due_at: new Date(), task_name: 'Task L3F', employee_name: 'Pat' }]]),
      Promise.resolve([[{ id: 8, email: 'lead2@test.com', name: 'Quinn' }]]),
      Promise.resolve([{ insertId: 510 }]),
      Promise.resolve([{ insertId: 511 }]),
      // sendEmail → false
      Promise.resolve([{ affectedRows: 1 }]),
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(false);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
  });

  test('L3: skips leader when INSERT throws', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 52, due_at: new Date(), task_name: 'Task L3D', employee_name: 'Rosa' }]]),
      Promise.resolve([[{ id: 9, email: 'lead3@test.com', name: 'Sam' }]]),
      Promise.reject(Object.assign(new Error('Dup'), { code: 'ER_DUP_ENTRY' })),
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  test('L3: no emails when leadership list is empty', async () => {
    const pool = buildMockPool([
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[{ cycle_id: 53, due_at: new Date(), task_name: 'Task L3NL', employee_name: 'Tina' }]]),
      Promise.resolve([[]]), // no leadership users
    ]);
    const scheduler = new SchedulerService(pool);
    sendEmailMock = jest.fn().mockResolvedValue(true);
    (scheduler as any).notificationService = { sendEmail: sendEmailMock };

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── Error-handling paths (outer try/catch coverage) ─────────────────────────

  test('handles initial cycle creation error gracefully', async () => {
    const pool = {
      query: jest.fn()
        .mockRejectedValueOnce(new Error('DB down')) // throws on SELECT active tasks
        .mockResolvedValue([[]])
    } as unknown as jest.Mocked<Pool>;

    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toContain('Initial cycle creation error');
  });

  test('handles L0 outer query error gracefully', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce([[]])  // active tasks
        .mockRejectedValueOnce(new Error('L0 query failed'))
        .mockResolvedValue([[]])
    } as unknown as jest.Mocked<Pool>;

    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.errors.some((e: string) => e.includes('L0 error'))).toBe(true);
  });

  test('handles L1 outer query error gracefully', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce([[]])  // active tasks
        .mockResolvedValueOnce([[]])  // L0 candidates
        .mockRejectedValueOnce(new Error('L1 failed'))
        .mockResolvedValue([[]])
    } as unknown as jest.Mocked<Pool>;

    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.errors.some((e: string) => e.includes('L1 error'))).toBe(true);
  });

  test('handles L2 outer query error gracefully', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce([[]])  // active tasks
        .mockResolvedValueOnce([[]])  // L0
        .mockResolvedValueOnce([[]])  // L1
        .mockRejectedValueOnce(new Error('L2 failed'))
        .mockResolvedValue([[]])
    } as unknown as jest.Mocked<Pool>;

    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.errors.some((e: string) => e.includes('L2 error'))).toBe(true);
  });

  test('handles L3 outer query error gracefully', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce([[]])  // active tasks
        .mockResolvedValueOnce([[]])  // L0
        .mockResolvedValueOnce([[]])  // L1
        .mockResolvedValueOnce([[]])  // L2 candidates
        .mockRejectedValueOnce(new Error('L3 failed'))
        .mockResolvedValue([[]])
    } as unknown as jest.Mocked<Pool>;

    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.errors.some((e: string) => e.includes('L3 error'))).toBe(true);
  });

  // ── Initial cycle creation for active task ─────────────────────────────────

  test('creates initial cycle when active task has no open cycle', async () => {
    const pool = buildMockPool([
      Promise.resolve([[{ id: 99 }]]),  // active tasks: 1 task
      Promise.resolve([[]]),             // existing open cycles: none
      // CycleService.ensureInitialCycle internals:
      Promise.resolve([[{ id: 99, start_date: '2026-11-01', due_time: '17:00:00', frequency_days: 7, name: 'Task Z', active: 1 }]]),
      Promise.resolve([[]]),             // no existing open cycle
      Promise.resolve([{ insertId: 999 }]), // INSERT cycle
      Promise.resolve([[]]),  // L0
      Promise.resolve([[]]),  // L1
      Promise.resolve([[]]),  // L2
      Promise.resolve([[]]),  // L3
      Promise.resolve([[]])   // leadership
    ]);
    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.createdCycles).toBe(1);
  });

  test('skips initial cycle creation when active task already has open cycle', async () => {
    const pool = buildMockPool([
      Promise.resolve([[{ id: 88 }]]),  // active tasks
      Promise.resolve([[{ id: 101 }]]), // existing open cycle found → skip
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.createdCycles).toBe(0);
  });

  test('does not increment createdCycles when ensureInitialCycle returns null', async () => {
    const pool = buildMockPool([
      Promise.resolve([[{ id: 77 }]]),  // active task
      Promise.resolve([[]]),             // no open cycle
      // CycleService.ensureInitialCycle returns null (e.g. task not found)
      Promise.resolve([[]]),             // SELECT task fails
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]]),
      Promise.resolve([[]])
    ]);
    const scheduler = new SchedulerService(pool);
    (scheduler as any).notificationService = { sendEmail: jest.fn().mockResolvedValue(true) };

    const res = await scheduler.runScheduler();
    expect(res.createdCycles).toBe(0);
  });

  test('covers SLA env vars fallback when undefined', async () => {
    const savedL0 = process.env.SLA_L0_REMINDER_HOURS_BEFORE;
    const savedL1 = process.env.SLA_L1_MANAGER_ALERT_HOURS_AFTER;
    const savedL2 = process.env.SLA_L2_MANAGER_RECHECK_HOURS_AFTER;
    const savedL3 = process.env.SLA_L3_LEADERSHIP_HOURS_AFTER;
    const savedUrl = process.env.APP_BASE_URL;

    delete process.env.SLA_L0_REMINDER_HOURS_BEFORE;
    delete process.env.SLA_L1_MANAGER_ALERT_HOURS_AFTER;
    delete process.env.SLA_L2_MANAGER_RECHECK_HOURS_AFTER;
    delete process.env.SLA_L3_LEADERSHIP_HOURS_AFTER;
    delete process.env.APP_BASE_URL;

    const pool = buildMockPool([
      Promise.resolve([[]]), // active
      Promise.resolve([[]]), // L0
      Promise.resolve([[]]), // L1
      Promise.resolve([[]]), // L2
      Promise.resolve([[]]), // L3
      Promise.resolve([[]])  // leaders
    ]);
    const scheduler = new SchedulerService(pool);

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);

    // Restore
    if (savedL0) process.env.SLA_L0_REMINDER_HOURS_BEFORE = savedL0;
    if (savedL1) process.env.SLA_L1_MANAGER_ALERT_HOURS_AFTER = savedL1;
    if (savedL2) process.env.SLA_L2_MANAGER_RECHECK_HOURS_AFTER = savedL2;
    if (savedL3) process.env.SLA_L3_LEADERSHIP_HOURS_AFTER = savedL3;
    if (savedUrl) process.env.APP_BASE_URL = savedUrl;
  });

  test('covers SLA env vars when explicitly defined', async () => {
    process.env.SLA_L0_REMINDER_HOURS_BEFORE = '5';
    process.env.SLA_L1_MANAGER_ALERT_HOURS_AFTER = '3';
    process.env.SLA_L2_MANAGER_RECHECK_HOURS_AFTER = '6';
    process.env.SLA_L3_LEADERSHIP_HOURS_AFTER = '48';
    process.env.APP_BASE_URL = 'http://custom-app.com';

    const pool = buildMockPool([
      Promise.resolve([[]]), // active
      Promise.resolve([[]]), // L0
      Promise.resolve([[]]), // L1
      Promise.resolve([[]]), // L2
      Promise.resolve([[]]), // L3
      Promise.resolve([[]])  // leaders
    ]);
    const scheduler = new SchedulerService(pool);

    const res = await scheduler.runScheduler();
    expect(res.emailsSent).toBe(0);
  });
});
