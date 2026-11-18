import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { CycleService } from '../services/cycleService';

const createTaskSchema = z.object({
  name: z.string().min(1, 'Task name is required'),
  assigneeId: z.number().int().positive('Assignee ID is required'),
  frequencyDays: z.union([z.literal(1), z.literal(7), z.literal(15), z.literal(30)]),
  proofType: z.enum(['TICKET', 'ACK']),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, 'Invalid time format (HH:MM or HH:MM:SS)'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
});

const updateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  assigneeId: z.number().int().positive().optional(),
  frequencyDays: z.union([z.literal(1), z.literal(7), z.literal(15), z.literal(30)]).optional(),
  proofType: z.enum(['TICKET', 'ACK']).optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/).optional(),
  active: z.union([z.literal(0), z.literal(1), z.boolean()]).optional()
});

const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['EMPLOYEE', 'MANAGER', 'LEADERSHIP', 'ADMIN']),
  managerId: z.number().int().positive().nullable().optional()
});

export class TaskController {
  private cycleService: CycleService;

  constructor(private db: Pool) {
    this.cycleService = new CycleService(db);
  }

  /**
   * GET /api/tasks (ADMIN, MANAGER)
   */
  getTasks = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [tasks] = await this.db.query<RowDataPacket[]>(
        `SELECT 
          t.id, t.name, t.assignee_id AS assigneeId, u.name AS assigneeName, u.email AS assigneeEmail,
          t.frequency_days AS frequencyDays, t.proof_type AS proofType,
          t.due_time AS dueTime, t.start_date AS startDate, t.active, t.created_at AS createdAt
        FROM recurring_tasks t
        JOIN users u ON t.assignee_id = u.id
        ORDER BY t.id DESC`
      );

      return res.status(200).json(tasks);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/tasks (ADMIN)
   */
  createTask = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = createTaskSchema.parse(req.body);
      const dueTimeFormatted = validated.dueTime.length === 5 ? `${validated.dueTime}:00` : validated.dueTime;

      // Verify assignee exists and is active
      const [userRows] = await this.db.query<RowDataPacket[]>(
        'SELECT id FROM users WHERE id = ? AND active = 1',
        [validated.assigneeId]
      );
      if (userRows.length === 0) {
        throw new AppError({ code: 'NOT_FOUND', message: 'Assignee user not found or inactive', statusCode: 404 });
      }

      const [result] = await this.db.query<ResultSetHeader>(
        `INSERT INTO recurring_tasks (name, assignee_id, frequency_days, proof_type, due_time, start_date, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [validated.name, validated.assigneeId, validated.frequencyDays, validated.proofType, dueTimeFormatted, validated.startDate]
      );

      const taskId = result.insertId;

      // Automatically generate initial cycle
      await this.cycleService.ensureInitialCycle(taskId);

      // Audit log
      const actor = (req as any).user;
      await this.db.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, created_at)
         VALUES (?, 'CREATE_TASK', 'recurring_tasks', ?, NOW())`,
        [actor?.id || null, taskId]
      );

      return res.status(201).json({
        id: taskId,
        name: validated.name,
        assigneeId: validated.assigneeId,
        frequencyDays: validated.frequencyDays,
        proofType: validated.proofType,
        dueTime: dueTimeFormatted,
        startDate: validated.startDate,
        active: 1
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PATCH /api/tasks/:id (ADMIN)
   */
  updateTask = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const taskId = Number(req.params.id);
      if (isNaN(taskId)) {
        throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid task ID', statusCode: 400 });
      }

      const validated = updateTaskSchema.parse(req.body);
      const updates: string[] = [];
      const values: any[] = [];

      if (validated.name !== undefined) {
        updates.push('name = ?');
        values.push(validated.name);
      }
      if (validated.assigneeId !== undefined) {
        updates.push('assignee_id = ?');
        values.push(validated.assigneeId);
      }
      if (validated.frequencyDays !== undefined) {
        updates.push('frequency_days = ?');
        values.push(validated.frequencyDays);
      }
      if (validated.proofType !== undefined) {
        updates.push('proof_type = ?');
        values.push(validated.proofType);
      }
      if (validated.dueTime !== undefined) {
        const time = validated.dueTime.length === 5 ? `${validated.dueTime}:00` : validated.dueTime;
        updates.push('due_time = ?');
        values.push(time);
      }
      if (validated.active !== undefined) {
        const activeVal = typeof validated.active === 'boolean' ? (validated.active ? 1 : 0) : validated.active;
        updates.push('active = ?');
        values.push(activeVal);
      }

      if (updates.length === 0) {
        return res.status(200).json({ message: 'No changes provided' });
      }

      values.push(taskId);
      const [resHeader] = await this.db.query<ResultSetHeader>(
        `UPDATE recurring_tasks SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      if (resHeader.affectedRows === 0) {
        throw new AppError({ code: 'NOT_FOUND', message: 'Task not found', statusCode: 404 });
      }

      // Audit log
      const actor = (req as any).user;
      await this.db.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, created_at)
         VALUES (?, 'UPDATE_TASK', 'recurring_tasks', ?, NOW())`,
        [actor?.id || null, taskId]
      );

      const [updatedRows] = await this.db.query<RowDataPacket[]>(
        'SELECT * FROM recurring_tasks WHERE id = ?',
        [taskId]
      );

      return res.status(200).json(updatedRows[0]);
    } catch (error) {
      next(error);
    }
  };
}

export class UserController {
  constructor(private db: Pool) {}

  /**
   * GET /api/users (ADMIN, MANAGER)
   */
  getUsers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [users] = await this.db.query<RowDataPacket[]>(
        `SELECT id, name, email, role, manager_id AS managerId, active, created_at AS createdAt
         FROM users
         ORDER BY id ASC`
      );
      return res.status(200).json(users);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/users (ADMIN)
   */
  createUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = createUserSchema.parse(req.body);

      // Check unique email
      const [existing] = await this.db.query<RowDataPacket[]>(
        'SELECT id FROM users WHERE email = ? LIMIT 1',
        [validated.email]
      );
      if (existing.length > 0) {
        throw new AppError({ code: 'EMAIL_ALREADY_EXISTS', message: 'A user with this email already exists', statusCode: 409 });
      }

      const passwordHash = await bcrypt.hash(validated.password, 10);
      const managerId = validated.managerId || null;

      const [result] = await this.db.query<ResultSetHeader>(
        `INSERT INTO users (name, email, password_hash, role, manager_id, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [validated.name, validated.email, passwordHash, validated.role, managerId]
      );

      const userId = result.insertId;

      return res.status(201).json({
        id: userId,
        name: validated.name,
        email: validated.email,
        role: validated.role,
        managerId,
        active: 1
      });
    } catch (error) {
      next(error);
    }
  };
}
