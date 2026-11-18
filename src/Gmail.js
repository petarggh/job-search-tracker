/**
 * Reads recent email, finds acknowledgements, rejections and interview invites,
 * and updates the matching application. Every change is written to the activity tab.
 */

var PROCESSED_KEY = 'processedMessageIds';
var PROCESSED_CAP = 1500;

function loadProcessed_() {
  var raw = PropertiesService.getUserProperties().getProperty(PROCESSED_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveProcessed_(ids) {
  PropertiesService.getUserProperties().setProperty(PROCESSED_KEY, JSON.stringify(ids.slice(-PROCESSED_CAP)));
}

/** Runs on a timer, and from the sheet menu. Returns a summary of what changed. */
function syncGmail() {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var processed = loadProcessed_();
  var seen = {};
  processed.forEach(function (id) { seen[id] = true; });

  var query = 'newer_than:' + CONFIG.GMAIL.LOOKBACK_DAYS + 'd ' + CONFIG.GMAIL.EXTRA_QUERY;
  var messages = [];
  GmailApp.search(query, 0, CONFIG.GMAIL.MAX_THREADS).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (!seen[m.getId()] && m.getFrom().toLowerCase().indexOf(me) < 0) messages.push(m);
    });
  });
  messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

  var apps = readApplications();
  var changes = [];
  messages.forEach(function (m) {
    processed.push(m.getId());
    var subject = m.getSubject();
    var body = m.getPlainBody();
    var event = classifyEmail(subject, body);
    if (!event) return;

    var i = matchApplication(apps, { from: m.getFrom(), subject: subject, body: body });
    if (i < 0) {
      logActivity('Unmatched ' + event + ' email', '', subject + ' (from ' + m.getFrom() + ')');
      return;
    }
    var app = apps[i];
    var status = nextStatus(app.status, event);
    if (!status) return;

    var fields = { status: status };
    if (event === 'rejection' && !app.rejected) fields.rejected = m.getDate();
    var detail = app.status + ' -> ' + status + ' (email: "' + subject + '")';
    if (event === 'interview') detail += '. Schedule it, then add the date in the sheet.';

    var previous = app.status;
    if (CONFIG.GMAIL.DRY_RUN) {
      logActivity('Would update (dry run)', app.company, detail);
    } else {
      try {
        updateApplication(app.row, app.company, fields);
      } catch (e) {
        logActivity('Skipped email update', app.company, e.message);
        return;
      }
      logActivity('Auto-updated from email', app.company, detail);
      app.status = status;
      if (fields.rejected) app.rejected = fields.rejected.toISOString();
    }
    changes.push({ company: app.company, from: previous, to: status, subject: subject });
  });

  // In dry run, leave mail unprocessed so the live run still sees it.
  if (!CONFIG.GMAIL.DRY_RUN) saveProcessed_(processed);
  return { scanned: messages.length, changes: changes };
}
