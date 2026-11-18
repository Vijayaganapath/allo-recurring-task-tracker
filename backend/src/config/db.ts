import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbName =
  (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined)
    ? (process.env.TEST_DB_NAME || 'recurring_task_tracker_test')
    : (process.env.DB_NAME || 'recurring_task_tracker');

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'allo_user',
  password: process.env.DB_PASSWORD || 'allo_password',
  database: dbName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
