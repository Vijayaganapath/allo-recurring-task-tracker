import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { AdminController, AckController } from '../controllers/adminController';
import { authenticate, authorize } from '../middleware/auth';

export function createAdminAndAckRouter(db: Pool): Router {
  const router = Router();
  const adminController = new AdminController(db);
  const ackController = new AckController(db);

  // Admin manual scheduler trigger
  router.post('/admin/run-scheduler', authenticate, authorize('ADMIN', 'MANAGER'), adminController.runScheduler);

  // Public tokenized acknowledgement link
  router.get('/ack/:token', ackController.acknowledgeByToken);

  return router;
}
