# Google Sheet Version: Setup, Tests and SLA Design

## Setup (about 10 minutes)
1. Create a new Google Sheet named **Allo Recurring Task Tracker**.
2. File > Settings > set **Time zone** to `(GMT+05:30) India Standard Time`.
3. Extensions > Apps Script. Delete the sample code and paste all of `Code.gs`. Save.
4. In Apps Script: Project Settings (gear) > tick **Show appsscript.json** and set `"timeZone": "Asia/Kolkata"`.
5. Reload the Sheet. A **Task Tracker** menu appears.
6. Menu > **1. Setup sheets**. Approve the Google permissions the first time. (Click Advanced > Go to project if you see an "unverified app" warning. It is your own script.)
7. Menu > **2. Install triggers**. This adds the 15-minute scheduler and the edit handler.
8. *(Optional but recommended, enables the Acknowledge link in emails.)* In Apps Script: Deploy > New deployment > type **Web app** > Execute as **Me** > Who has access **Anyone** > Deploy. Copy the web app URL into the `WEBAPP_URL` row of the **Config** sheet. Without it, the manager acknowledges with the checkbox in Manager View.
9. Share the Sheet with **hr.ops.allo@gmail.com** as **Editor**.

All demo emails go to your own inbox using Gmail "+" aliases (for example `you+manager@gmail.com`), so you can see who each email is for. To use real addresses, edit the **Users**, **Tasks** and **Config** sheets.

## Sheets
| Sheet | Purpose |
|---|---|
| Config | SLA hours, manager/leadership emails, web app URL |
| Users | Employees and their manager |
| Tasks | Recurring task master: frequency, proof type (TICKET or ACK), due time, start date, active |
| Cycles | One row per cycle; status, proof, who/when, escalation flags, acknowledgements |
| **My Pending** | **The only sheet an employee uses** |
| Manager View | Per-employee open/overdue counts, plus overdue list with Acknowledge checkbox |
| Log | Every cycle created, completion, email sent and run (proof for Test 8) |

## Daily task method (Test 3)
The employee posts in the WhatsApp group as usual, then ticks **Done** on their row in My Pending (optionally pasting the message link in Note). One tick records who and when, closes the cycle and creates tomorrow's. No ticket, no second system.

## Test walkthrough
Before testing, run Setup and Install triggers. Tip: keep the **Log** sheet open.

| Test | Do this | Expected result |
|---|---|---|
| 1 Recurring cycle | In My Pending, choose **Employee B**, type `TKT-1001` in Ticket ID for Portal Task A | Cycles: `T2-C1` COMPLETED; `T2-C2` OPEN, due exactly 7 days after C1's due (15 and 30 days for Tasks B and C) |
| 2 Single-point | Same action as Test 1 | Ticket, who and when are stored in Cycles automatically; nothing else was edited |
| 3 Daily | Choose Employee A, tick **Done** | `T1-C1` COMPLETED; `T1-C2` created for the next day |
| 4 Same-day alert | Menu > **Demo: create overdue test cases**, then **Run scheduler now** | One digest email to the manager for T5 (2h overdue), with employee and task |
| 5 Manager acknowledgement | Click **Acknowledge** in the email, or tick the box in Manager View | `ManagerAckAt` filled; message says the task is still pending |
| 6 Leadership escalation | The same run also escalates T6 (26h overdue) | One email to leadership |
| 7 Timing logic | See the SLA table below | |
| 8 No duplicates | Click **Run scheduler now** 3 more times | Log shows `emails=0`, with no new cycles or emails (flags and CycleIDs are unique) |

## SLA and escalation design (Test 7)
| Level | When | To | Why |
|---|---|---|---|
| L0 reminder | 2h before due (not for daily tasks) | Employee | Cheap prevention |
| L1 alert | Due + 1h | Manager | Same-day alert; a 1h grace avoids noise from near-misses |
| L2 re-check | Due + 5h, only if not acknowledged | Manager | Forces visibility; acknowledging stops it |
| L3 escalation | Due + 24h, still open | Leadership | Unresolved for a full day, so leadership is told |

How duplicates are avoided:
- **One send per level:** each level has a timestamp column in Cycles, and it is written before the email is sent. A second run sees it and skips.
- **One cycle per period:** CycleID is `TaskID-C<number>`, and a cycle is never added if its ID exists.
- **One digest per recipient per run:** a manager gets one email listing everything, not one per task.
- **No overlap:** `LockService` stops two runs executing at once.
- **Completed means silent:** completing a task stops all later levels, because only OPEN cycles are checked.
- **Failures retry:** if an email fails, its flags are cleared so the next run retries.

## Limitations
- The trigger runs every 15 minutes, so an alert can arrive up to 15 minutes after its threshold. The same-day requirement is still met.
- Free Gmail can send about 100 emails a day through Apps Script, which is plenty for this volume.
- Who completed a task is taken from the employee row, plus the editor's email when Google provides it.
- The Manager View summary has four employee rows. Add rows by copying the formulas down.
