import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { EmployeeController, completeCycleSchema } from '../controllers/employeeController';
import { authenticate, authorize } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

export function createEmployeeRouter(db: Pool): Router {
  const router = Router();
  const controller = new EmployeeController(db);

  // All employee routes require authenticated EMPLOYEE role (or ADMIN for testing/admin impersonation)
  router.get('/me/pending', authenticate, authorize('EMPLOYEE', 'ADMIN'), controller.getMyPending);
  router.post('/cycles/:id/complete', authenticate, authorize('EMPLOYEE', 'ADMIN'), validateBody(completeCycleSchema), controller.completeCycle);

  return router;
}
