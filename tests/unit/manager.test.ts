import { ManagerController } from '../../src/controllers/managerController';
import { TaskController, UserController } from '../../src/controllers/taskController';
import { Pool } from 'mysql2/promise';

function createMockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('ManagerController Unit Tests', () => {
  let mockPool: jest.Mocked<Pool>;
  let managerController: ManagerController;

  beforeEach(() => {
    mockPool = {
      query: jest.fn()
    } as unknown as jest.Mocked<Pool>;
    managerController = new ManagerController(mockPool);
  });

  test('getOverview returns grouped employees with pending/overdue counts', async () => {
    const req: any = {
      user: { id: 2, role: 'MANAGER' }
    };
    const res = createMockRes();
    const next = jest.fn();

    // 1. SELECT employees
    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 4, name: 'Alex', email: 'alex@test.com' }]
    ]);

    // 2. SELECT cycles for Alex
    const pastDue = new Date(Date.now() - 3600 * 1000);
    const futureDue = new Date(Date.now() + 3600 * 1000);

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [
        {
          cycleId: 101,
          taskId: 1,
          taskName: 'Task 1',
          frequencyDays: 7,
          proofType: 'TICKET',
          dueAt: pastDue,
          dueDate: '2026-11-16',
          rawStatus: 'OPEN',
          acknowledgedAt: null,
          escalationLevel: 1
        },
        {
          cycleId: 102,
          taskId: 2,
          taskName: 'Task 2',
          frequencyDays: 1,
          proofType: 'ACK',
          dueAt: futureDue,
          dueDate: '2026-11-17',
          rawStatus: 'OPEN',
          acknowledgedAt: null,
          escalationLevel: null
        },
        {
          cycleId: 103,
          taskId: 3,
          taskName: 'Task 3',
          frequencyDays: 15,
          proofType: 'TICKET',
          dueAt: pastDue,
          dueDate: '2026-11-16',
          rawStatus: 'OPEN',
          acknowledgedAt: new Date(),
          escalationLevel: 2
        }
      ]
    ]);

    await managerController.getOverview(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0];
    expect(data.length).toBe(1);
    expect(data[0].employee.name).toBe('Alex');
    expect(data[0].pending).toBe(3);
    expect(data[0].overdue).toBe(2);
    expect(data[0].cycles[0].status).toBe('Overdue');
    expect(data[0].cycles[1].status).toBe('Open');
    expect(data[0].cycles[2].status).toBe('Acknowledged-Still Pending');
  });

  test('acknowledgeCycle successfully acknowledges an open cycle', async () => {
    const req: any = {
      user: { id: 2, role: 'MANAGER' },
      params: { id: '101' }
    };
    const res = createMockRes();
    const next = jest.fn();

    // 1. SELECT cycle
    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 101, status: 'OPEN', assignee_id: 4, manager_id: 2 }]
    ]);

    // 2. SELECT acknowledgements (none yet)
    (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);

    // 3. INSERT acknowledgements
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 50 }]);

    // 4. INSERT audit_log
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 51 }]);

    await managerController.acknowledgeCycle(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0];
    expect(data.acknowledgedAt).toBeDefined();
  });

  test('acknowledgeCycle is idempotent if already acknowledged', async () => {
    const ackDate = new Date();
    const req: any = {
      user: { id: 2, role: 'MANAGER' },
      params: { id: '101' }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 101, status: 'OPEN', assignee_id: 4, manager_id: 2 }]
    ]);

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 50, acknowledged_at: ackDate }]
    ]);

    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 52 }]); // audit_log

    await managerController.acknowledgeCycle(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].acknowledgedAt).toEqual(ackDate);
  });

  test('acknowledgeCycle updates acknowledged_at if row exists with null', async () => {
    const req: any = {
      user: { id: 2, role: 'MANAGER' },
      params: { id: '101' }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 101, status: 'OPEN', assignee_id: 4, manager_id: 2 }]
    ]);

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 50, acknowledged_at: null }]
    ]);

    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 53 }]); // audit_log

    await managerController.acknowledgeCycle(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('acknowledgeCycle throws 404 for unknown cycle', async () => {
    const req: any = {
      user: { id: 2, role: 'MANAGER' },
      params: { id: '999' }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);

    await managerController.acknowledgeCycle(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' })
    );
  });

  test('acknowledgeCycle throws 400 if cycle is already COMPLETED', async () => {
    const req: any = {
      user: { id: 2, role: 'MANAGER' },
      params: { id: '101' }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 101, status: 'COMPLETED', assignee_id: 4, manager_id: 2 }]
    ]);

    await managerController.acknowledgeCycle(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'CYCLE_COMPLETED' })
    );
  });

  test('acknowledgeCycle throws 403 if manager is not the employee manager', async () => {
    const req: any = {
      user: { id: 9, role: 'MANAGER' }, // Different manager
      params: { id: '101' }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 101, status: 'OPEN', assignee_id: 4, manager_id: 2 }]
    ]);

    await managerController.acknowledgeCycle(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' })
    );
  });

  test('getEscalations returns escalated open cycles for leadership', async () => {
    const req: any = { user: { id: 3, role: 'LEADERSHIP' } };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [
        {
          cycleId: 201,
          taskId: 5,
          taskName: 'Critical Sync',
          frequencyDays: 7,
          proofType: 'TICKET',
          dueAt: new Date(),
          dueDate: '2026-11-16',
          employeeId: 4,
          employeeName: 'Alex',
          employeeEmail: 'alex@test.com',
          managerId: 2,
          managerName: 'Sarah',
          managerEmail: 'manager@test.com',
          acknowledgedAt: null,
          escalationLevel: 3
        }
      ]
    ]);

    await managerController.getEscalations(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0];
    expect(data.length).toBe(1);
    expect(data[0].taskName).toBe('Critical Sync');
    expect(data[0].escalationLevel).toBe(3);
    expect(data[0].status).toBe('Overdue');
  });
});

describe('TaskController & UserController Unit Tests', () => {
  let mockPool: jest.Mocked<Pool>;
  let taskController: TaskController;
  let userController: UserController;

  beforeEach(() => {
    mockPool = {
      query: jest.fn()
    } as unknown as jest.Mocked<Pool>;
    taskController = new TaskController(mockPool);
    userController = new UserController(mockPool);
  });

  test('getTasks returns task list', async () => {
    const req: any = {};
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 1, name: 'Daily Standup', assigneeId: 4, active: 1 }]
    ]);

    await taskController.getTasks(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].length).toBe(1);
  });

  test('createTask creates new recurring task and initial cycle', async () => {
    const req: any = {
      user: { id: 1, role: 'ADMIN' },
      body: {
        name: 'Weekly Jira Triage',
        assigneeId: 4,
        frequencyDays: 7,
        proofType: 'TICKET',
        dueTime: '17:00',
        startDate: '2026-11-01'
      }
    };
    const res = createMockRes();
    const next = jest.fn();

    // 1. SELECT assignee user
    (mockPool.query as jest.Mock).mockResolvedValueOnce([[{ id: 4 }]]);
    // 2. INSERT recurring_tasks
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 10 }]);
    // 3. CycleService ensureInitialCycle: SELECT task
    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 10, name: 'Weekly Jira Triage', assignee_id: 4, frequency_days: 7, proof_type: 'TICKET', due_time: '17:00:00', start_date: '2026-11-01', active: 1 }]
    ]);
    // 4. CycleService ensureInitialCycle: SELECT existing cycle
    (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
    // 5. CycleService ensureInitialCycle: INSERT cycle
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 101 }]);
    // 6. INSERT audit_log
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 1 }]);

    await taskController.createTask(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].id).toBe(10);
  });

  test('createTask throws 404 if assignee is missing or inactive', async () => {
    const req: any = {
      user: { id: 1, role: 'ADMIN' },
      body: {
        name: 'Weekly Jira Triage',
        assigneeId: 999,
        frequencyDays: 7,
        proofType: 'TICKET',
        dueTime: '17:00',
        startDate: '2026-11-01'
      }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);

    await taskController.createTask(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' })
    );
  });

  test('updateTask updates task fields', async () => {
    const req: any = {
      user: { id: 1, role: 'ADMIN' },
      params: { id: '10' },
      body: { name: 'Updated Name', active: 0 }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ affectedRows: 1 }]);
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 2 }]); // audit_log
    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 10, name: 'Updated Name', active: 0 }]
    ]);

    await taskController.updateTask(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].name).toBe('Updated Name');
  });

  test('getUsers returns all users', async () => {
    const req: any = {};
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([
      [{ id: 1, name: 'Admin', email: 'admin@test.com' }]
    ]);

    await userController.getUsers(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].length).toBe(1);
  });

  test('createUser creates user and hashes password', async () => {
    const req: any = {
      body: {
        name: 'New Person',
        email: 'person@test.com',
        password: 'Password123!',
        role: 'EMPLOYEE',
        managerId: 2
      }
    };
    const res = createMockRes();
    const next = jest.fn();

    // Check duplicate email (none)
    (mockPool.query as jest.Mock).mockResolvedValueOnce([[]]);
    // Insert user
    (mockPool.query as jest.Mock).mockResolvedValueOnce([{ insertId: 20 }]);

    await userController.createUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].id).toBe(20);
    expect(res.json.mock.calls[0][0].email).toBe('person@test.com');
  });

  test('createUser rejects duplicate email with 409', async () => {
    const req: any = {
      body: {
        name: 'New Person',
        email: 'existing@test.com',
        password: 'Password123!',
        role: 'EMPLOYEE'
      }
    };
    const res = createMockRes();
    const next = jest.fn();

    (mockPool.query as jest.Mock).mockResolvedValueOnce([[{ id: 1 }]]);

    await userController.createUser(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, code: 'EMAIL_ALREADY_EXISTS' })
    );
  });
});
