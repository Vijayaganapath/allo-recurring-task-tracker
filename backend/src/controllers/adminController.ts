import { Request, Response, NextFunction } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { SchedulerService } from '../services/schedulerService';
import { AppError } from '../middleware/errorHandler';

export class AdminController {
  private schedulerService: SchedulerService;

  constructor(private db: Pool) {
    this.schedulerService = new SchedulerService(db);
  }

  /**
   * POST /api/admin/run-scheduler (ADMIN)
   * Runs scheduler on demand, returns { created, emails }
   */
  runScheduler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await this.schedulerService.runScheduler();
      return res.status(200).json({
        created: summary.createdCycles,
        emails: summary.emailsSent,
        errors: summary.errors
      });
    } catch (error) {
      next(error);
    }
  };
}

export class AckController {
  constructor(private db: Pool) {}

  /**
   * GET /api/ack/:token (public / tokenized link)
   * Sets acknowledged_at only if NULL and not expired, then redirects to frontend
   */
  acknowledgeByToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;
      const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';

      const [rows] = await this.db.query<RowDataPacket[]>(
        `SELECT id, cycle_id, manager_id, acknowledged_at, expires_at
         FROM acknowledgements
         WHERE token = ? LIMIT 1`,
        [token]
      );

      if (rows.length === 0) {
        throw new AppError({ code: 'NOT_FOUND', message: 'Invalid acknowledgement token', statusCode: 404 });
      }

      const ack = rows[0];

      if (ack.expires_at && new Date(ack.expires_at).getTime() < Date.now()) {
        throw new AppError({ code: 'TOKEN_EXPIRED', message: 'Acknowledgement link has expired', statusCode: 400 });
      }

      if (ack.acknowledged_at === null) {
        await this.db.query(
          `UPDATE acknowledgements SET acknowledged_at = NOW() WHERE id = ?`,
          [ack.id]
        );
      }

      // Redirect to frontend overview
      return res.redirect(`${appBaseUrl}/manager/overview?acknowledged=true&cycleId=${ack.cycle_id}`);
    } catch (error) {
      next(error);
    }
  };
}
