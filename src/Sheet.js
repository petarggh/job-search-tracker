/**
 * Reading and writing the data tab. Columns are located by header name.
 */

function getSpreadsheet_() {
  return CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getDataSheet_() {
  var sh = getSpreadsheet_().getSheetByName(CONFIG.DATA_TAB);
  if (!sh) throw new Error('No tab named "' + CONFIG.DATA_TAB + '". Check CONFIG.DATA_TAB.');
  return sh;
}

/** Map of field name -> 1-based column number, from the header row. */
function columnMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var byHeader = {};
  headers.forEach(function (h, i) { byHeader[String(h).trim()] = i + 1; });
  var map = {};
  Object.keys(CONFIG.HEADERS).forEach(function (field) {
    var col = byHeader[CONFIG.HEADERS[field]];
    if (!col) throw new Error('Header "' + CONFIG.HEADERS[field] + '" not found in the data tab.');
    map[field] = col;
  });
  map._byHeader = byHeader;
  return map;
}

function toIso_(v) {
  return (v instanceof Date) ? v.toISOString() : (v === '' ? null : v);
}

/** All applications with a company name, as plain objects (dates as ISO strings). */
function readApplications() {
  var sh = getDataSheet_();
  var map = columnMap_(sh);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var apps = [];
  values.forEach(function (row, i) {
    var app = { row: i + 2 };
    Object.keys(CONFIG.HEADERS).forEach(function (f) { app[f] = toIso_(row[map[f] - 1]); });
    if (app.company) apps.push(app);
  });
  return apps;
}

/** First row with no company, which keeps new rows inside the existing table. */
function firstEmptyRow_(sh, map) {
  var last = Math.max(sh.getLastRow(), 2);
  var companies = sh.getRange(2, map.company, last - 1, 1).getValues();
  for (var i = 0; i < companies.length; i++) {
    if (companies[i][0] === '') return i + 2;
  }
  return last + 1;
}

/** Makes sure the formula columns have formulas in this row, copying from the row above. */
function ensureFormulas_(sh, map, row) {
  CONFIG.FORMULA_HEADERS.forEach(function (h) {
    var col = map._byHeader[h];
    if (!col || row < 3) return;
    var cell = sh.getRange(row, col);
    if (!cell.getFormula()) sh.getRange(row - 1, col).copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  });
}

/** Writes only the given fields into the row, leaving formulas and other cells alone. */
function writeFields_(sh, map, row, fields) {
  Object.keys(fields).forEach(function (f) {
    if (!map[f] || fields[f] === undefined) return;
    var v = fields[f];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = new Date(v);
    sh.getRange(row, map[f]).setValue(v === null ? '' : v);
  });
}

/** Adds an application. Returns the row number. */
function appendApplication(fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getDataSheet_();
    var map = columnMap_(sh);
    var row = firstEmptyRow_(sh, map);
    writeFields_(sh, map, row, fields);
    ensureFormulas_(sh, map, row);
    logActivity('Logged application', fields.company, fields.title || '');
    return row;
  } finally {
    lock.releaseLock();
  }
}

/** Updates fields on an existing row. Refuses if the company in that row has changed. */
function updateApplication(row, expectedCompany, fields) {
  var sh = getDataSheet_();
  var map = columnMap_(sh);
  var actual = sh.getRange(row, map.company).getValue();
  if (String(actual) !== String(expectedCompany)) {
    throw new Error('Row ' + row + ' now holds "' + actual + '", not "' + expectedCompany + '". Reload and try again.');
  }
  writeFields_(sh, map, row, fields);
}

/** Append-only audit log of everything the app changes. */
function logActivity(action, company, detail) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.ACTIVITY_TAB);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.ACTIVITY_TAB);
    sh.appendRow(['When', 'Action', 'Company', 'Detail']);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('M/d/yyyy H:mm');
  }
  sh.appendRow([new Date(), action, company || '', detail || '']);
}

function readActivity(limit) {
  var sh = getSpreadsheet_().getSheetByName(CONFIG.ACTIVITY_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var n = Math.min(limit || 25, sh.getLastRow() - 1);
  return sh.getRange(sh.getLastRow() - n + 1, 1, n, 4).getValues().reverse().map(function (r) {
    return { when: toIso_(r[0]), action: r[1], company: r[2], detail: r[3] };
  });
}
