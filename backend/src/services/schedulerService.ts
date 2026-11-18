import crypto from 'crypto';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { CycleService, CycleRow, TaskRow } from './cycleService';
import { NotificationService } from './notificationService';

export interface SchedulerRunResult {
  createdCycles: number;
  emailsSent: number;
  errors: string[];
}

export class SchedulerService {
  private cycleService: CycleService;
  private notificationService: NotificationService;

  constructor(private db: Pool) {
    this.cycleService = new CycleService(db);
    this.notificationService = new NotificationService(db);
  }

  /**
   * Main scheduler execution:
   * 1. Auto-create initial cycles for active tasks with no open cycle
   * 2. Process SLA levels (L0, L1, L2, L3) with idempotency and transaction checks
   * 3. Batch L1 digest per manager
   */
  async runScheduler(): Promise<SchedulerRunResult> {
    const result: SchedulerRunResult = {
      createdCycles: 0,
      emailsSent: 0,
      errors: []
    };

    // 1. Ensure initial cycle for all active tasks
    try {
      const [activeTasks] = await this.db.query<TaskRow[]>(
        'SELECT id FROM recurring_tasks WHERE active = 1'
      );

      for (const t of activeTasks) {
        const [existing] = await this.db.query<RowDataPacket[]>(
          'SELECT id FROM task_cycles WHERE task_id = ? AND status = "OPEN" LIMIT 1',
          [t.id]
        );
        if (existing.length === 0) {
          const created = await this.cycleService.ensureInitialCycle(t.id);
          if (created) result.createdCycles++;
        }
      }
    } catch (err: any) {
      result.errors.push(`Initial cycle creation error: ${err.message}`);
    }

    const now = new Date();
    const l0HoursBefore = Number(process.env.SLA_L0_REMINDER_HOURS_BEFORE) || 2;
    const l1HoursAfter = Number(process.env.SLA_L1_MANAGER_ALERT_HOURS_AFTER) || 1;
    const l2HoursAfter = Number(process.env.SLA_L2_MANAGER_RECHECK_HOURS_AFTER) || 4;
    const l3HoursAfter = Number(process.env.SLA_L3_LEADERSHIP_HOURS_AFTER) || 24;
    const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';

    // ----------------------------------------------------
    // L0: Reminder 2h before due time (skipped for 1-day daily tasks)
    // ----------------------------------------------------
    try {
      const [l0Candidates] = await this.db.query<RowDataPacket[]>(
        `SELECT 
          c.id AS cycle_id, c.due_at, t.name AS task_name, u.email AS employee_email, u.name AS employee_name
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        JOIN users u ON t.assignee_id = u.id
        WHERE c.status = 'OPEN'
          AND t.frequency_days > 1
          AND c.due_at <= DATE_ADD(?, INTERVAL ? HOUR)
          AND c.due_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM escalation_events e WHERE e.cycle_id = c.id AND e.level = 0 AND e.status = 'SENT'
          )`,
        [now, l0HoursBefore, now]
      );

      for (const row of l0Candidates) {
        // Insert PENDING event before sending
        let eventId: number | null = null;
        try {
          const [ins] = await this.db.query<ResultSetHeader>(
            `INSERT INTO escalation_events (cycle_id, level, sent_to, status, sent_at)
             VALUES (?, 0, ?, 'PENDING', NULL)
             ON DUPLICATE KEY UPDATE status = IF(status = 'FAILED', 'PENDING', status)`,
            [row.cycle_id, row.employee_email]
          );
          eventId = ins.insertId;
        } catch (e) {
          continue; // Already processed
        }

        const sent = await this.notificationService.sendEmail({
          to: row.employee_email,
          subject: `[Reminder] Task Due Soon: ${row.task_name}`,
          html: `<p>Hello ${row.employee_name},</p><p>Your task <strong>${row.task_name}</strong> is due at ${row.due_at}. Please complete it on time.</p>`
        });

        if (sent) {
          await this.db.query(
            `UPDATE escalation_events SET status = 'SENT', sent_at = NOW(), error_message = NULL WHERE cycle_id = ? AND level = 0`,
            [row.cycle_id]
          );
          result.emailsSent++;
        } else {
          await this.db.query(
            `UPDATE escalation_events SET status = 'FAILED', error_message = 'SMTP Send Failed' WHERE cycle_id = ? AND level = 0`,
            [row.cycle_id]
          );
        }
      }
    } catch (err: any) {
      result.errors.push(`L0 error: ${err.message}`);
    }

    // ----------------------------------------------------
    // L1: Manager Alert at due + 1h if still open (batched digest per manager)
    // ----------------------------------------------------
    try {
      const [l1Candidates] = await this.db.query<RowDataPacket[]>(
        `SELECT 
          c.id AS cycle_id, c.due_at, t.name AS task_name,
          u.name AS employee_name, m.id AS manager_id, m.email AS manager_email, m.name AS manager_name
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        JOIN users u ON t.assignee_id = u.id
        JOIN users m ON u.manager_id = m.id
        WHERE c.status = 'OPEN'
          AND c.due_at <= DATE_SUB(?, INTERVAL ? HOUR)
          AND NOT EXISTS (
            SELECT 1 FROM escalation_events e WHERE e.cycle_id = c.id AND e.level = 1 AND e.status = 'SENT'
          )`,
        [now, l1HoursAfter]
      );

      // Group candidate items by manager
      const managerBatches = new Map<number, { manager_email: string; manager_name: string; items: any[] }>();

      for (const row of l1Candidates) {
        if (!managerBatches.has(row.manager_id)) {
          managerBatches.set(row.manager_id, {
            manager_email: row.manager_email,
            manager_name: row.manager_name,
            items: []
          });
        }
        managerBatches.get(row.manager_id)!.items.push(row);
      }

      // Process each manager digest
      for (const [managerId, batch] of managerBatches.entries()) {
        const itemsToEmail: any[] = [];

        for (const item of batch.items) {
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

          try {
            // 1. Insert escalation_events PENDING before sending
            await this.db.query(
              `INSERT INTO escalation_events (cycle_id, level, sent_to, status, sent_at)
               VALUES (?, 1, ?, 'PENDING', NULL)
               ON DUPLICATE KEY UPDATE status = IF(status = 'FAILED', 'PENDING', status)`,
              [item.cycle_id, batch.manager_email]
            );

            // 2. Insert or retrieve acknowledgement token
            await this.db.query(
              `INSERT INTO acknowledgements (cycle_id, manager_id, level, token, expires_at)
               VALUES (?, ?, 1, ?, ?)
               ON DUPLICATE KEY UPDATE token = VALUES(token)`,
              [item.cycle_id, managerId, token, expiresAt]
            );

            itemsToEmail.push({ ...item, token });
          } catch (e) {
            // Guarded by UNIQUE(cycle_id, level)
            continue;
          }
        }

        if (itemsToEmail.length === 0) continue;

        // Build digest HTML
        const rowsHtml = itemsToEmail
          .map(
            it => `
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd;">${it.employee_name}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${it.task_name}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${it.due_at}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">
                <a href="${appBaseUrl}/api/ack/${it.token}" style="display: inline-block; padding: 6px 12px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 4px;">Acknowledge</a>
              </td>
            </tr>`
          )
          .join('');

        const digestHtml = `
          <h3>Overdue Tasks Alert (Digest)</h3>
          <p>Hello ${batch.manager_name},</p>
          <p>The following tasks assigned to your team members are overdue:</p>
          <table style="border-collapse: collapse; width: 100%;">
            <thead>
              <tr style="background: #f3f4f6;">
                <th style="padding: 8px; border: 1px solid #ddd;">Employee</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Task</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Due At</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Action</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        `;

        const sent = await this.notificationService.sendEmail({
          to: batch.manager_email,
          subject: `[Alert] Overdue Tasks Digest (${itemsToEmail.length} items)`,
          html: digestHtml
        });

        for (const it of itemsToEmail) {
          if (sent) {
            await this.db.query(
              `UPDATE escalation_events SET status = 'SENT', sent_at = NOW(), error_message = NULL WHERE cycle_id = ? AND level = 1`,
              [it.cycle_id]
            );
          } else {
            await this.db.query(
              `UPDATE escalation_events SET status = 'FAILED', error_message = 'SMTP Send Failed' WHERE cycle_id = ? AND level = 1`,
              [it.cycle_id]
            );
          }
        }

        if (sent) result.emailsSent++;
      }
    } catch (err: any) {
      result.errors.push(`L1 error: ${err.message}`);
    }

    // ----------------------------------------------------
    // L2: Manager Re-check at L1 + 4h with NO acknowledgement
    // ----------------------------------------------------
    try {
      const [l2Candidates] = await this.db.query<RowDataPacket[]>(
        `SELECT 
          c.id AS cycle_id, c.due_at, t.name AS task_name,
          u.name AS employee_name, m.email AS manager_email, m.name AS manager_name
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        JOIN users u ON t.assignee_id = u.id
        JOIN users m ON u.manager_id = m.id
        JOIN escalation_events e1 ON e1.cycle_id = c.id AND e1.level = 1 AND e1.status = 'SENT'
        LEFT JOIN acknowledgements a ON a.cycle_id = c.id AND a.manager_id = m.id AND a.acknowledged_at IS NOT NULL
        WHERE c.status = 'OPEN'
          AND a.id IS NULL
          AND e1.sent_at <= DATE_SUB(?, INTERVAL ? HOUR)
          AND NOT EXISTS (
            SELECT 1 FROM escalation_events e2 WHERE e2.cycle_id = c.id AND e2.level = 2 AND e2.status = 'SENT'
          )`,
        [now, l2HoursAfter]
      );

      for (const row of l2Candidates) {
        try {
          await this.db.query(
            `INSERT INTO escalation_events (cycle_id, level, sent_to, status, sent_at)
             VALUES (?, 2, ?, 'PENDING', NULL)
             ON DUPLICATE KEY UPDATE status = IF(status = 'FAILED', 'PENDING', status)`,
            [row.cycle_id, row.manager_email]
          );
        } catch {
          continue;
        }

        const sent = await this.notificationService.sendEmail({
          to: row.manager_email,
          subject: `[URGENT Re-Check] Unacknowledged Overdue Task: ${row.task_name}`,
          html: `<p>Hello ${row.manager_name},</p><p>Task <strong>${row.task_name}</strong> for ${row.employee_name} is still unresolved and unacknowledged.</p>`
        });

        if (sent) {
          await this.db.query(
            `UPDATE escalation_events SET status = 'SENT', sent_at = NOW(), error_message = NULL WHERE cycle_id = ? AND level = 2`,
            [row.cycle_id]
          );
          result.emailsSent++;
        } else {
          await this.db.query(
            `UPDATE escalation_events SET status = 'FAILED', error_message = 'SMTP Send Failed' WHERE cycle_id = ? AND level = 2`,
            [row.cycle_id]
          );
        }
      }
    } catch (err: any) {
      result.errors.push(`L2 error: ${err.message}`);
    }

    // ----------------------------------------------------
    // L3: Leadership at due + 24h still open, OR L1 + 24h unacknowledged
    // ----------------------------------------------------
    try {
      const [l3Candidates] = await this.db.query<RowDataPacket[]>(
        `SELECT DISTINCT
          c.id AS cycle_id, c.due_at, t.name AS task_name,
          u.name AS employee_name
        FROM task_cycles c
        JOIN recurring_tasks t ON c.task_id = t.id
        JOIN users u ON t.assignee_id = u.id
        LEFT JOIN escalation_events e1 ON e1.cycle_id = c.id AND e1.level = 1 AND e1.status = 'SENT'
        LEFT JOIN acknowledgements a ON a.cycle_id = c.id AND a.acknowledged_at IS NOT NULL
        WHERE c.status = 'OPEN'
          AND (
            c.due_at <= DATE_SUB(?, INTERVAL ? HOUR)
            OR (e1.sent_at <= DATE_SUB(?, INTERVAL ? HOUR) AND a.id IS NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM escalation_events e3 WHERE e3.cycle_id = c.id AND e3.level = 3 AND e3.status = 'SENT'
          )`,
        [now, l3HoursAfter, now, l3HoursAfter]
      );

      // Fetch leadership emails
      const [leadershipUsers] = await this.db.query<RowDataPacket[]>(
        `SELECT id, email, name FROM users WHERE role = 'LEADERSHIP' AND active = 1`
      );

      for (const row of l3Candidates) {
        for (const leader of leadershipUsers) {
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

          try {
            await this.db.query(
              `INSERT INTO escalation_events (cycle_id, level, sent_to, status, sent_at)
               VALUES (?, 3, ?, 'PENDING', NULL)
               ON DUPLICATE KEY UPDATE status = IF(status = 'FAILED', 'PENDING', status)`,
              [row.cycle_id, leader.email]
            );

            await this.db.query(
              `INSERT INTO acknowledgements (cycle_id, manager_id, level, token, expires_at)
               VALUES (?, ?, 3, ?, ?)
               ON DUPLICATE KEY UPDATE token = VALUES(token)`,
              [row.cycle_id, leader.id, token, expiresAt]
            );
          } catch {
            continue;
          }

          const sent = await this.notificationService.sendEmail({
            to: leader.email,
            subject: `[LEADERSHIP ESCALATION] Task Overdue >24h: ${row.task_name}`,
            html: `
              <h3>Leadership Escalation Alert</h3>
              <p>Hello ${leader.name},</p>
              <p>Task <strong>${row.task_name}</strong> assigned to ${row.employee_name} has breached the 24-hour SLA.</p>
              <p><a href="${appBaseUrl}/api/ack/${token}">Acknowledge Escalation</a></p>`
          });

          if (sent) {
            await this.db.query(
              `UPDATE escalation_events SET status = 'SENT', sent_at = NOW(), error_message = NULL WHERE cycle_id = ? AND level = 3`,
              [row.cycle_id]
            );
            result.emailsSent++;
          } else {
            await this.db.query(
              `UPDATE escalation_events SET status = 'FAILED', error_message = 'SMTP Send Failed' WHERE cycle_id = ? AND level = 3`,
              [row.cycle_id]
            );
          }
        }
      }
    } catch (err: any) {
      result.errors.push(`L3 error: ${err.message}`);
    }

    return result;
  }
}
