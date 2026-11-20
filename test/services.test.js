// Runs the Apps Script files against small fakes of SpreadsheetApp, GmailApp, etc.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const HEADERS = ['Title', 'Company', 'Status?', 'Url', 'Url2', 'Resume', 'Cover Letter', 'Submitted Datetime', 'Rejection Datetime',
  'Prescreen Datetime', 'First Interview Datetime', 'Second Interview Datetime', 'Third Interview Datetime', 'Source', 'Company Type',
  'Fit', 'Pay Min', 'Pay Max', 'Days to Response', 'Days Waiting', 'Notes', 'date'];

let HEADERS_IN_USE = HEADERS;
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
      const ensure = () => { while (grid.length < r0 + nr) grid.push(new Array(HEADERS_IN_USE.length).fill('')); };
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

function load(dataRows, messages, extra) {
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
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  for (const f of ['Config', 'Logic', 'Sheet', 'Posting', 'Gmail', 'Nudges', 'Code']) {
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
  assert.strictEqual(r.row, 4);
  assert.strictEqual(rows[3][1], 'Help Scout');
  assert.strictEqual(rows[3][2], 'Applied - no Ack');
  assert.strictEqual(rows[3][HEADERS.indexOf('Pay Min')], 150000);
  assert.deepStrictEqual(rows[3][HEADERS.indexOf('Days Waiting')], { f: '=dw' });
});

test('copies formulas down when writing past the pre-filled rows', () => {
  const rows = baseRows().slice(0, 3); // no spare rows
  const { ctx } = load(rows);
  const r = ctx.apiLogApplication({ title: 'PM', company: 'Benevity' });
  assert.strictEqual(r.row, 4);
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
  const logRow = sheets.activity.getRange(2, 1, 1, 6).getValues()[0];
  assert.strictEqual(sheets.activity.getRange(1, 6).getValue(), 'Email excerpt');
  assert.ok(logRow[4] instanceof Date, 'email date logged');
  assert.strictEqual(logRow[5], 'We have received your application.');
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

test('duplicate application is held for confirmation, then saved', () => {
  const rows = baseRows();
  const { ctx } = load(rows);
  const r = ctx.apiLogApplication({ title: 'Staff Product Manager', company: 'GoodParty.org' });
  assert.strictEqual(r.duplicates.length, 1);
  assert.strictEqual(r.duplicates[0].sameRole, true);
  assert.strictEqual(rows[3][1], '', 'nothing written yet');
  const ok = ctx.apiLogApplication({ title: 'Staff Product Manager', company: 'GoodParty.org', confirmDuplicate: true });
  assert.strictEqual(ok.row, 4);
});

// Sheet with the optional Posting Doc and Contacts columns added at the end.
const WIDE = HEADERS.concat(['Posting Doc', 'Contacts']);
function wideRows() {
  return baseRows().map((r, i) => i === 0 ? WIDE.slice() : r.concat(['', '']));
}

test('Gmail sync adds a human sender to Contacts, but not no-reply senders', () => {
  HEADERS_IN_USE = WIDE;
  const rows = wideRows();
  const messages = [
    msg('m1', 'no-reply@ashbyhq.com', 'Thank you for applying to GoodParty.org', 'We have received your application.', '2026-11-18T08:00:00'),
    msg('m2', 'Dana Lee <dana@goodparty.org>', 'GoodParty.org next steps', 'Would love to chat. What is your availability?', '2026-11-19T08:00:00')
  ];
  const { ctx } = load(rows, messages);
  ctx.CONFIG.GMAIL.DRY_RUN = false;
  ctx.syncGmail();
  assert.strictEqual(rows[2][WIDE.indexOf('Contacts')], 'Dana Lee <dana@goodparty.org>');
  assert.strictEqual(rows[2][2], 'Email Thread');
  HEADERS_IN_USE = HEADERS;
});

test('offer-stage emails are logged, not applied', () => {
  const rows = baseRows();
  rows[2][2] = 'Offer Received';
  const messages = [msg('m1', 'no-reply@ashbyhq.com', 'Your GoodParty.org application', 'Unfortunately we cannot proceed.', '2026-11-19T08:00:00')];
  const { ctx, sheets } = load(rows, messages);
  ctx.CONFIG.GMAIL.DRY_RUN = false;
  ctx.syncGmail();
  assert.strictEqual(rows[2][2], 'Offer Received');
  assert.match(sheets.activity.getRange(2, 2).getValue(), /offer stage/);
});

test('logging with a URL saves the posting to a Doc and links it', () => {
  HEADERS_IN_USE = WIDE;
  const rows = wideRows();
  const docs = [], created = [];
  const fakeDoc = (name) => {
    const paras = [];
    // Matches Apps Script: setText returns nothing; setHeading returns the paragraph.
    const para = (t) => { const p = { t, setHeading: () => p, setText: (x) => { p.t = x; } }; paras.push(p); return p; };
    para('');
    const d = { name, paras, getBody: () => ({ getParagraphs: () => paras, appendParagraph: para }), saveAndClose() {}, getId: () => 'doc1', getUrl: () => 'https://docs.google.com/document/d/doc1' };
    docs.push(d); return d;
  };
  const gh = { title: 'Senior PM', company_name: 'Help Scout', location: { name: 'Remote' },
    content: '&lt;p&gt;' + 'You will own the roadmap for our help desk product. '.repeat(10) + '&lt;/p&gt;&lt;ul&gt;&lt;li&gt;5+ years&lt;/li&gt;&lt;/ul&gt;' };
  const { ctx } = load(rows, [], {
    DocumentApp: { openById: (id) => fakeDoc(created.find(f => f.id === id).name), ParagraphHeading: { HEADING1: 'H1' } },
    Drive: { Files: {
      create: (f) => { const id = f.mimeType.endsWith('folder') ? 'folder1' : 'doc1'; created.push({ id, ...f }); return { id }; },
      get: () => ({ trashed: false })
    } },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(gh) }) },
    Utilities: { formatDate: () => 'Nov 19, 2026' }
  });
  ctx.Session.getScriptTimeZone = () => 'America/Los_Angeles';
  const r = ctx.apiLogApplication({ title: 'Senior PM', company: 'Help Scout', url: 'https://job-boards.greenhouse.io/helpscout/jobs/123', savePosting: true });
  assert.strictEqual(r.postingDoc, 'https://docs.google.com/document/d/doc1');
  assert.strictEqual(rows[3][WIDE.indexOf('Posting Doc')], 'https://docs.google.com/document/d/doc1');
  assert.strictEqual(docs[0].name, 'Posting - Help Scout - Senior PM');
  assert.ok(docs[0].paras.some(p => /^• 5\+ years$/.test(p.t)), 'bullets kept');
  assert.strictEqual(JSON.stringify(created.map(f => [f.name, f.parents || null])), JSON.stringify([['Job Postings (tracker)', null], ['Posting - Help Scout - Senior PM', ['folder1']]]));
  HEADERS_IN_USE = HEADERS;
});

test('apiGetData includes response-rate breakdowns by resume', () => {
  const rows = baseRows();
  rows[1][HEADERS.indexOf('Resume')] = 'Resume-A';
  rows[2][HEADERS.indexOf('Resume')] = 'Resume-B';
  rows[2][2] = 'Email Thread';
  const { ctx } = load(rows);
  const d = ctx.apiGetData();
  const b = d.breakdowns.resume.rows.find(r => r.label === 'Resume-B');
  assert.strictEqual(b.applied, 1);
  assert.strictEqual(b.human, 1);
  assert.strictEqual(d.hasPostingDoc, false);
});
