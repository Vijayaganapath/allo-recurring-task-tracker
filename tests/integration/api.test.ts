import request from 'supertest';
import mysql, { Pool } from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import app from '../../src/server';
import { SchedulerService } from '../../src/services/schedulerService';

describe('Integration Tests (Assignment Tests 1-8 against TEST_DB_NAME)', () => {
  let testDb: Pool;
  const testDbName = process.env.TEST_DB_NAME || 'recurring_task_tracker_test';
  const secret = process.env.JWT_SECRET || 'super_secure_jwt_secret_for_allo_innoware_2026';

  let employeeToken: string;
  let managerToken: string;
  let leadershipToken: string;
  let adminToken: string;

  beforeAll(async () => {
    testDb = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'allo_user',
      password: process.env.DB_PASSWORD || 'allo_password',
      database: testDbName,
      waitForConnections: true,
      connectionLimit: 10
    });

    // Seed test users
    await testDb.query(`DELETE FROM users`);
    await testDb.query(
      `INSERT INTO users (id, name, email, password_hash, role, manager_id, active) VALUES
       (1, 'Admin', 'admin@test.com', 'hash', 'ADMIN', NULL, 1),
       (2, 'Sarah Manager', 'manager@test.com', 'hash', 'MANAGER', NULL, 1),
       (3, 'Vikram Leadership', 'leadership@test.com', 'hash', 'LEADERSHIP', NULL, 1),
       (4, 'Alex Employee', 'alex@test.com', 'hash', 'EMPLOYEE', 2, 1)`
    );

    employeeToken = jwt.sign({ id: 4, name: 'Alex', email: 'alex@test.com', role: 'EMPLOYEE', manager_id: 2 }, secret);
    managerToken = jwt.sign({ id: 2, name: 'Sarah', email: 'manager@test.com', role: 'MANAGER', manager_id: null }, secret);
    leadershipToken = jwt.sign({ id: 3, name: 'Vikram', email: 'leadership@test.com', role: 'LEADERSHIP', manager_id: null }, secret);
    adminToken = jwt.sign({ id: 1, name: 'Admin', email: 'admin@test.com', role: 'ADMIN', manager_id: null }, secret);
  });

  afterAll(async () => {
    await testDb.end();
  });

  beforeEach(async () => {
    await testDb.query(`DELETE FROM audit_log`);
    await testDb.query(`DELETE FROM notification_log`);
    await testDb.query(`DELETE FROM acknowledgements`);
    await testDb.query(`DELETE FROM escalation_events`);
    await testDb.query(`DELETE FROM completions`);
    await testDb.query(`DELETE FROM task_cycles`);
    await testDb.query(`DELETE FROM recurring_tasks`);
  });

  // --------------------------------------------------------------------------
  // Assignment Test 1: Recurring cycle (7/15/30-day completion creates next cycle anchored)
  // --------------------------------------------------------------------------
  test('Test 1: Completing a 7-day recurring cycle creates next cycle with anchored due date', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (101, 'Weekly Jira Triage', 4, 7, 'TICKET', '17:00:00', '2026-11-01', 1)`
    );

    // Initial cycle anchored on future date (truncated to seconds for MySQL DATETIME precision)
    const currentDue = new Date(Math.floor((Date.now() + 2 * 3600 * 1000) / 1000) * 1000);
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (201, 101, 1, '2026-11-16', ?, 'OPEN')`,
      [currentDue]
    );

    const res = await request(app)
      .post('/api/cycles/201/complete')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ticketId: 'JIRA-1001', note: 'Triaged weekly tickets' });

    expect(res.status).toBe(200);
    expect(res.body.completion.ticketId).toBe('JIRA-1001');
    expect(res.body.nextCycle).toBeDefined();
    expect(res.body.nextCycle.cycle_no).toBe(2);

    // Verify anchored due date in DB is within 1s tolerance (MySQL seconds precision)
    const [nextRows]: any = await testDb.query(`SELECT * FROM task_cycles WHERE task_id = 101 AND cycle_no = 2`);
    expect(nextRows).toHaveLength(1);
    expect(nextRows[0].status).toBe('OPEN');
    const expectedDue = new Date(currentDue.getTime() + 7 * 24 * 3600 * 1000);
    expect(Math.abs(new Date(nextRows[0].due_at).getTime() - expectedDue.getTime())).toBeLessThanOrEqual(1000);
  });

  // --------------------------------------------------------------------------
  // Assignment Test 2: Single-point completion from /me/pending only
  // --------------------------------------------------------------------------
  test('Test 2: Employee views /me/pending and completes task inline with ticket ID', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (102, 'Sprint Review Bug List', 4, 15, 'TICKET', '12:00:00', '2026-11-01', 1)`
    );
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (202, 102, 1, '2026-11-01', '2026-11-01 12:00:00', 'OPEN')`
    );

    const getRes = await request(app)
      .get('/api/me/pending')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(getRes.status).toBe(200);
    const item = getRes.body.find((c: any) => c.cycleId === 202);
    expect(item).toBeDefined();
    expect(item.proofType).toBe('TICKET');

    const completeRes = await request(app)
      .post('/api/cycles/202/complete')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ticketId: 'BUG-442' });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.completion.ticketId).toBe('BUG-442');
  });

  // --------------------------------------------------------------------------
  // Assignment Test 3: Daily task (no ticket) completes with 1-tap Done
  // --------------------------------------------------------------------------
  test('Test 3: Daily task with proof_type ACK completes with 1-tap Done, records user and timestamp', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (103, 'Daily Standup Summary', 4, 1, 'ACK', '18:00:00', '2026-11-01', 1)`
    );
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (203, 103, 1, '2026-11-01', '2026-11-01 18:00:00', 'OPEN')`
    );

    const res = await request(app)
      .post('/api/cycles/203/complete')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ note: 'Posted standup summary in group' });

    expect(res.status).toBe(200);
    expect(res.body.completion.completedBy).toBe(4);
    expect(res.body.completion.completedAt).toBeDefined();

    const [compRows]: any = await testDb.query(`SELECT * FROM completions WHERE cycle_id = 203`);
    expect(compRows).toHaveLength(1);
    expect(compRows[0].ticket_id).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Assignment Test 4: Same-day alert (L1 email sent within 1h of due time)
  // --------------------------------------------------------------------------
  test('Test 4: Seed an overdue task, scheduler triggers L1 email and acknowledgement row', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (104, 'Monthly Security Patch', 4, 30, 'ACK', '10:00:00', '2026-10-01', 1)`
    );
    const overdueTime = new Date(Date.now() - 2 * 3600 * 1000);
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (204, 104, 1, '2026-10-01', ?, 'OPEN')`,
      [overdueTime]
    );

    const scheduler = new SchedulerService(testDb);
    const summary = await scheduler.runScheduler();

    expect(summary.emailsSent).toBeGreaterThanOrEqual(1);

    const [events]: any = await testDb.query(
      `SELECT * FROM escalation_events WHERE cycle_id = 204 AND level = 1`
    );
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('SENT');

    const [acks]: any = await testDb.query(
      `SELECT * FROM acknowledgements WHERE cycle_id = 204 AND manager_id = 2 AND level = 1`
    );
    expect(acks).toHaveLength(1);
    expect(acks[0].token).toHaveLength(64);
    expect(acks[0].acknowledged_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Assignment Test 5: Manager acknowledgement via tokenized link
  // --------------------------------------------------------------------------
  test('Test 5: Public tokenized link acknowledges cycle and records timestamp', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (105, 'Compliance Audit', 4, 7, 'ACK', '12:00:00', '2026-11-01', 1)`
    );
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (205, 105, 1, '2026-11-01', '2026-11-01 12:00:00', 'OPEN')`
    );

    const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await testDb.query(
      `INSERT INTO acknowledgements (cycle_id, manager_id, level, token, acknowledged_at, expires_at)
       VALUES (205, 2, 1, ?, NULL, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [token]
    );

    const res = await request(app).get(`/api/ack/${token}`);
    expect(res.status).toBe(302);

    const [ackRows]: any = await testDb.query(`SELECT * FROM acknowledgements WHERE token = ?`, [token]);
    expect(ackRows[0].acknowledged_at).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Assignment Tests 6 & 7: Leadership escalation (L3 triggered after SLA)
  // --------------------------------------------------------------------------
  test('Tests 6 & 7: L3 Leadership escalation fires after task overdue >24h', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (106, 'Critical Database Migration', 4, 30, 'ACK', '10:00:00', '2026-10-01', 1)`
    );
    const overdue26h = new Date(Date.now() - 26 * 3600 * 1000);
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (206, 106, 1, '2026-10-01', ?, 'OPEN')`,
      [overdue26h]
    );

    const scheduler = new SchedulerService(testDb);
    await scheduler.runScheduler();

    const [l3Events]: any = await testDb.query(
      `SELECT * FROM escalation_events WHERE cycle_id = 206 AND level = 3`
    );
    expect(l3Events.length).toBeGreaterThanOrEqual(1);
    expect(l3Events[0].status).toBe('SENT');
  });

  // --------------------------------------------------------------------------
  // Assignment Test 8: No duplicates / Idempotency under repeated scheduler runs
  // --------------------------------------------------------------------------
  test('Test 8: Running scheduler 3 times creates NO duplicate cycles, completions, escalation events, or duplicate emails', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (108, 'Weekly Security Review', 4, 7, 'ACK', '15:00:00', '2026-11-01', 1)`
    );

    const scheduler = new SchedulerService(testDb);

    // Run 1: Initial cycle creation + L1 alert
    const run1 = await scheduler.runScheduler();
    expect(run1.createdCycles).toBe(1);

    // Make the cycle overdue to trigger L1
    await testDb.query(`UPDATE task_cycles SET due_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE task_id = 108`);

    // Run 2: Processes L1 escalation
    await scheduler.runScheduler();

    // Run 3: Idempotent re-run
    await scheduler.runScheduler();

    // Run 4: Idempotent re-run
    await scheduler.runScheduler();

    // Assert: Only ONE open cycle exists for task 108
    const [cycles]: any = await testDb.query(`SELECT * FROM task_cycles WHERE task_id = 108`);
    expect(cycles).toHaveLength(1);

    // Assert: Only ONE escalation_event row exists for level 1
    const [l1Events]: any = await testDb.query(
      `SELECT * FROM escalation_events WHERE cycle_id = ? AND level = 1`,
      [cycles[0].id]
    );
    expect(l1Events).toHaveLength(1);

    // Assert: Only ONE acknowledgement record exists
    const [ackRecords]: any = await testDb.query(
      `SELECT * FROM acknowledgements WHERE cycle_id = ? AND level = 1`,
      [cycles[0].id]
    );
    expect(ackRecords).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Step 5 APIs: Manager Overview & In-App Acknowledge Button
  // --------------------------------------------------------------------------
  test('Step 5: Manager overview and in-app acknowledge button', async () => {
    // Seed task and overdue cycle
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (109, 'Quarterly Tax Review', 4, 30, 'ACK', '14:00:00', '2026-11-01', 1)`
    );
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (209, 109, 1, '2026-11-01', DATE_SUB(NOW(), INTERVAL 3 HOUR), 'OPEN')`
    );

    // 1. Manager checks overview
    const overviewRes = await request(app)
      .get('/api/manager/overview')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(overviewRes.status).toBe(200);
    const alexGroup = overviewRes.body.find((g: any) => g.employee.id === 4);
    expect(alexGroup).toBeDefined();
    expect(alexGroup.overdue).toBeGreaterThanOrEqual(1);
    const cycle209 = alexGroup.cycles.find((c: any) => c.cycleId === 209);
    expect(cycle209).toBeDefined();
    expect(cycle209.status).toBe('Overdue');

    // 2. Manager clicks in-app Acknowledge button
    const ackRes = await request(app)
      .post('/api/cycles/209/acknowledge')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledgedAt).toBeDefined();

    // 3. Manager re-checks overview: status is now 'Acknowledged-Still Pending'
    const updatedOverview = await request(app)
      .get('/api/manager/overview')
      .set('Authorization', `Bearer ${managerToken}`);

    const updatedCycle209 = updatedOverview.body
      .find((g: any) => g.employee.id === 4)
      .cycles.find((c: any) => c.cycleId === 209);
    expect(updatedCycle209.status).toBe('Acknowledged-Still Pending');
    expect(updatedCycle209.acknowledgedAt).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Step 5 APIs: Leadership Escalation Board
  // --------------------------------------------------------------------------
  test('Step 5: Leadership escalation board lists escalated cycles', async () => {
    await testDb.query(
      `INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
       VALUES (110, 'Major Security Audit', 4, 30, 'TICKET', '11:00:00', '2026-10-01', 1)`
    );
    await testDb.query(
      `INSERT INTO task_cycles (id, task_id, cycle_no, due_date, due_at, status)
       VALUES (210, 110, 1, '2026-10-01', DATE_SUB(NOW(), INTERVAL 30 HOUR), 'OPEN')`
    );
    await testDb.query(
      `INSERT INTO escalation_events (cycle_id, level, sent_to, status, sent_at)
       VALUES (210, 3, 'leadership@test.com', 'SENT', NOW())`
    );

    const res = await request(app)
      .get('/api/leadership/escalations')
      .set('Authorization', `Bearer ${leadershipToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const item = res.body.find((e: any) => e.cycleId === 210);
    expect(item).toBeDefined();
    expect(item.taskName).toBe('Major Security Audit');
    expect(item.escalationLevel).toBe(3);
    expect(item.employee.email).toBe('alex@test.com');
    expect(item.manager.email).toBe('manager@test.com');
  });

  // --------------------------------------------------------------------------
  // Step 5 APIs: Task and User Management
  // --------------------------------------------------------------------------
  test('Step 5: Admin manages tasks and users', async () => {
    // 1. Create a task as Admin
    const createTaskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Weekly Backup Verification',
        assigneeId: 4,
        frequencyDays: 7,
        proofType: 'ACK',
        dueTime: '17:00',
        startDate: '2026-11-01'
      });

    expect(createTaskRes.status).toBe(201);
    const newTaskId = createTaskRes.body.id;
    expect(newTaskId).toBeDefined();

    // Verify initial cycle was created automatically
    const [cycles]: any = await testDb.query(`SELECT * FROM task_cycles WHERE task_id = ?`, [newTaskId]);
    expect(cycles.length).toBe(1);

    // 2. Update task
    const patchRes = await request(app)
      .patch(`/api/tasks/${newTaskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Weekly Cloud Backup Verification' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('Weekly Cloud Backup Verification');

    // 3. Get tasks
    const getTasksRes = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getTasksRes.status).toBe(200);
    expect(getTasksRes.body.some((t: any) => t.id === newTaskId)).toBe(true);

    // 4. Create user
    const createUserRes = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Emily Employee',
        email: 'emily@test.com',
        password: 'Password123!',
        role: 'EMPLOYEE',
        managerId: 2
      });

    expect(createUserRes.status).toBe(201);
    expect(createUserRes.body.email).toBe('emily@test.com');

    // 5. Get users
    const getUsersRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getUsersRes.status).toBe(200);
    expect(getUsersRes.body.some((u: any) => u.email === 'emily@test.com')).toBe(true);
  });
});
