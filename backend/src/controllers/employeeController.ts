import { Request, Response, NextFunction } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { CycleService } from '../services/cycleService';

export const completeCycleSchema = z.object({
  ticketId: z.string().optional(),
  note: z.string().optional()
});

interface PendingCycleRow extends RowDataPacket {
  cycleId: number;
  task_name: string;
  dueAt: Date;
  status: 'OPEN' | 'COMPLETED';
  proofType: 'TICKET' | 'ACK';
}

interface CycleDetailsRow extends RowDataPacket {
  id: number;
  task_id: number;
  cycle_no: number;
  due_date: string;
  due_at: Date;
  status: 'OPEN' | 'COMPLETED';
  assignee_id: number;
  proof_type: 'TICKET' | 'ACK';
  frequency_days: number;
  due_time: string;
}

export class EmployeeController {
  private cycleService: CycleService;

  constructor(private db: Pool) {
    this.cycleService = new CycleService(db);
  }

  /**
   * GET /api/me/pending (EMPLOYEE)
   * The caller's OPEN cycles with cycleId, task, dueAt, status (Open/Overdue computed), proofType.
   */
  getMyPending = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const now = new Date();

      const [rows] = await this.db.query<PendingCycleRow[]>(
        `SELECT 
          c.id AS cycleId,
          t.name AS task,
          c.due_at AS dueAt,
          c.status,
          t.proof_type AS proofType
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        WHERE t.assignee_id = ? AND c.status = 'OPEN'
        ORDER BY c.due_at ASC`,
        [userId]
      );

      const cycles = rows.map(r => {
        const isOverdue = new Date(r.dueAt).getTime() < now.getTime();
        return {
          cycleId: r.cycleId,
          task: (r as any).task || r.task_name,
          dueAt: r.dueAt,
          status: isOverdue ? 'Overdue' : 'Open',
          proofType: r.proofType
        };
      });

      return res.status(200).json(cycles);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/cycles/:id/complete (EMPLOYEE, own cycles only)
   * Body: { ticketId?, note? }
   * - ticketId required when proof_type is TICKET
   * - Returns 409 if already completed
   * - In ONE DB transaction:
   *   1. Lock cycle row
   *   2. Insert completion (completed_by, completed_at, ticket_id, note)
   *   3. Set cycle COMPLETED
   *   4. Create next cycle via cycleService
   *   5. Write audit_log
   */
  completeCycle = async (req: Request, res: Response, next: NextFunction) => {
    const cycleId = parseInt(req.params.id, 10);
    if (isNaN(cycleId)) {
      return next(new AppError({ code: 'VALIDATION_ERROR', message: 'Invalid cycle ID', statusCode: 400 }));
    }

    const { ticketId, note } = req.body;
    const userId = req.user!.id;
    const completedAt = new Date();

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Fetch cycle and task with row lock
      const [cycleRows] = await conn.query<CycleDetailsRow[]>(
        `SELECT 
          c.id, c.task_id, c.cycle_no, c.due_date, c.due_at, c.status,
          t.assignee_id, t.proof_type, t.frequency_days, t.due_time
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        WHERE c.id = ? FOR UPDATE`,
        [cycleId]
      );

      if (cycleRows.length === 0) {
        throw new AppError({ code: 'NOT_FOUND', message: 'Cycle not found', statusCode: 404 });
      }

      const cycle = cycleRows[0];

      // Verify ownership
      if (cycle.assignee_id !== userId) {
        throw new AppError({ code: 'FORBIDDEN', message: 'Cannot complete tasks assigned to other employees', statusCode: 403 });
      }

      // Check if already completed (409 Conflict)
      if (cycle.status === 'COMPLETED') {
        throw new AppError({ code: 'ALREADY_COMPLETED', message: 'This cycle is already completed', statusCode: 409 });
      }

      // If proof_type is TICKET, ticketId is required
      if (cycle.proof_type === 'TICKET' && (!ticketId || String(ticketId).trim() === '')) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: 'ticketId is required for tasks requiring TICKET proof',
          statusCode: 400
        });
      }

      // 2. Insert completion record
      const [compRes] = await conn.query<any>(
        `INSERT INTO completions (cycle_id, completed_by, completed_at, ticket_id, note)
         VALUES (?, ?, ?, ?, ?)`,
        [cycle.id, userId, completedAt, ticketId || null, note || null]
      );

      // 3. Mark current cycle as COMPLETED
      await conn.query(`UPDATE task_cycles SET status = 'COMPLETED' WHERE id = ?`, [cycle.id]);

      // 4. Create next cycle using transactional connection
      const cycleServiceTx = new CycleService(conn as any);
      const nextCycle = await cycleServiceTx.createNextCycle(
        {
          id: cycle.id,
          task_id: cycle.task_id,
          cycle_no: cycle.cycle_no,
          due_date: cycle.due_date,
          due_at: cycle.due_at
        },
        {
          frequency_days: cycle.frequency_days,
          due_time: cycle.due_time
        },
        completedAt
      );

      // 5. Write to audit_log
      await conn.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, created_at)
         VALUES (?, 'COMPLETE_CYCLE', 'task_cycles', ?, ?)`,
        [userId, cycle.id, completedAt]
      );

      await conn.commit();

      return res.status(200).json({
        completion: {
          id: compRes.insertId,
          cycleId: cycle.id,
          completedBy: userId,
          completedAt,
          ticketId: ticketId || null,
          note: note || null
        },
        nextCycle
      });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  };
}
