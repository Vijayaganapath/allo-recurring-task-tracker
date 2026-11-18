import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { pool } from './config/db';
import { errorHandler, AppError } from './middleware/errorHandler';
import { createAuthRouter } from './routes/authRoutes';
import { createEmployeeRouter } from './routes/employeeRoutes';
import { createAdminAndAckRouter } from './routes/adminRoutes';
import { createManagerAndTaskRouter } from './routes/managerRoutes';
import { SchedulerService } from './services/schedulerService';

dotenv.config();

// Task A3: JWT_SECRET must come from .env and server must refuse to start if missing
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('[FATAL] JWT_SECRET environment variable is missing.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors());
app.use(express.json());

// Task A3: Rate limit on POST /api/auth/login
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new AppError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many login attempts, please try again later',
        statusCode: 429
      })
    );
  }
});

// Public health check
app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', createAuthRouter(pool));
app.use('/api', createEmployeeRouter(pool));
app.use('/api', createAdminAndAckRouter(pool));
app.use('/api', createManagerAndTaskRouter(pool));

// Central Error Handler
app.use(errorHandler);

// Node-cron scheduler (runs only in production/development, NEVER during test suite)
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
let scheduledTask: cron.ScheduledTask | null = null;

if (!isTestEnv) {
  const cronExpression = process.env.SCHEDULER_CRON || '*/15 * * * *';
  const schedulerService = new SchedulerService(pool);

  scheduledTask = cron.schedule(cronExpression, async () => {
    console.log('[Scheduler] Running automated SLA check...');
    try {
      const summary = await schedulerService.runScheduler();
      console.log('[Scheduler] Completed:', summary);
    } catch (err: any) {
      console.error('[Scheduler] Error during execution:', err.message);
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

export default app;
