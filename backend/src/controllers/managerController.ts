import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { AppError } from '../middleware/errorHandler';

export class ManagerController {
  constructor(private db: Pool) {}

  /**
   * GET /api/manager/overview (MANAGER, ADMIN)
   * Grouped by employee, with pending/overdue counts and cycles
   */
  getOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const isManager = user.role === 'MANAGER';
      const isAdmin = user.role === 'ADMIN';

      // Find employees reporting to this manager (or all if admin)
      let employeeQuery = 'SELECT id, name, email FROM users WHERE role = "EMPLOYEE" AND active = 1';
      const employeeParams: any[] = [];

      if (isManager && !isAdmin) {
        employeeQuery += ' AND manager_id = ?';
        employeeParams.push(user.id);
      }

      employeeQuery += ' ORDER BY name ASC';
      const [employees] = await this.db.query<RowDataPacket[]>(employeeQuery, employeeParams);

      const overview = [];

      for (const emp of employees) {
        // Fetch OPEN cycles for this employee
        const [cycles] = await this.db.query<RowDataPacket[]>(
          `SELECT 
            c.id AS cycleId,
            t.id AS taskId,
            t.name AS taskName,
            t.frequency_days AS frequencyDays,
            t.proof_type AS proofType,
            c.due_at AS dueAt,
            c.due_date AS dueDate,
            c.status AS rawStatus,
            MAX(a.acknowledged_at) AS acknowledgedAt,
            MAX(e.level) AS escalationLevel
          FROM task_cycles c
          JOIN recurring_tasks t ON c.task_id = t.id
          LEFT JOIN acknowledgements a ON a.cycle_id = c.id
          LEFT JOIN escalation_events e ON e.cycle_id = c.id AND e.status = 'SENT'
          WHERE t.assignee_id = ? AND c.status = 'OPEN'
          GROUP BY c.id, t.id
          ORDER BY c.due_at ASC`,
          [emp.id]
        );

        const now = Date.now();
        let pendingCount = 0;
        let overdueCount = 0;

        const formattedCycles = cycles.map(c => {
          pendingCount++;
          const isOverdue = new Date(c.dueAt).getTime() < now;
          if (isOverdue) overdueCount++;

          let computedStatus = 'Open';
          if (c.acknowledgedAt) {
            computedStatus = 'Acknowledged-Still Pending';
          } else if (isOverdue) {
            computedStatus = 'Overdue';
          }

          return {
            cycleId: c.cycleId,
            taskId: c.taskId,
            taskName: c.taskName,
            frequencyDays: c.frequencyDays,
            proofType: c.proofType,
            dueAt: c.dueAt,
            dueDate: c.dueDate,
            status: computedStatus,
            acknowledgedAt: c.acknowledgedAt,
            escalationLevel: c.escalationLevel !== null ? Number(c.escalationLevel) : null
          };
        });

        overview.push({
          employee: {
            id: emp.id,
            name: emp.name,
            email: emp.email
          },
          pending: pendingCount,
          overdue: overdueCount,
          cycles: formattedCycles
        });
      }

      return res.status(200).json(overview);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/cycles/:id/acknowledge (MANAGER, ADMIN)
   * Acknowledges an overdue cycle
   */
  acknowledgeCycle = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const cycleId = Number(req.params.id);

      if (isNaN(cycleId)) {
        throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid cycle ID', statusCode: 400 });
      }

      // Check cycle existence and ownership
      const [cycleRows] = await this.db.query<RowDataPacket[]>(
        `SELECT c.id, c.status, t.assignee_id, u.manager_id
         FROM task_cycles c
         JOIN recurring_tasks t ON c.task_id = t.id
         JOIN users u ON t.assignee_id = u.id
         WHERE c.id = ? LIMIT 1`,
        [cycleId]
      );

      if (cycleRows.length === 0) {
        throw new AppError({ code: 'NOT_FOUND', message: 'Cycle not found', statusCode: 404 });
      }

      const cycle = cycleRows[0];

      if (cycle.status !== 'OPEN') {
        throw new AppError({ code: 'CYCLE_COMPLETED', message: 'Cycle is already completed', statusCode: 400 });
      }

      // Manager authority check (must be the assignee's manager or an ADMIN)
      if (user.role === 'MANAGER' && cycle.manager_id !== user.id) {
        throw new AppError({ code: 'FORBIDDEN', message: 'You can only acknowledge cycles for your direct reports', statusCode: 403 });
      }

      // Check if acknowledgement already exists
      const [ackRows] = await this.db.query<RowDataPacket[]>(
        `SELECT id, acknowledged_at FROM acknowledgements WHERE cycle_id = ? AND manager_id = ? LIMIT 1`,
        [cycleId, user.id]
      );

      let acknowledgedAt: Date;

      if (ackRows.length > 0 && ackRows[0].acknowledged_at !== null) {
        acknowledgedAt = ackRows[0].acknowledged_at;
      } else if (ackRows.length > 0) {
        acknowledgedAt = new Date();
        await this.db.query(
          `UPDATE acknowledgements SET acknowledged_at = ? WHERE id = ?`,
          [acknowledgedAt, ackRows[0].id]
        );
      } else {
        acknowledgedAt = new Date();
        const token = crypto.randomBytes(32).toString('hex');
        await this.db.query(
          `INSERT INTO acknowledgements (cycle_id, manager_id, level, token, acknowledged_at)
           VALUES (?, ?, 1, ?, ?)`,
          [cycleId, user.id, token, acknowledgedAt]
        );
      }

      // Write audit log
      await this.db.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, created_at)
         VALUES (?, 'ACKNOWLEDGE_CYCLE', 'task_cycles', ?, NOW())`,
        [user.id, cycleId]
      );

      return res.status(200).json({ acknowledgedAt });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leadership/escalations (LEADERSHIP, ADMIN)
   * Read-only escalation dashboard
   */
  getEscalations = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();

      const [rows] = await this.db.query<RowDataPacket[]>(
        `SELECT 
          c.id AS cycleId,
          t.id AS taskId,
          t.name AS taskName,
          t.frequency_days AS frequencyDays,
          t.proof_type AS proofType,
          c.due_at AS dueAt,
          c.due_date AS dueDate,
          u.id AS employeeId,
          u.name AS employeeName,
          u.email AS employeeEmail,
          m.id AS managerId,
          m.name AS managerName,
          m.email AS managerEmail,
          MAX(a.acknowledged_at) AS acknowledgedAt,
          MAX(e.level) AS escalationLevel
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        JOIN users u ON t.assignee_id = u.id
        LEFT JOIN users m ON u.manager_id = m.id
        JOIN escalation_events e ON e.cycle_id = c.id AND e.status = 'SENT'
        LEFT JOIN acknowledgements a ON a.cycle_id = c.id
        WHERE c.status = 'OPEN'
        GROUP BY c.id, t.id, u.id, m.id
        ORDER BY c.due_at ASC`
      );

      const escalations = rows.map(r => {
        let computedStatus = 'Overdue';
        if (r.acknowledgedAt) {
          computedStatus = 'Acknowledged-Still Pending';
        }

        return {
          cycleId: r.cycleId,
          taskId: r.taskId,
          taskName: r.taskName,
          frequencyDays: r.frequencyDays,
          proofType: r.proofType,
          dueAt: r.dueAt,
          dueDate: r.dueDate,
          employee: {
            id: r.employeeId,
            name: r.employeeName,
            email: r.employeeEmail
          },
          manager: r.managerId ? {
            id: r.managerId,
            name: r.managerName,
            email: r.managerEmail
          } : null,
          status: computedStatus,
          escalationLevel: r.escalationLevel !== null ? Number(r.escalationLevel) : null,
          acknowledgedAt: r.acknowledgedAt
        };
      });

      return res.status(200).json(escalations);
    } catch (error) {
      next(error);
    }
  };
}
