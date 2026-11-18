import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { AuthController, loginSchema } from '../controllers/authController';
import { validateBody } from '../middleware/validate';

export function createAuthRouter(db: Pool): Router {
  const router = Router();
  const controller = new AuthController(db);

  router.post('/login', validateBody(loginSchema), controller.login);

  return router;
}
