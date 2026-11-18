# Recurring Task Tracker

> Built for Allo Innoware - AI Operations / Founder's Office Assignment

This repository provides two complete deliverables for automated recurring task tracking, SLA monitoring, and multi-tier escalation:

1. **(a) Google Sheet + Apps Script Solution in [`/gsheet`](./gsheet)**:
   - A standalone, zero-dependency spreadsheet prototype running entirely in Google Sheets and Google Apps Script.
   - Includes custom menu actions, sheet auto-initialization, 15-minute time-driven triggers, WhatsApp daily 1-tap Done, L0–L3 multi-tier escalation, and web app tokenized acknowledgement.
   - See [`gsheet/SETUP.md`](./gsheet/SETUP.md) for the 10-minute setup guide and [`gsheet/Code.gs`](./gsheet/Code.gs) for the full script.

2. **(b) Bonus Dockerised Full-Stack Application**:
   - A production-grade multi-tier architecture built with Node.js 20, Express, MySQL 8.0, React (Vite), and Mailpit local SMTP trap.
   - Implements anchored recurrence (no schedule drift), idempotent escalation dispatch, rate limiting, and RBAC authentication.

---

## 📋 Prerequisites

- **Docker Desktop** (running with Linux containers engine enabled)

---

## 🚀 Quick Setup & Run

```bash
# 1. Copy the environment variables
cp .env.example .env

# 2. Build and start all services (MySQL, Backend, Frontend, Mailpit)
docker compose up --build -d
```

### 🌐 Service URLs
- **Frontend**: [http://localhost:5173](http://localhost:5173) (Vite dev server)
- **API Health**: [http://localhost:5000/api/health](http://localhost:5000/api/health)
- **Mailpit Web UI (Local Email Trap)**: [http://localhost:8025](http://localhost:8025)
- **MySQL Database**: `localhost:3306`

---

## 👥 Demo Accounts

All seed users are configured with password: **`Password123!`**

| Role | Email | Capabilities |
|---|---|---|
| **Admin** | `admin@alloinnoware.com` | Task master CRUD, user management, trigger scheduler on demand (`POST /api/admin/run-scheduler`) |
| **Manager** | `manager@alloinnoware.com` | Team pending/overdue overview (`GET /api/manager/overview`), in-app cycle acknowledgement |
| **Leadership** | `leadership@alloinnoware.com` | Read-only L3 escalation board (`GET /api/leadership/escalations`) |
| **Employee** | `alex@alloinnoware.com` | "My Pending" task completion with Ticket ID or 1-tap Done |
| **Employee** | `rhea@alloinnoware.com` | "My Pending" task completion |

---

## 🧪 Running Tests

To run the complete test suite (unit and integration tests against the isolated test database) with coverage:

```bash
docker compose exec backend npm test -- --coverage
```

Current test results: **7 passed test suites, 90 passed tests, 96.49% branch coverage, 100% statement coverage**.

---

## 🎯 SLA & Escalation Ladder

| Level | Trigger | Recipient | Action Required |
|---|---|---|---|
| **L0 Reminder** | 2h before due time (skipped for daily tasks) | Employee | Complete task before deadline |
| **L1 Alert** | Due time + 1h (same day) | Manager (batched digest email) | Acknowledge via email link or UI |
| **L2 Re-check** | Due time + 5h (L1 + 4h) if unacknowledged | Manager | Chase employee or reassign |
| **L3 Escalation** | Due time + 24h still open (or L1 + 24h unacknowledged) | Leadership | Executive intervention |

*Note: Escalations are strictly idempotent, guarded by `UNIQUE(cycle_id, level)`, and never send duplicates on repeated scheduler runs.*

---

## 📁 Repository Map

```
F:\Allo innoware\
├── docs/
│   ├── PRODUCT.md                     # Authoritative product specifications (sections 1-11)
│   └── SUBMISSION_EXPLANATION.md      # Architecture, methodology, and design explanations
├── gsheet/
│   ├── Code.gs                        # Google Apps Script implementation
│   └── SETUP.md                       # Google Sheets 10-minute setup and test walkthrough
├── db/
│   ├── schema.sql                     # Combined reference schema
│   ├── seeds.sql                      # Reference seed data
│   └── migrations/
│       ├── 001_create_schema.sql      # Schema definitions
│       ├── 002_seed_initial_data.sql  # Initial seed data with bcrypt hashes
│       └── 003_ack_and_status_fixes.sql # SLA and acknowledgement tracking fixes
├── backend/
│   ├── Dockerfile                     # Multi-stage TypeScript build
│   ├── jest.config.js                 # Jest test runner configuration (80% threshold)
│   ├── package.json                   # Dependencies and scripts
│   ├── tsconfig.json                  # TypeScript compiler settings
│   └── src/
│       ├── server.ts                  # Server entrypoint and router mount
│       ├── config/db.ts               # MySQL connection pool with test DB switcher
│       ├── controllers/               # Controllers: auth, employee, manager, task, admin
│       ├── middleware/                # Middleware: auth (JWT/RBAC), validation (Zod), errorHandler
│       ├── routes/                    # API route definitions
│       ├── services/                  # Business logic: cycleService, notificationService, schedulerService
│       └── utils/                     # Utility: recurrence calculation with DST & TZ safety
├── frontend/
│   ├── Dockerfile                     # Frontend container definition
│   ├── nginx.conf                     # Nginx proxy configuration
│   ├── package.json                   # React dependencies
│   ├── vite.config.ts                 # Vite bundler config
│   └── src/                           # Base React application shell
├── tests/
│   ├── integration/api.test.ts        # Tests 1-8 integration suite against real test database
│   └── unit/                          # Unit test suites (auth, cycleService, employee, manager, recurrence, scheduler)
├── docker-compose.yml                 # Multi-container orchestration (MySQL, Mailpit, backend, frontend)
├── .env.example                       # Reference environment variables
└── README.md                          # Repository documentation
```
