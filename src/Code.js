/**
 * Web app entry point, server functions the page calls, the sheet menu, and triggers.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Job Search Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Job Tracker')
    .addItem('Sync Gmail now', 'menuSyncGmail')
    .addItem('Send follow-up digest now', 'menuSendDigest')
    .addSeparator()
    .addItem('Install hourly Gmail sync + weekly digest', 'installTriggers')
    .addItem('Remove triggers', 'removeTriggers')
    .addSeparator()
    .addItem('Forget processed emails (re-scan)', 'menuForgetProcessed')
    .addToUi();
}

function menuSyncGmail() {
  var r = syncGmail();
  SpreadsheetApp.getUi().alert('Scanned ' + r.scanned + ' new emails. ' + r.changes.length + ' application(s) updated. Details are in the "' + CONFIG.ACTIVITY_TAB + '" tab.');
}

function menuForgetProcessed() {
  PropertiesService.getUserProperties().deleteProperty(PROCESSED_KEY);
  SpreadsheetApp.getUi().alert('Done. The next sync re-reads the last ' + CONFIG.GMAIL.LOOKBACK_DAYS + ' days of email.');
}

function menuSendDigest() {
  var r = sendFollowUpDigest();
  SpreadsheetApp.getUi().alert(r.sent ? 'Sent a digest covering ' + r.count + ' application(s).' : 'Nothing needs a follow-up right now.');
}

var TRIGGER_HANDLERS = ['syncGmail', 'sendFollowUpDigest'];

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
}

function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncGmail').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('sendFollowUpDigest').timeBased()
    .onWeekDay(CONFIG.NUDGE.DIGEST_WEEKDAY).atHour(CONFIG.NUDGE.DIGEST_HOUR).create();
  logActivity('Installed triggers', '', 'Gmail sync hourly; digest weekly');
}

// ---------- Called from the web page with google.script.run ----------

function apiGetData() {
  var apps = readApplications();
  var now = new Date();
  return {
    apps: apps,
    sankey: sankeyEdges(apps, now),
    followUps: followUps(apps, now, CONFIG.NUDGE.FOLLOW_UP_DAYS, CONFIG.NUDGE.GHOST_DAYS),
    activity: readActivity(15),
    statuses: Object.keys(STATUS).map(function (k) { return STATUS[k]; }),
    now: now.toISOString(),
    defaultResume: CONFIG.DEFAULT_RESUME
  };
}

function apiLookupPosting(url) {
  return lookupPosting(url);
}

/** Only called after Peter has applied: the form defaults Submitted to now. */
function apiLogApplication(form) {
  if (!form || !form.company || !form.title) throw new Error('Company and title are required.');
  var fields = {
    title: form.title, company: form.company, status: form.status || STATUS.NO_ACK,
    url: form.url || '', resume: form.resume || CONFIG.DEFAULT_RESUME, coverLetter: form.coverLetter || '',
    submitted: form.submitted ? new Date(form.submitted) : new Date(),
    source: form.source || '', companyType: form.companyType || '', fit: form.fit || '',
    payMin: form.payMin ? Number(form.payMin) : '', payMax: form.payMax ? Number(form.payMax) : '',
    notes: form.notes || ''
  };
  return appendApplication(fields);
}

/** Changes status, and fills the matching date column if one is given. */
function apiUpdateStatus(row, company, status, dateField, dateValue) {
  var fields = { status: status };
  var allowed = ['rejected', 'prescreen', 'interview1', 'interview2', 'interview3'];
  if (dateField && allowed.indexOf(dateField) >= 0) fields[dateField] = dateValue ? new Date(dateValue) : new Date();
  updateApplication(row, company, fields);
  logActivity('Status changed in app', company, status + (dateField ? ' (' + dateField + ')' : ''));
  return true;
}
