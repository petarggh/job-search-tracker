// Runs the Apps Script files against small fakes of SpreadsheetApp, GmailApp, etc.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const HEADERS = ['Title', 'Company', 'Status?', 'Url', 'Url2', 'Resume', 'Cover Letter', 'Submitted Datetime', 'Rejection Datetime',
  'Prescreen Datetime', 'First Interview Datetime', 'Second Interview Datetime', 'Third Interview Datetime', 'Source', 'Company Type',
  'Fit', 'Pay Min', 'Pay Max', 'Days to Response', 'Days Waiting', 'Notes', 'date'];

function fakeSheet(name, rows) {
  const grid = rows; // array of arrays; formulas stored as {f: '...'}
  const sh = {
    name,
    getLastRow: () => { let n = grid.length; while (n > 0 && grid[n - 1].every(c => c === '' || (c && c.f))) n--; return Math.max(n, 1); },
    getLastColumn: () => Math.max(...grid.map(r => r.length)),
    appendRow: (r) => grid.push(r.slice()),
    setFrozenRows() {}, getRange(a, b, c, d) {
      if (typeof a === 'string') return { setNumberFormat() {} };
      const r0 = a - 1, c0 = b - 1, nr = c || 1, nc = d || 1;
      const ensure = () => { while (grid.length < r0 + nr) grid.push(new Array(HEADERS.length).fill('')); };
      return {
        getValues: () => { ensure(); return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = grid[r0 + i][c0 + j]; return v && v.f ? '' : (v === undefined ? '' : v); })); },
        getValue: () => { ensure(); const v = grid[r0][c0]; return v && v.f ? '' : (v === undefined ? '' : v); },
        setValue: (v) => { ensure(); grid[r0][c0] = v; },
        getFormula: () => { ensure(); const v = grid[r0][c0]; return v && v.f ? v.f : ''; },
        copyTo: (dest) => { ensure(); dest._set(grid[r0][c0]); },
        _set: (v) => { ensure(); grid[r0][c0] = v; }
      };
    }
  };
  return sh;
}

function load(dataRows, messages) {
  const sheets = { data: fakeSheet('data', dataRows) };
  const props = {};
  const sent = [];
  const ctx = {
    console, Date, JSON, Math,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = fakeSheet(n, []))
      }),
      CopyPasteType: { PASTE_FORMULA: 'f' }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getUserProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'peter@example.com' }) },
    GmailApp: { search: () => [{ getMessages: () => messages || [] }] },
    MailApp: { sendEmail: (o) => sent.push(o) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/app' }), WeekDay: { MONDAY: 'MONDAY' } }
  };
  vm.createContext(ctx);
  for (const f of ['Config', 'Logic', 'Sheet', 'Gmail', 'Nudges', 'Code']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f + '.js'), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sheets, sent };
}

function row(fields) {
  const r = new Array(HEADERS.length).fill('');
  Object.entries(fields).forEach(([h, v]) => { r[HEADERS.indexOf(h)] = v; });
  return r;
}
const formulas = () => ({ 'Days to Response': { f: '=dtr' }, 'Days Waiting': { f: '=dw' }, 'date': { f: '=d' } });

function baseRows() {
  return [HEADERS.slice(),
    row({ Title: 'Senior Product Manager', Company: 'Vetcove', 'Status?': 'Applied - no Ack', 'Submitted Datetime': new Date('2026-11-17T21:41:00'), ...formulas() }),
    row({ Title: 'Staff Product Manager', Company: 'GoodParty.org', 'Status?': 'Applied - no Ack', 'Submitted Datetime': new Date('2026-11-17T23:07:00'), 'Company Type': 'PBC', ...formulas() }),
    row({ ...formulas() }), row({ ...formulas() })];
}

const msg = (id, from, subject, body, date) => ({ getId: () => id, getFrom: () => from, getSubject: () => subject, getPlainBody: () => body, getDate: () => new Date(date) });

test('reads applications and skips empty pre-filled rows', () => {
  const { ctx } = load(baseRows());
  const apps = ctx.readApplications();
  assert.strictEqual(apps.length, 2);
  assert.strictEqual(apps[1].company, 'GoodParty.org');
  assert.strictEqual(apps[1].row, 3);
  assert.match(apps[0].submitted, /^2026-11-1/);
});

test('appends into the first empty table row without touching formulas', () => {
  const rows = baseRows();
  const { ctx } = load(rows);
  const r = ctx.apiLogApplication({ title: 'Senior PM', company: 'Help Scout', payMin: '150000', payMax: '164000', companyType: 'B Corp + PBC' });
  assert.strictEqual(r, 4);
  assert.strictEqual(rows[3][1], 'Help Scout');
  assert.strictEqual(rows[3][2], 'Applied - no Ack');
  assert.strictEqual(rows[3][HEADERS.indexOf('Pay Min')], 150000);
  assert.deepStrictEqual(rows[3][HEADERS.indexOf('Days Waiting')], { f: '=dw' });
});

test('copies formulas down when writing past the pre-filled rows', () => {
  const rows = baseRows().slice(0, 3); // no spare rows
  const { ctx } = load(rows);
  const r = ctx.apiLogApplication({ title: 'PM', company: 'Benevity' });
  assert.strictEqual(r, 4);
  assert.deepStrictEqual(rows[3][HEADERS.indexOf('date')], { f: '=d' });
});

test('refuses to update a row whose company changed', () => {
  const { ctx } = load(baseRows());
  assert.throws(() => ctx.updateApplication(2, 'GoodParty.org', { status: 'x' }), /now holds "Vetcove"/);
});

test('Gmail sync: ack, then rejection, logs to activity, and skips already-processed mail', () => {
  const rows = baseRows();
  const messages = [
    msg('m2', 'no-reply@ashbyhq.com', 'Update on your GoodParty.org application', 'Unfortunately, we have decided to move forward with other candidates.', '2026-11-20T09:00:00'),
    msg('m1', 'no-reply@ashbyhq.com', 'Thank you for applying to GoodParty.org', 'We have received your application.', '2026-11-18T08:00:00'),
    msg('m3', 'news@substack.com', 'Weekly digest', 'Articles', '2026-11-19T08:00:00')
  ];
  const { ctx, sheets } = load(rows, messages);
  ctx.CONFIG.GMAIL.DRY_RUN = false;
  const out = ctx.syncGmail();
  assert.strictEqual(out.changes.length, 2);
  assert.deepStrictEqual(Array.from(out.changes, c => c.to), ['Applied - Email Ack', 'Rejection First Contact']);
  assert.strictEqual(out.changes[1].from, 'Applied - Email Ack');
  assert.strictEqual(rows[2][2], 'Rejection First Contact');
  assert.ok(rows[2][HEADERS.indexOf('Rejection Datetime')] instanceof Date);
  assert.strictEqual(rows[1][2], 'Applied - no Ack'); // Vetcove untouched
  assert.ok(sheets.activity, 'activity tab created');
  const again = ctx.syncGmail();
  assert.strictEqual(again.scanned, 0);
});

test('Gmail sync dry run changes nothing and does not mark mail as processed', () => {
  const rows = baseRows();
  const messages = [msg('m1', 'no-reply@ashbyhq.com', 'Thank you for applying to GoodParty.org', 'We have received your application.', '2026-11-18T08:00:00')];
  const { ctx } = load(rows, messages);
  ctx.CONFIG.GMAIL.DRY_RUN = true;
  assert.strictEqual(ctx.syncGmail().changes.length, 1);
  assert.strictEqual(rows[2][2], 'Applied - no Ack');
  ctx.CONFIG.GMAIL.DRY_RUN = false;
  const live = ctx.syncGmail();
  assert.strictEqual(live.scanned, 1);
  assert.strictEqual(rows[2][2], 'Applied - Email Ack');
});

test('follow-up digest emails only when something is overdue', () => {
  const rows = baseRows();
  rows[1][HEADERS.indexOf('Submitted Datetime')] = new Date(Date.now() - 20 * 86400000);
  rows[2][HEADERS.indexOf('Submitted Datetime')] = new Date(Date.now() - 40 * 86400000);
  const { ctx, sent } = load(rows);
  const r = ctx.sendFollowUpDigest();
  assert.strictEqual(r.count, 2);
  assert.match(sent[0].subject, /2 applications/);
  assert.match(sent[0].htmlBody, /Likely ghosted/);
});

test('apiGetData returns everything the page needs', () => {
  const { ctx } = load(baseRows());
  const d = ctx.apiGetData();
  assert.strictEqual(d.apps.length, 2);
  assert.ok(Array.isArray(d.sankey) && d.sankey.length > 0);
  assert.ok(d.statuses.includes('Rejection after Email'));
});
