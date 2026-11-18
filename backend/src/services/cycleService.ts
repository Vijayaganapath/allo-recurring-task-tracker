import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface TaskRow extends RowDataPacket {
  id: number;
  name: string;
  assignee_id: number;
  frequency_days: number;
  proof_type: 'TICKET' | 'ACK';
  due_time: string; // "HH:MM:SS"
  start_date: string; // "YYYY-MM-DD"
  active: number | boolean;
}

export interface CycleRow extends RowDataPacket {
  id: number;
  task_id: number;
  cycle_no: number;
  due_date: string; // "YYYY-MM-DD"
  due_at: Date;
  status: 'OPEN' | 'COMPLETED';
}

/**
 * Calculates the next due date based on anchored recurrence.
 * - next_due = previous_due + frequency_days (anchored to prevent drift)
 * - If next_due <= completedAt (task was missed by more than one cycle),
 *   roll forward in whole frequency_days periods until next_due > completedAt.
 */
export function calculateNextDueDate(previousDue: Date, frequencyDays: number, completedAt: Date): Date {
  const next = new Date(previousDue.getTime());
  next.setDate(next.getDate() + frequencyDays);

  while (next.getTime() <= completedAt.getTime()) {
    next.setDate(next.getDate() + frequencyDays);
  }

  return next;
}

/**
 * Helper to combine a Date object's date part (YYYY-MM-DD) with a TIME string (HH:MM:SS)
 */
export function buildDueAt(dateObj: Date, dueTime: string): { dueDateStr: string; dueAt: Date } {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const dueDateStr = `${year}-${month}-${day}`;

  const [hours, minutes, seconds] = dueTime.split(':').map(Number);
  const dueAt = new Date(dateObj.getTime());
  dueAt.setHours(hours || 0, minutes || 0, seconds || 0, 0);

  return { dueDateStr, dueAt };
}

export class CycleService {
  constructor(private db: Pool) {}

  /**
   * Creates the initial OPEN cycle for an active task if no cycle exists,
   * or ensures an active task has an OPEN cycle.
   * Enforces: only ONE open cycle per task.
   */
  async ensureInitialCycle(taskId: number): Promise<CycleRow | null> {
    // 1. Check if there is already an OPEN cycle
    const [openCycles] = await this.db.query<CycleRow[]>(
      'SELECT * FROM task_cycles WHERE task_id = ? AND status = "OPEN" LIMIT 1',
      [taskId]
    );

    if (openCycles.length > 0) {
      return openCycles[0];
    }

    // 2. Fetch task details
    const [tasks] = await this.db.query<TaskRow[]>(
      'SELECT * FROM recurring_tasks WHERE id = ? AND active = 1',
      [taskId]
    );

    if (tasks.length === 0) {
      return null;
    }

    const task = tasks[0];

    // Find latest cycle_no for this task
    const [latestRows] = await this.db.query<RowDataPacket[]>(
      'SELECT MAX(cycle_no) as max_no FROM task_cycles WHERE task_id = ?',
      [taskId]
    );
    const nextCycleNo = ((latestRows[0]?.max_no as number) || 0) + 1;

    // Determine initial due date: task.start_date + due_time
    const startDate = new Date(task.start_date);
    const { dueDateStr, dueAt } = buildDueAt(startDate, task.due_time);

    try {
      const [result] = await this.db.query<ResultSetHeader>(
        'INSERT INTO task_cycles (task_id, cycle_no, due_date, due_at, status) VALUES (?, ?, ?, ?, "OPEN")',
        [taskId, nextCycleNo, dueDateStr, dueAt]
      );

      return {
        id: result.insertId,
        task_id: taskId,
        cycle_no: nextCycleNo,
        due_date: dueDateStr,
        due_at: dueAt,
        status: 'OPEN'
      } as CycleRow;
    } catch (err: any) {
      // In case of race condition or duplicate (task_id, due_date)
      if (err.code === 'ER_DUP_ENTRY') {
        const [existing] = await this.db.query<CycleRow[]>(
          'SELECT * FROM task_cycles WHERE task_id = ? AND status = "OPEN" LIMIT 1',
          [taskId]
        );
        return existing[0] || null;
      }
      throw err;
    }
  }

  /**
   * Calculates and generates the next cycle for a completed cycle.
   * - Enforces anchored recurrence
   * - Enforces roll-forward if missed
   * - Enforces only one OPEN cycle per task
   */
  async createNextCycle(
    cycle: { id: number; task_id: number; cycle_no: number; due_date: string; due_at: Date },
    task: { frequency_days: number; due_time: string },
    completedAt: Date
  ): Promise<CycleRow | null> {
    // 1. Check if an OPEN cycle already exists for this task
    const [existingOpen] = await this.db.query<CycleRow[]>(
      'SELECT * FROM task_cycles WHERE task_id = ? AND status = "OPEN" LIMIT 1',
      [cycle.task_id]
    );

    if (existingOpen.length > 0) {
      return existingOpen[0];
    }

    // 2. Compute next anchored due date
    const prevDue = new Date(cycle.due_at);
    const nextDueAt = calculateNextDueDate(prevDue, task.frequency_days, completedAt);
    const { dueDateStr } = buildDueAt(nextDueAt, task.due_time);
    const nextCycleNo = cycle.cycle_no + 1;

    // 3. Insert next OPEN cycle
    try {
      const [result] = await this.db.query<ResultSetHeader>(
        'INSERT INTO task_cycles (task_id, cycle_no, due_date, due_at, status) VALUES (?, ?, ?, ?, "OPEN")',
        [cycle.task_id, nextCycleNo, dueDateStr, nextDueAt]
      );

      return {
        id: result.insertId,
        task_id: cycle.task_id,
        cycle_no: nextCycleNo,
        due_date: dueDateStr,
        due_at: nextDueAt,
        status: 'OPEN'
      } as CycleRow;
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') {
        const [existing] = await this.db.query<CycleRow[]>(
          'SELECT * FROM task_cycles WHERE task_id = ? AND status = "OPEN" LIMIT 1',
          [cycle.task_id]
        );
        return existing[0] || null;
      }
      throw err;
    }
  }
}
