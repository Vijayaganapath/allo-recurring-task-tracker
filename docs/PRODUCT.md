# Recurring Task Tracker: Product Document

Based on the Allo Innoware "AI Operations / Founder's Office" assignment.

## 1. Goal
Tell each employee what is pending, capture completion once, alert the manager the same day if work is late, and escalate to leadership if it stays unresolved. Recurring cycles are created automatically.

## 2. User Roles
| Role | Can do |
|---|---|
| **Employee** | See own pending cycles; complete a cycle (Ticket ID or one-click Done) |
| **Manager** | See all team pending/overdue; acknowledge alerts; view history |
| **Leadership** | Read-only escalation dashboard; acknowledge escalations |
| **Admin** | Manage users, tasks, SLA config (can be the Manager in the prototype) |

## 3. Feature List
1. JWT login, role-based access.
2. **Task master**: name, assignee, frequency (1 / 7 / 15 / 30 days), proof type (`TICKET` or `ACK`), due time of day, start date, active flag.
3. **Automatic cycle generation**: a scheduler creates the current cycle for every active task. Completing a cycle creates the next one.
4. **Employee "My Pending" page**: the single operating place. Shows task, due date, status, required proof, and an inline Ticket ID box or a **Mark Done** button.
5. **Daily task method (no ticket)**: the employee taps **Mark Done** once, with an optional note or WhatsApp message link. The system records user and timestamp. It is one tap, with no second sheet or system. *Optional extension: a WhatsApp Business webhook that auto-completes on a group post.*
6. **Completion tracking**: stores who, when, proof value and note. Completion closes the cycle and schedules the next.
7. **Manager dashboard**: grouped by employee, with pending/overdue counts and escalation state.
8. **Alerts and escalation** (section 5), with email via SMTP.
9. **Manager acknowledgement**: a tokenised link in the email, plus a button in the UI.
10. **Idempotency**: running the scheduler repeatedly creates no duplicate cycles, completions or emails.
11. **Audit log** of all state changes.

## 4. Recurrence Logic
- `next_due = previous_due + frequency_days` (anchored, so there is no drift when a task is completed late).
- If that date is not after the completion date (the task was missed by more than one period), roll forward in whole periods until it is.
- Only one `OPEN` cycle per task, enforced by a unique key `(task_id, due_date)` and a check in the service.

## 5. SLA and Escalation Design
| Level | Trigger | Recipient | Reason |
|---|---|---|---|
| L0 Reminder | Due day, 2h before due time (daily: skipped) | Employee | Prevents most misses cheaply |
| L1 Manager alert | Due time + 1h, still open (**same day**) | Manager (one digest per manager) | Satisfies same-day requirement; grace period avoids noise |
| L2 Manager re-check | L1 + 4h with **no acknowledgement** | Manager | Forces visibility |
| L3 Leadership | Due + 24h still open, **or** L1 + 24h unacknowledged | Leadership | Unresolved beyond a defined SLA |

Duplicate control:
- Each level is sent **at most once per cycle**, enforced by `UNIQUE(cycle_id, level)` on `escalation_events`.
- Emails are batched per manager per scheduler run.
- Acknowledgement stops L2. Completion stops everything.
- The scheduler runs every 15 minutes and is safe to re-run.

Times are configurable via env/`sla_config` (defaults above).

## 6. Manager Action Definition
On L1 the manager must **acknowledge** (link or button) and then either chase the employee or reassign. The system tracks `acknowledged_at` and `acknowledged_by`. Status shown: `Open / Acknowledged-Still Pending / Completed`.

## 7. Database Schema (MySQL 8)
```sql
users(id PK, name, email UNIQUE, password_hash, role ENUM('EMPLOYEE','MANAGER','LEADERSHIP','ADMIN'),
      manager_id FK users NULL, active, created_at)

recurring_tasks(id PK, name, assignee_id FK, frequency_days INT, proof_type ENUM('TICKET','ACK'),
      due_time TIME, start_date DATE, active, created_at)

task_cycles(id PK, task_id FK, cycle_no INT, due_date DATE, due_at DATETIME,
      status ENUM('OPEN','COMPLETED'), created_at,
      UNIQUE(task_id, cycle_no), UNIQUE(task_id, due_date),
      INDEX(status, due_at))

completions(id PK, cycle_id FK UNIQUE, completed_by FK users, completed_at DATETIME,
      ticket_id VARCHAR(100) NULL, note TEXT NULL)

escalation_events(id PK, cycle_id FK, level TINYINT, sent_to, sent_at,
      UNIQUE(cycle_id, level))

acknowledgements(id PK, cycle_id FK, manager_id FK, acknowledged_at, token CHAR(64) UNIQUE,
      UNIQUE(cycle_id, manager_id))

notification_log(id PK, to_email, subject, status, created_at)
audit_log(id PK, user_id, action, entity, entity_id, created_at)
```
Indexes: `task_cycles(status, due_at)`, `recurring_tasks(assignee_id, active)`, `escalation_events(cycle_id, level)`.

## 8. API Contracts (REST, JSON, `Authorization: Bearer <jwt>`)
| Method & Path | Role | Request | Response |
|---|---|---|---|
| `POST /api/auth/login` | any | `{email,password}` | `{token,user}` |
| `GET /api/me/pending` | Employee | | `[{cycleId,task,dueAt,status,proofType}]` |
| `POST /api/cycles/:id/complete` | Employee | `{ticketId?,note?}` (ticketId required if `TICKET`) | `{completion,nextCycle}` |
| `GET /api/manager/overview` | Manager | | `[{employee,pending,overdue,cycles[]}]` |
| `POST /api/cycles/:id/acknowledge` | Manager | | `{acknowledgedAt}` |
| `GET /api/ack/:token` | public (token) | | acknowledges, then redirects |
| `GET /api/leadership/escalations` | Leadership | | escalated open cycles |
| `GET/POST/PATCH /api/tasks` | Admin | task fields | task |
| `GET/POST /api/users` | Admin | user fields | user |
| `POST /api/admin/run-scheduler` | Admin | | `{created,emails}` (for demos/Test 8) |
| `GET /api/health` | public | | `{status:"ok"}` |

Errors: `{error:{code,message,details?}}` with 400 validation, 401, 403, 404, 409 (already completed), 500.

## 9. Test Case Mapping
| Assignment test | Covered by |
|---|---|
| 1 Recurring cycle | complete 7/15/30-day cycle, so the next cycle is created with anchored due date |
| 2 Single-point completion | `/me/pending` page with inline ticket entry |
| 3 Daily task | Mark Done, with user and timestamp recorded |
| 4 Same-day alert | seed an overdue task, L1 email sent |
| 5 Manager acknowledgement | ack link and status tracking |
| 6, 7 Leadership escalation | L3 after 24h or no ack, with the SLA table above |
| 8 No duplicates | run the scheduler N times, with unique constraints and idempotent sends |

## 10. Repo Layout
`/docs /db /backend /frontend /tests docker-compose.yml .env.example README.md`

## 11. Stack
Node.js 20 + Express, `mysql2`, Zod validation, JWT + bcrypt, node-cron, Nodemailer. React (Vite) frontend. Jest + Supertest for tests. Docker Compose on a single bridge network.
