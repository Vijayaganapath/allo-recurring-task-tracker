-- ============================================================
-- Allo Innoware Recurring Task Tracker
-- MySQL 8 Schema Definition (Combined Reference)
-- ============================================================

CREATE DATABASE IF NOT EXISTS recurring_task_tracker;
USE recurring_task_tracker;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('EMPLOYEE', 'MANAGER', 'LEADERSHIP', 'ADMIN') NOT NULL DEFAULT 'EMPLOYEE',
    manager_id INT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recurring Tasks Master table
CREATE TABLE IF NOT EXISTS recurring_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    assignee_id INT NOT NULL,
    frequency_days INT NOT NULL,
    proof_type ENUM('TICKET', 'ACK') NOT NULL DEFAULT 'ACK',
    due_time TIME NOT NULL,
    start_date DATE NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_tasks_assignee_active (assignee_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Task Cycles table
CREATE TABLE IF NOT EXISTS task_cycles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    cycle_no INT NOT NULL,
    due_date DATE NOT NULL,
    due_at DATETIME NOT NULL,
    status ENUM('OPEN', 'COMPLETED') NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cycles_task FOREIGN KEY (task_id) REFERENCES recurring_tasks(id) ON DELETE CASCADE,
    UNIQUE KEY uq_task_cycle_no (task_id, cycle_no),
    UNIQUE KEY uq_task_due_date (task_id, due_date),
    INDEX idx_cycles_status_due_at (status, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cycle Completions table
CREATE TABLE IF NOT EXISTS completions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cycle_id INT NOT NULL UNIQUE,
    completed_by INT NOT NULL,
    completed_at DATETIME NOT NULL,
    ticket_id VARCHAR(100) NULL,
    note TEXT NULL,
    CONSTRAINT fk_completions_cycle FOREIGN KEY (cycle_id) REFERENCES task_cycles(id) ON DELETE CASCADE,
    CONSTRAINT fk_completions_user FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Escalation Events table (idempotent notification records)
CREATE TABLE IF NOT EXISTS escalation_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cycle_id INT NOT NULL,
    level TINYINT NOT NULL COMMENT '0: Reminder, 1: Manager Alert, 2: Manager Re-check, 3: Leadership Escalation',
    sent_to VARCHAR(255) NOT NULL,
    status ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    error_message VARCHAR(500) NULL,
    sent_at DATETIME NULL,
    CONSTRAINT fk_escalations_cycle FOREIGN KEY (cycle_id) REFERENCES task_cycles(id) ON DELETE CASCADE,
    UNIQUE KEY uq_cycle_level (cycle_id, level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Manager Acknowledgements table
CREATE TABLE IF NOT EXISTS acknowledgements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cycle_id INT NOT NULL,
    manager_id INT NOT NULL,
    level TINYINT NOT NULL DEFAULT 1,
    acknowledged_at DATETIME NULL,
    token CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NULL,
    CONSTRAINT fk_ack_cycle FOREIGN KEY (cycle_id) REFERENCES task_cycles(id) ON DELETE CASCADE,
    CONSTRAINT fk_ack_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_cycle_user_level (cycle_id, manager_id, level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notification Log table
CREATE TABLE IF NOT EXISTS notification_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    to_email VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notif_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit Log table
CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    action VARCHAR(100) NOT NULL,
    entity VARCHAR(100) NOT NULL,
    entity_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
