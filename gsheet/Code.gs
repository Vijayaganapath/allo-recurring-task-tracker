/**
 * Recurring Task Tracker - Google Sheets + Apps Script
 * Allo Innoware assignment. Paste into Extensions > Apps Script, then run setupSystem().
 * Sheets: Config, Users, Tasks, Cycles, My Pending, Manager View, Log
 */
const SHEETS = { CONFIG: 'Config', USERS: 'Users', TASKS: 'Tasks', CYCLES: 'Cycles',
  PENDING: 'My Pending', MANAGER: 'Manager View', LOG: 'Log' };
const CYCLE_HEADERS = ['CycleID', 'TaskID', 'Task', 'Assignee', 'AssigneeEmail', 'ManagerEmail',
  'CycleNo', 'DueAt', 'Status', 'ProofType', 'TicketID', 'Note', 'CompletedBy', 'CompletedAt',
  'L0Sent', 'L1Sent', 'L2Sent', 'L3Sent', 'ManagerAckAt', 'LeaderAckAt'];
const TASK_HEADERS = ['TaskID', 'Task', 'Assignee', 'AssigneeEmail', 'FrequencyDays', 'ProofType',
  'DueTime', 'StartDate', 'Active'];
const USER_HEADERS = ['Name', 'Email', 'Role', 'ManagerEmail'];
const HOUR_MS = 3600000;
const MP_START = 5;   // My Pending first data row
const MV_START = 17;  // Manager View first detail row

/* ---------------- menu ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Tracker')
    .addItem('1. Setup sheets', 'setupSystem')
    .addItem('2. Install triggers', 'setupTriggers')
    .addSeparator()
    .addItem('Run scheduler now', 'runSchedulerNow')
    .addItem('Demo: create overdue test cases', 'makeOverdueDemo')
    .addItem('Refresh views', 'refreshViews')
    .addToUi();
}

/* ---------------- small helpers ---------------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sh_(name) { return ss_().getSheetByName(name); }
function tz_() { return ss_().getSpreadsheetTimeZone(); }
function num_(v, d) { const n = Number(v); return (v === '' || v === null || isNaN(n)) ? d : n; }
function fmt_(d) { return Utilities.formatDate(new Date(d), tz_(), 'dd MMM yyyy HH:mm'); }
function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}
function alias_(tag) { return Session.getEffectiveUser().getEmail().replace('@', '+' + tag + '@'); }
function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function log_(type, cycleId, detail) { sh_(SHEETS.LOG).appendRow([new Date(), type, cycleId, detail]); }

function getConfig_() {
  const cfg = {};
  sh_(SHEETS.CONFIG).getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) cfg[r[0]] = r[1]; });
  return cfg;
}

function readTable_(name) {
  const sheet = sh_(name);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = values.slice(1).map(function (r, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (h, c) { o[h] = r[c]; });
    return o;
  }).filter(function (o) { return o[headers[0]] !== ''; });
  return { sheet: sheet, headers: headers, rows: rows };
}

function setCell_(t, obj, header, value) {
  t.sheet.getRange(obj._row, t.headers.indexOf(header) + 1).setValue(value);
  obj[header] = value;
}

function parseHM_(v) {
  if (v instanceof Date) v = Utilities.formatDate(v, tz_(), 'HH:mm');
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? { h: +m[1], m: +m[2] } : { h: 17, m: 0 };
}
function dueAtFor_(date, hm) { const d = new Date(date); d.setHours(hm.h, hm.m, 0, 0); return d; }

/** Anchored recurrence: previous due + frequency; roll forward if still not after completion. */
function computeNextDue_(prevDue, freq, completedAt) {
  let next = addDays_(prevDue, freq);
  while (next.getTime() <= completedAt.getTime()) next = addDays_(next, freq);
  return next;
}

function isActive_(v) { return v === true || /^(TRUE|YES|Y)$/i.test(String(v)); }

/* ---------------- cycles ---------------- */
function managerFor_(task) {
  const u = readTable_(SHEETS.USERS).rows.find(function (x) {
    return String(x.Email).toLowerCase() === String(task.AssigneeEmail).toLowerCase();
  });
  return (u && u.ManagerEmail) || getConfig_().MANAGER_EMAIL;
}

/** Idempotent: CycleID = TaskID-C<n>, so the same cycle can never be added twice. */
function createCycle_(task, cycleNo, dueAt) {
  const id = task.TaskID + '-C' + cycleNo;
  const exists = readTable_(SHEETS.CYCLES).rows.some(function (r) { return r.CycleID === id; });
  if (exists) return null;
  const o = { CycleID: id, TaskID: task.TaskID, Task: task.Task, Assignee: task.Assignee,
    AssigneeEmail: task.AssigneeEmail, ManagerEmail: managerFor_(task), CycleNo: cycleNo,
    DueAt: dueAt, Status: 'OPEN', ProofType: task.ProofType };
  sh_(SHEETS.CYCLES).appendRow(CYCLE_HEADERS.map(function (h) { return o[h] === undefined ? '' : o[h]; }));
  log_('CYCLE_CREATED', id, 'due ' + fmt_(dueAt));
  return id;
}

function generateCycles_() {
  const tasks = readTable_(SHEETS.TASKS).rows.filter(function (t) { return isActive_(t.Active); });
  const cycles = readTable_(SHEETS.CYCLES).rows;
  let created = 0;
  tasks.forEach(function (t) {
    const mine = cycles.filter(function (c) { return c.TaskID === t.TaskID; });
    if (mine.some(function (c) { return c.Status === 'OPEN'; })) return;
    let no, due;
    if (!mine.length) {
      no = 1; due = dueAtFor_(t.StartDate, parseHM_(t.DueTime));
    } else {
      const last = mine.reduce(function (a, b) { return Number(b.CycleNo) > Number(a.CycleNo) ? b : a; });
      no = Number(last.CycleNo) + 1;
      due = computeNextDue_(last.DueAt, Number(t.FrequencyDays), new Date());
    }
    if (createCycle_(t, no, due)) created++;
  });
  return created;
}

/** Single-point completion: closes the cycle, stamps who/when/proof, creates the next cycle. */
function completeCycle_(cycleId, ticket, note, by) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(SHEETS.CYCLES);
    const c = t.rows.find(function (r) { return r.CycleID === cycleId; });
    if (!c) return { ok: false, msg: 'Cycle not found.' };
    if (c.Status !== 'OPEN') return { ok: false, msg: 'Already completed - no duplicate entry created.' };
    if (c.ProofType === 'TICKET' && !String(ticket || '').trim()) {
      return { ok: false, msg: 'Ticket ID is required for this task.' };
    }
    const now = new Date();
    setCell_(t, c, 'TicketID', ticket || '');
    setCell_(t, c, 'Note', note || '');
    setCell_(t, c, 'CompletedBy', by);
    setCell_(t, c, 'CompletedAt', now);
    setCell_(t, c, 'Status', 'COMPLETED');
    log_('COMPLETED', cycleId, by + (ticket ? ' | ticket ' + ticket : ' | done'));
    const task = readTable_(SHEETS.TASKS).rows.find(function (x) { return x.TaskID === c.TaskID; });
    let nextMsg = '';
    if (task && isActive_(task.Active)) {
      const nextDue = computeNextDue_(c.DueAt, Number(task.FrequencyDays), now);
      createCycle_(task, Number(c.CycleNo) + 1, nextDue);
      nextMsg = ' Next cycle due ' + fmt_(nextDue) + '.';
    }
    return { ok: true, msg: 'Completed.' + nextMsg };
  } finally { lock.releaseLock(); }
}

/* ---------------- acknowledgement ---------------- */
function sig_(cycleId, level) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('ACK_SECRET');
  if (!secret) { secret = Utilities.getUuid(); props.setProperty('ACK_SECRET', secret); }
  const bytes = Utilities.computeHmacSha256Signature(cycleId + '|' + level, secret);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 22);
}
function ackLink_(cfg, cycleId, level) {
  if (!cfg.WEBAPP_URL) return '';
  return cfg.WEBAPP_URL + '?c=' + encodeURIComponent(cycleId) + '&l=' + level + '&s=' + sig_(cycleId, level);
}

function ackCycle_(cycleId, who) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = readTable_(SHEETS.CYCLES);
    const c = t.rows.find(function (r) { return r.CycleID === cycleId; });
    if (!c) return 'Task cycle not found.';
    const col = who === 'LEADER' ? 'LeaderAckAt' : 'ManagerAckAt';
    let msg;
    if (c[col]) { msg = 'Already acknowledged earlier.'; }
    else { setCell_(t, c, col, new Date()); log_('ACK', cycleId, who); msg = 'Acknowledged.'; }
    return msg + ' ' + c.Assignee + ' - ' + c.Task + ' is ' + (c.Status === 'OPEN' ? 'still PENDING.' : 'COMPLETED.');
  } finally { lock.releaseLock(); }
}

/** Web app: the Acknowledge link in the emails. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.c || !p.s || sig_(p.c, p.l) !== p.s) return HtmlService.createHtmlOutput('<h3>Invalid or expired link.</h3>');
  return HtmlService.createHtmlOutput('<h3>' + esc_(ackCycle_(p.c, p.l === '3' ? 'LEADER' : 'MANAGER')) + '</h3>');
}

/* ---------------- SLA / escalation ---------------- */
function checkSLA_() {
  const cfg = getConfig_();
  const H0 = num_(cfg.L0_REMINDER_HOURS_BEFORE_DUE, 2);
  const H1 = num_(cfg.L1_MANAGER_ALERT_HOURS_AFTER_DUE, 1);
  const H2 = num_(cfg.L2_MANAGER_RECHECK_HOURS_AFTER_DUE, 5);
  const H3 = num_(cfg.L3_LEADERSHIP_HOURS_AFTER_DUE, 24);
  const t = readTable_(SHEETS.CYCLES);
  const freq = {};
  readTable_(SHEETS.TASKS).rows.forEach(function (x) { freq[x.TaskID] = Number(x.FrequencyDays); });
  const now = new Date(), n = now.getTime();
  const rem = {}, mgr = {}, lead = {};
  const add = function (g, to, item) { (g[to] = g[to] || []).push(item); };

  t.rows.filter(function (c) { return c.Status === 'OPEN'; }).forEach(function (c) {
    const due = new Date(c.DueAt).getTime();
    const mTo = c.ManagerEmail || cfg.MANAGER_EMAIL;
    // Flag is written BEFORE sending, so a second run can never re-send the same level.
    if (!c.L0Sent && freq[c.TaskID] > 1 && n >= due - H0 * HOUR_MS && n < due) {
      setCell_(t, c, 'L0Sent', now); add(rem, c.AssigneeEmail, { c: c, flag: 'L0Sent', lvl: 'Reminder', level: 0 });
    }
    if (!c.L1Sent && n >= due + H1 * HOUR_MS) {
      setCell_(t, c, 'L1Sent', now); add(mgr, mTo, { c: c, flag: 'L1Sent', lvl: 'L1 alert', level: 1 });
    }
    if (c.L1Sent && !c.L2Sent && !c.ManagerAckAt && n >= due + H2 * HOUR_MS) {
      setCell_(t, c, 'L2Sent', now); add(mgr, mTo, { c: c, flag: 'L2Sent', lvl: 'L2 re-check, not acknowledged', level: 2 });
    }
    if (!c.L3Sent && n >= due + H3 * HOUR_MS) {
      setCell_(t, c, 'L3Sent', now); add(lead, cfg.LEADERSHIP_EMAIL, { c: c, flag: 'L3Sent', lvl: 'L3 leadership escalation', level: 3 });
    }
  });

  let sent = 0;
  sent += sendDigest_(t, rem, 'Reminder: recurring task due soon', 'These tasks are due soon:', cfg);
  sent += sendDigest_(t, mgr, 'ACTION: pending recurring tasks', 'These tasks are not completed. Please acknowledge and follow up:', cfg);
  sent += sendDigest_(t, lead, 'ESCALATION: unresolved recurring tasks', 'These tasks remain unresolved beyond the SLA:', cfg);
  return sent;
}

/** One email per recipient per run (digest). On failure the flags are cleared so it retries next run. */
function sendDigest_(t, groups, subject, intro, cfg) {
  let sent = 0;
  Object.keys(groups).forEach(function (to) {
    const items = groups[to];
    if (!to) {
      items.forEach(function (i) { setCell_(t, i.c, i.flag, ''); });
      log_('EMAIL_SKIPPED', '', 'no recipient configured for ' + subject);
      return;
    }
    const lis = items.map(function (i) {
      const link = i.level ? ackLink_(cfg, i.c.CycleID, i.level) : '';
      return '<li><b>' + esc_(i.c.Assignee) + '</b>: ' + esc_(i.c.Task) + ' - due ' + fmt_(i.c.DueAt) +
        ' [' + i.lvl + ']' + (link ? ' - <a href="' + link + '">Acknowledge</a>' : '') + '</li>';
    }).join('');
    const foot = (cfg.WEBAPP_URL || !items[0].level) ? '' : '<p>Acknowledge in the Manager View sheet.</p>';
    try {
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: '<p>' + intro + '</p><ul>' + lis + '</ul>' + foot, name: 'Recurring Task Tracker' });
      sent++;
      items.forEach(function (i) { log_('EMAIL', i.c.CycleID, i.lvl + ' -> ' + to); });
    } catch (err) {
      items.forEach(function (i) { setCell_(t, i.c, i.flag, ''); });
      log_('EMAIL_FAILED', '', to + ' | ' + err.message);
    }
  });
  return sent;
}

/* ---------------- scheduler ---------------- */
function runScheduler_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_('RUN', '', 'skipped: another run in progress'); return { created: 0, emails: 0 }; }
  try {
    const created = generateCycles_();
    const emails = checkSLA_();
    refreshMyPending_(); refreshManagerView_();
    log_('RUN', '', 'created=' + created + ' emails=' + emails);
    return { created: created, emails: emails };
  } finally { lock.releaseLock(); }
}
function scheduledRun() { runScheduler_(); }
function runSchedulerNow() {
  const r = runScheduler_();
  SpreadsheetApp.getUi().alert('Scheduler finished.\nNew cycles created: ' + r.created + '\nEmails sent: ' + r.emails);
}

/* ---------------- views ---------------- */
function refreshViews() { refreshMyPending_(); refreshManagerView_(); }

function refreshMyPending_() {
  const sh = sh_(SHEETS.PENDING);
  const who = String(sh.getRange('B2').getValue() || 'ALL');
  const now = Date.now();
  const rows = readTable_(SHEETS.CYCLES).rows
    .filter(function (c) { return c.Status === 'OPEN' && (who === 'ALL' || c.Assignee === who); })
    .sort(function (a, b) { return new Date(a.DueAt) - new Date(b.DueAt); });
  sh.getRange('A' + MP_START + ':I500').clearContent().clearDataValidations();
  if (!rows.length) { sh.getRange('A' + MP_START).setValue('No pending tasks'); return; }
  const out = rows.map(function (c) {
    return [c.CycleID, c.Assignee, c.Task, new Date(c.DueAt),
      now > new Date(c.DueAt).getTime() ? 'OVERDUE' : 'PENDING',
      c.ProofType === 'TICKET' ? 'Ticket ID' : 'Tick Done', '', '', ''];
  });
  sh.getRange(MP_START, 1, out.length, 9).setValues(out);
  sh.getRange(MP_START, 8, out.length, 1).insertCheckboxes();
}

function refreshManagerView_() {
  const sh = sh_(SHEETS.MANAGER);
  const now = Date.now();
  const rows = readTable_(SHEETS.CYCLES).rows
    .filter(function (c) { return c.Status === 'OPEN'; })
    .sort(function (a, b) { return new Date(a.DueAt) - new Date(b.DueAt); });
  sh.getRange('A' + MV_START + ':I500').clearContent().clearDataValidations();
  if (!rows.length) { sh.getRange('A' + MV_START).setValue('No open tasks'); return; }
  const out = rows.map(function (c) {
    const due = new Date(c.DueAt).getTime();
    const level = c.L3Sent ? 3 : c.L2Sent ? 2 : c.L1Sent ? 1 : 0;
    return [c.CycleID, c.Assignee, c.Task, new Date(c.DueAt), now > due ? 'OVERDUE' : 'PENDING',
      Math.max(0, Math.round((now - due) / HOUR_MS * 10) / 10), level, !!c.ManagerAckAt, c.ManagerAckAt || ''];
  });
  const r = sh.getRange(MV_START, 1, out.length, 9);
  sh.getRange(MV_START, 8, out.length, 1).insertCheckboxes();
  r.setValues(out);
}

/* ---------------- edit handler (single point of update) ---------------- */
function onEditInstalled(e) {
  if (!e || !e.range) return;
  const rg = e.range, sh = rg.getSheet(), name = sh.getName(), r = rg.getRow(), c = rg.getColumn();
  if (rg.getNumRows() > 1 || rg.getNumColumns() > 1) return;

  if (name === SHEETS.PENDING) {
    if (r === 2 && c === 2) { refreshMyPending_(); return; }
    if (r < MP_START || (c !== 7 && c !== 8)) return;
    const id = String(sh.getRange(r, 1).getValue());
    if (!id || id.indexOf('-C') < 0) return;
    const ticket = String(sh.getRange(r, 7).getValue()).trim();
    const done = sh.getRange(r, 8).getValue() === true;
    if (c === 7 && !ticket) return;
    if (c === 8 && !done) return;
    const note = String(sh.getRange(r, 9).getValue() || '');
    const who = sh.getRange(r, 2).getValue();
    const email = (e.user && e.user.getEmail && e.user.getEmail()) || '';
    const res = completeCycle_(id, ticket, note, who + (email ? ' (' + email + ')' : ''));
    if (!res.ok && c === 8) sh.getRange(r, 8).setValue(false);
    refreshMyPending_(); refreshManagerView_();
    ss_().toast(res.msg, res.ok ? 'Saved' : 'Not saved', 8);
  } else if (name === SHEETS.MANAGER && c === 8 && r >= MV_START) {
    if (sh.getRange(r, 8).getValue() !== true) return;
    const id = String(sh.getRange(r, 1).getValue());
    const msg = ackCycle_(id, 'MANAGER');
    refreshManagerView_();
    ss_().toast(msg, 'Acknowledged', 8);
  }
}

/* ---------------- triggers ---------------- */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledRun').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss_()).onEdit().create();
  SpreadsheetApp.getUi().alert('Triggers installed: scheduler every 15 minutes + edit handler.');
}

/* ---------------- setup + demo data ---------------- */
function ensureSheet_(name, headers) {
  const s = sh_(name) || ss_().insertSheet(name);
  if (headers.length && s.getLastRow() === 0) {
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9e2f3');
    s.setFrozenRows(1);
  }
  return s;
}

function setupSystem() {
  const mgr = alias_('manager'), lead = alias_('leadership');
  const cfg = ensureSheet_(SHEETS.CONFIG, ['Key', 'Value', 'Notes']);
  if (cfg.getLastRow() < 2) {
    cfg.getRange(2, 1, 7, 3).setValues([
      ['L0_REMINDER_HOURS_BEFORE_DUE', 2, 'Employee reminder (skipped for daily tasks)'],
      ['L1_MANAGER_ALERT_HOURS_AFTER_DUE', 1, 'First manager email, same day, after 1h grace'],
      ['L2_MANAGER_RECHECK_HOURS_AFTER_DUE', 5, 'Re-check if manager has not acknowledged (L1 + 4h)'],
      ['L3_LEADERSHIP_HOURS_AFTER_DUE', 24, 'Leadership escalation if still open'],
      ['MANAGER_EMAIL', mgr, 'Fallback manager email'],
      ['LEADERSHIP_EMAIL', lead, 'Leadership email'],
      ['WEBAPP_URL', '', 'Paste the web app URL after Deploy (enables Acknowledge links)']]);
    cfg.autoResizeColumns(1, 3);
  }

  const users = ensureSheet_(SHEETS.USERS, USER_HEADERS);
  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 6, 4).setValues([
      ['Manager One', mgr, 'MANAGER', ''], ['Leadership One', lead, 'LEADERSHIP', ''],
      ['Employee A', alias_('empa'), 'EMPLOYEE', mgr], ['Employee B', alias_('empb'), 'EMPLOYEE', mgr],
      ['Employee C', alias_('empc'), 'EMPLOYEE', mgr], ['Employee D', alias_('empd'), 'EMPLOYEE', mgr]]);
  }

  const tasks = ensureSheet_(SHEETS.TASKS, TASK_HEADERS);
  tasks.getRange('G2:G200').setNumberFormat('@');
  tasks.getRange('H2:H200').setNumberFormat('yyyy-mm-dd');
  if (tasks.getLastRow() < 2) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + 1);
    const T = function (id, task, who, tag, f, proof) { return [id, task, who, alias_(tag), f, proof, '17:00', start, true]; };
    const seed = [
      T('T1', 'Daily Operations Update', 'Employee A', 'empa', 1, 'ACK'),
      T('T2', 'Portal Task A', 'Employee B', 'empb', 7, 'TICKET'),
      T('T3', 'Portal Task B', 'Employee C', 'empc', 15, 'TICKET'),
      T('T4', 'Portal Task C', 'Employee D', 'empd', 30, 'TICKET'),
      T('T5', 'TEST Overdue 2h (L1 demo)', 'Employee B', 'empb', 7, 'TICKET'),
      T('T6', 'TEST Overdue 26h (L3 demo)', 'Employee C', 'empc', 7, 'TICKET')];
    tasks.getRange(2, 1, seed.length, 9).setValues(seed);
    tasks.getRange(2, 9, seed.length, 1).insertCheckboxes();
    tasks.getRange(2, 9, seed.length, 1).setValue(true);
  }

  const cyc = ensureSheet_(SHEETS.CYCLES, CYCLE_HEADERS);
  ['H2:H2000', 'N2:N2000', 'O2:T2000'].forEach(function (a) { cyc.getRange(a).setNumberFormat('yyyy-mm-dd hh:mm'); });
  ensureSheet_(SHEETS.LOG, ['Timestamp', 'Type', 'CycleID', 'Detail']).getRange('A2:A5000').setNumberFormat('yyyy-mm-dd hh:mm:ss');

  // My Pending: the one place an employee works
  const mp = ensureSheet_(SHEETS.PENDING, []);
  mp.getRange('A1').setValue('MY PENDING TASKS - work from this sheet only').setFontWeight('bold').setFontSize(14);
  mp.getRange('A2').setValue('Employee:').setFontWeight('bold');
  mp.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['ALL', 'Employee A', 'Employee B', 'Employee C', 'Employee D'], true).build());
  if (!mp.getRange('B2').getValue()) mp.getRange('B2').setValue('ALL');
  mp.getRange('A3').setValue('Portal task: type the Ticket ID in the Ticket ID column. Daily task: tick Done (add a WhatsApp link in Note if you like). Nothing else to update.');
  mp.getRange('A4:I4').setValues([['CycleID', 'Employee', 'Task', 'Due', 'Status', 'Proof Required', 'Ticket ID', 'Done', 'Note / WhatsApp link']])
    .setFontWeight('bold').setBackground('#d9e2f3');
  mp.getRange('D5:D500').setNumberFormat('dd-mmm-yyyy hh:mm');
  mp.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OVERDUE')
    .setBackground('#f4c7c3').setRanges([mp.getRange('E5:E500')]).build()]);
  mp.setFrozenRows(4);

  // Manager View: summary (live formulas) + detail list with Acknowledge checkbox
  const mv = ensureSheet_(SHEETS.MANAGER, []);
  mv.getRange('A1').setValue('MANAGER VIEW - all team pending / overdue tasks').setFontWeight('bold').setFontSize(14);
  mv.getRange('A3:C3').setValues([['Employee', 'Open', 'Overdue']]).setFontWeight('bold').setBackground('#d9e2f3');
  const names = ['Employee A', 'Employee B', 'Employee C', 'Employee D'];
  names.forEach(function (nm, i) {
    const r = 4 + i;
    mv.getRange(r, 1).setValue(nm);
    mv.getRange(r, 2).setFormula('=COUNTIFS(Cycles!D:D,A' + r + ',Cycles!I:I,"OPEN")');
    mv.getRange(r, 3).setFormula('=COUNTIFS(Cycles!D:D,A' + r + ',Cycles!I:I,"OPEN",Cycles!H:H,"<"&NOW())');
  });
  mv.getRange('A' + (MV_START - 1) + ':I' + (MV_START - 1)).setValues([['CycleID', 'Employee', 'Task', 'Due',
    'Status', 'Hours overdue', 'Escalation level', 'Acknowledge', 'Acknowledged at']]).setFontWeight('bold').setBackground('#d9e2f3');
  mv.getRange('D' + MV_START + ':D500').setNumberFormat('dd-mmm-yyyy hh:mm');
  mv.getRange('I' + MV_START + ':I500').setNumberFormat('dd-mmm-yyyy hh:mm');
  mv.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OVERDUE')
    .setBackground('#f4c7c3').setRanges([mv.getRange('E' + MV_START + ':E500')]).build()]);

  const def = sh_('Sheet1');
  if (def && ss_().getSheets().length > 1) ss_().deleteSheet(def);
  generateCycles_();
  refreshViews();
  SpreadsheetApp.getUi().alert('Setup complete. Next: Task Tracker > 2. Install triggers.');
}

/** Test data for Tests 4-8: T5 is 2h overdue, T6 is 26h overdue, flags and acknowledgements reset. */
function makeOverdueDemo() {
  generateCycles_();
  const t = readTable_(SHEETS.CYCLES);
  const plan = { T5: 2, T6: 26 }, now = Date.now();
  t.rows.filter(function (c) { return c.Status === 'OPEN' && plan[c.TaskID]; }).forEach(function (c) {
    setCell_(t, c, 'DueAt', new Date(now - plan[c.TaskID] * HOUR_MS));
    ['L0Sent', 'L1Sent', 'L2Sent', 'L3Sent', 'ManagerAckAt', 'LeaderAckAt'].forEach(function (h) { setCell_(t, c, h, ''); });
  });
  refreshViews();
  SpreadsheetApp.getUi().alert('Demo ready: T5 is 2h overdue, T6 is 26h overdue.\nNow run "Run scheduler now" three times and watch the Log sheet.');
}
