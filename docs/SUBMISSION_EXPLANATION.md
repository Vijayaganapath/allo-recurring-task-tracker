# Recurring Task Tracker - Submission Explanation

This document details the architecture, implementation methodology, and verification for the Allo Innoware Recurring Task Tracker assignment.

---

## 1. Project Overview & Deliverables

This repository provides two complete, production-grade solutions for the recurring task tracking and escalation problem:

1. **Google Sheets + Apps Script Prototype (`/gsheet`)**:
   - Zero-dependency, standalone Google Sheet solution running on Google Apps Script.
   - Includes custom menu, sheet auto-initialization, time-driven 15-minute triggers, WhatsApp daily 1-tap completion, SLA escalation (L0–L3), and web app tokenized manager acknowledgement.
   - Detailed setup instructions in [`gsheet/SETUP.md`](../gsheet/SETUP.md) and script in [`gsheet/Code.gs`](../gsheet/Code.gs).

2. **Full-Stack Dockerised Application (`/backend`, `/frontend`, `/db`)**:
   - Production multi-tier application with Express + MySQL 8.0 + React (Vite) + Tailwind CSS + Mailpit SMTP trap.
   - Containerized with Docker Compose, healthchecks, strict environment variable binding, and automated migrations.

---

## 2. Core Technical Decisions & Architecture

### A. Anchored Recurrence Logic (`backend/src/services/cycleService.ts`)
- **No Drift**: `next_due = previous_due + frequency_days`. When a cycle is completed late, next due remains anchored to the original schedule rather than the completion timestamp.
- **Roll-Forward**: If a task was overdue by more than one full period, the cycle service rolls forward in whole intervals until `next_due > completion_time`.
- **Single Open Cycle Constraint**: Enforced at both database level (`UNIQUE(task_id, due_date)`) and application service level to guarantee only one `OPEN` cycle exists per task at any time.

### B. SLA & Multi-Tier Escalation Engine (`backend/src/services/schedulerService.ts`)
- **L0 (Employee Reminder)**: 2 hours before due time. Skipped for daily (1-day) tasks to avoid notification fatigue.
- **L1 (Manager Alert)**: 1 hour past due time (same day). Batched into a single HTML digest email per manager with direct tokenized acknowledgement links.
- **L2 (Manager Re-Check)**: 4 hours past L1 if unacknowledged.
- **L3 (Leadership Escalation)**: 24 hours past due time, or 24 hours past L1 if unacknowledged.
- **Idempotency & Deduplication**:
  - Insert `escalation_events` row with status `PENDING` *before* attempting SMTP transmission.
  - On SMTP success, status updates to `SENT`; on failure, status updates to `FAILED` with error message.
  - Guarded by `UNIQUE(cycle_id, level)`. Never resends `SENT` events; safely retries `FAILED` events.
  - Repeated scheduler runs produce zero duplicate cycles, completions, or emails.

### C. Authentication & Role-Based Access Control (`backend/src/middleware/auth.ts`)
- Secure password storage via `bcryptjs` (salt rounds 10).
- Signed JWTs with 8-hour expiry and mandatory environment variable checks.
- RBAC guards for `EMPLOYEE`, `MANAGER`, `LEADERSHIP`, and `ADMIN`.
- Rate limiting on `/api/auth/login` (20 attempts / 15 minutes) and security headers via `helmet`.
- Uniform error format `{ error: { code, message, details? } }` across all endpoints.

---

## 3. Database Schema & Migration Strategy

- **Migrations (`db/migrations/`)**:
  - `001_create_schema.sql`: Core tables (`users`, `recurring_tasks`, `task_cycles`, `completions`, `escalation_events`, `acknowledgements`, `notification_log`, `audit_log`).
  - `002_seed_initial_data.sql`: Seed users and recurring tasks with pre-hashed credentials.
  - `003_ack_and_status_fixes.sql`: Added nullable timestamps and status columns for acknowledgement pre-generation and delivery auditing.
- **Timezone**: Enforced `Asia/Kolkata` (IST) across MySQL and backend application containers to eliminate month-boundary date-shifting anomalies.

---

## 4. Verification & Testing Matrix

The solution is verified with Jest unit and integration tests under `tests/` with 100% statements and 96.49% branch coverage (exceeding the 80% threshold):

1. **Test 1 (Recurring Cycle)**: 7/15/30-day anchored next cycle generation.
2. **Test 2 (Single-Point Completion)**: Employee `/api/me/pending` inline ticket ID completion.
3. **Test 3 (Daily Task)**: 1-click `proof_type: ACK` completion with actor and timestamp captured.
4. **Test 4 (Same-Day Alert)**: Overdue task triggers batched L1 digest email and 64-char acknowledgement token.
5. **Test 5 (Manager Acknowledgement)**: Tokenized link records timestamp and stops L2 re-check.
6. **Test 6 & 7 (Leadership Escalation)**: L3 fires after 24h SLA breach.
7. **Test 8 (Idempotency)**: 4 consecutive scheduler runs confirm 0 duplicate cycles, completions, or emails.
