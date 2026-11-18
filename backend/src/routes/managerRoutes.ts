import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { ManagerController } from '../controllers/managerController';
import { TaskController, UserController } from '../controllers/taskController';
import { authenticate, authorize } from '../middleware/auth';

export function createManagerAndTaskRouter(db: Pool): Router {
  const router = Router();
  const managerController = new ManagerController(db);
  const taskController = new TaskController(db);
  const userController = new UserController(db);

  // Manager Overview
  router.get('/manager/overview', authenticate, authorize('MANAGER', 'ADMIN'), managerController.getOverview);

  // Manager Acknowledge Button
  router.post('/cycles/:id/acknowledge', authenticate, authorize('MANAGER', 'ADMIN'), managerController.acknowledgeCycle);

  // Leadership Escalation Board
  router.get('/leadership/escalations', authenticate, authorize('LEADERSHIP', 'ADMIN'), managerController.getEscalations);

  // Task Management
  router.get('/tasks', authenticate, authorize('ADMIN', 'MANAGER'), taskController.getTasks);
  router.post('/tasks', authenticate, authorize('ADMIN'), taskController.createTask);
  router.patch('/tasks/:id', authenticate, authorize('ADMIN'), taskController.updateTask);

  // User Management
  router.get('/users', authenticate, authorize('ADMIN', 'MANAGER'), userController.getUsers);
  router.post('/users', authenticate, authorize('ADMIN'), userController.createUser);

  return router;
}
