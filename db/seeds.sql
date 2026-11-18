-- ============================================================
-- Seed Data for Allo Innoware Recurring Task Tracker
-- Passwords are bcrypt hash for: 'Password123!'
-- Hash: $2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy
-- ============================================================

USE recurring_task_tracker;

-- Seed Users
INSERT INTO users (id, name, email, password_hash, role, manager_id, active) VALUES
(1, 'Admin User', 'admin@alloinnoware.com', '$2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy', 'ADMIN', NULL, TRUE),
(2, 'Sarah Manager', 'manager@alloinnoware.com', '$2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy', 'MANAGER', NULL, TRUE),
(3, 'Vikram Leadership', 'leadership@alloinnoware.com', '$2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy', 'LEADERSHIP', NULL, TRUE),
(4, 'Alex Employee', 'alex@alloinnoware.com', '$2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy', 'EMPLOYEE', 2, TRUE),
(5, 'Rhea Employee', 'rhea@alloinnoware.com', '$2a$10$er1bqkLHd.avAVR9aENEmORxfG0bb2AYwpNuFblfFFzrPNNYhQedy', 'EMPLOYEE', 2, TRUE)
ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash);

-- Seed Recurring Tasks
INSERT INTO recurring_tasks (id, name, assignee_id, frequency_days, proof_type, due_time, start_date, active) VALUES
(1, 'Daily WhatsApp Status Report', 4, 1, 'ACK', '18:00:00', '2026-11-01', TRUE),
(2, 'Weekly Jira Bug Triage', 4, 7, 'TICKET', '17:00:00', '2026-11-01', TRUE),
(3, 'Bi-Weekly Infrastructure Audit', 5, 15, 'TICKET', '15:00:00', '2026-11-01', TRUE),
(4, 'Monthly Security Compliance Review', 5, 30, 'ACK', '12:00:00', '2026-11-01', TRUE)
ON DUPLICATE KEY UPDATE name=VALUES(name);
