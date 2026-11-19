/**
 * Pure logic with no Google services, so it can be unit-tested in Node.
 */

var STATUS = {
  NO_ACK: 'Applied - no Ack',
  ACK: 'Applied - Email Ack',
  THREAD: 'Email Thread',
  PRESCREEN: 'Pre-Screen Scheduled',
  INTERVIEW: 'Interview Scheduled',
  FIRST_DONE: 'First interview done',
  SECOND_DONE: 'Second Interview Done',
  REJ_FIRST: 'Rejection First Contact',
  REJ_EMAIL: 'Rejection after Email',
  REJ_FINAL: 'Rejection after final interview',
  CLOSED: 'Job Closed - No Rejection'
};

var STAGE_RANK = {};
STAGE_RANK[STATUS.NO_ACK] = 0;
STAGE_RANK[STATUS.ACK] = 1;
STAGE_RANK[STATUS.THREAD] = 2;
STAGE_RANK[STATUS.PRESCREEN] = 3;
STAGE_RANK[STATUS.INTERVIEW] = 4;
STAGE_RANK[STATUS.FIRST_DONE] = 5;
STAGE_RANK[STATUS.SECOND_DONE] = 6;

function isClosedStatus(status) {
  return /^Reject/i.test(status || '') || /^Job Closed/i.test(status || '');
}

// ---------- Email classification ----------

var EMAIL_RULES = [
  { type: 'rejection', patterns: [
    /not (?:be )?moving forward/i, /decided (?:not )?to (?:move|proceed) forward with (?:other|another)/i,
    /(?:pursue|move forward with) other candidates/i, /unfortunately/i, /will not be (?:moving|proceeding)/i,
    /not (?:selected|a fit|the right fit)/i, /position has been filled/i, /no longer (?:being )?considered/i,
    /regret to inform/i, /decided to go (?:in a )?(?:different|another) direction/i ] },
  { type: 'interview', patterns: [
    /schedule (?:a |an |some )?(?:time|call|chat|interview|conversation)/i, /your availability/i,
    /calendly\.com|goodtime\.io|cal\.com|ashbyhq\.com\/.*schedul/i, /invite you to (?:an? )?(?:interview|call|chat)/i,
    /next steps? (?:in|of) (?:the|our) (?:interview|hiring) process/i, /phone screen|recruiter screen|pre-?screen/i,
    /would love to (?:chat|talk|connect|speak)/i ] },
  { type: 'ack', patterns: [
    /(?:thank you|thanks) for (?:your )?(?:applying|application|interest)/i, /(?:we(?:['’]ve| have)|has been) (?:\w+ )?received your application/i,
    /application (?:has been )?(?:received|submitted)/i, /confirm(?:ing)? (?:receipt|we received)/i ] }
];

/** Short plain-text excerpt of an email body for the activity log: links dropped, whitespace collapsed. */
function emailExcerpt(body, max) {
  max = max || 1500;
  var t = String(body || '').replace(/<?https?:\/\/\S+>?/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Returns 'rejection' | 'interview' | 'ack' | null. Rejection wins over the others. */
function classifyEmail(subject, body) {
  // Plain-text emails wrap mid-sentence. Join wrapped lines; keep blank-line paragraph breaks.
  var flat = (body || '').slice(0, 6000).replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*\n\s*/g, '\u0000').replace(/\s+/g, ' ').replace(/\u0000/g, '\n');
  var text = (subject || '') + '\n' + flat;
  // Acks often say "if we decide not to move forward, we'll let you know".
  // Drop conditional sentences before looking for rejection language, plus
  // "we're unfortunately unable to send individual rejection emails" disclaimers.
  var definite = text.split(/(?<=[.!?\n])\s+/).filter(function (s) {
    return !/\b(if|should|in the event|whether)\b/i.test(s) &&
      !/\b(?:unable|not able|can(?:no|['’])t)\b.{0,40}\b(?:send|respond|reply|provide|contact)\b/i.test(s);
  }).join(' ');
  for (var i = 0; i < EMAIL_RULES.length; i++) {
    var rule = EMAIL_RULES[i];
    var haystack = rule.type === 'rejection' ? definite : text;
    for (var j = 0; j < rule.patterns.length; j++) {
      if (rule.patterns[j].test(haystack)) return rule.type;
    }
  }
  return null;
}

/**
 * Given the current status and an email event, returns the new status, or null for no change.
 * Never moves an application backwards, and never reopens a closed one.
 */
function nextStatus(current, event) {
  current = current || STATUS.NO_ACK;
  if (isClosedStatus(current)) return null;
  var rank = STAGE_RANK.hasOwnProperty(current) ? STAGE_RANK[current] : 0;
  if (event === 'ack') return current === STATUS.NO_ACK ? STATUS.ACK : null;
  if (event === 'interview') return rank < STAGE_RANK[STATUS.THREAD] ? STATUS.THREAD : null;
  if (event === 'rejection') {
    if (rank >= STAGE_RANK[STATUS.INTERVIEW]) return STATUS.REJ_FINAL;
    if (rank >= STAGE_RANK[STATUS.THREAD]) return STATUS.REJ_EMAIL;
    return STATUS.REJ_FIRST;
  }
  return null;
}

// ---------- Matching emails to applications ----------

var COMPANY_STOPWORDS = /\b(inc|llc|ltd|corp|co|pbc|the|labs?|technologies|technology|software|systems|group|hq|ai)\b/g;

function companyKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\.(org|com|io|ai|co|net|app)\b/g, '')
    .replace(COMPANY_STOPWORDS, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Finds which application an email belongs to.
 * msg: {from, subject, body}. apps: [{company, ...}].
 * Returns the matching app's index, or -1 if none or more than one match.
 */
function matchApplication(apps, msg) {
  var from = String(msg.from || '').toLowerCase();
  var fromKey = from.replace(/[^a-z0-9]/g, '');
  var subjectKey = String(msg.subject || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var bodyKey = String(msg.body || '').slice(0, 3000).toLowerCase().replace(/[^a-z0-9]/g, '');
  var strong = [], weak = [];
  apps.forEach(function (app, i) {
    var key = companyKey(app.company);
    if (key.length < 3) return;
    if (fromKey.indexOf(key) >= 0 || subjectKey.indexOf(key) >= 0) strong.push(i);
    else if (bodyKey.indexOf(key) >= 0) weak.push(i);
  });
  if (strong.length === 1) return strong[0];
  if (strong.length === 0 && weak.length === 1) return weak[0];
  return -1;
}

// ---------- Job posting URLs ----------

/** Identifies the applicant tracking system and IDs from a posting or application URL. */
function parsePostingUrl(url) {
  var u = String(url || '').trim();
  var m;
  if ((m = u.match(/jobs\.ashbyhq\.com\/([^\/?#]+)\/([0-9a-f-]{36})/i))) return { ats: 'ashby', org: decodeURIComponent(m[1]), id: m[2] };
  if ((m = u.match(/(?:job-boards|boards)\.(?:eu\.)?greenhouse\.io\/([^\/?#]+)\/jobs\/(\d+)/i))) return { ats: 'greenhouse', org: m[1], id: m[2] };
  if ((m = u.match(/[?&]gh_jid=(\d+)/i))) return { ats: 'greenhouse-embed', org: null, id: m[1] };
  if ((m = u.match(/jobs\.(?:eu\.)?lever\.co\/([^\/?#]+)\/([0-9a-f-]{36})/i))) return { ats: 'lever', org: m[1], id: m[2] };
  return { ats: 'generic', org: null, id: null };
}

function titleCaseSlug(slug) {
  return String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function emptyPosting() {
  return { title: '', company: '', payMin: null, payMax: null, location: '', remote: null };
}

function fromAshby(boardJson, id, pageTitle) {
  var p = emptyPosting();
  var job = (boardJson && boardJson.jobs || []).filter(function (j) { return j.id === id; })[0];
  // Ashby page titles look like "Staff Product Manager @ GoodParty.org".
  var tm = String(pageTitle || '').match(/^(.*?)\s+@\s+(.+)$/);
  if (tm) { p.title = tm[1].trim(); p.company = tm[2].trim(); }
  if (job) {
    p.title = job.title || p.title;
    p.location = job.location || '';
    p.remote = job.isRemote === true || /remote/i.test(job.location || '');
    var comps = (job.compensation && job.compensation.summaryComponents) || [];
    var salary = comps.filter(function (c) { return /salary/i.test(c.compensationType || ''); })[0];
    if (salary) { p.payMin = salary.minValue || null; p.payMax = salary.maxValue || null; }
  }
  return p;
}

function fromGreenhouse(job, org) {
  var p = emptyPosting();
  if (!job) return p;
  p.title = job.title || '';
  p.company = job.company_name || titleCaseSlug(org);
  p.location = (job.location && job.location.name) || '';
  p.remote = /remote/i.test(p.location);
  var r = (job.pay_input_ranges || [])[0];
  if (r) { p.payMin = r.min_cents ? r.min_cents / 100 : null; p.payMax = r.max_cents ? r.max_cents / 100 : null; }
  return p;
}

function fromLever(job, org) {
  var p = emptyPosting();
  if (!job) return p;
  p.title = job.text || '';
  p.company = titleCaseSlug(org);
  p.location = (job.categories && job.categories.location) || '';
  p.remote = job.workplaceType === 'remote' || /remote/i.test(p.location);
  if (job.salaryRange) { p.payMin = job.salaryRange.min || null; p.payMax = job.salaryRange.max || null; }
  return p;
}

/** Reads schema.org JobPosting data from a page's HTML, which most career sites include. */
function fromJsonLd(html) {
  var p = emptyPosting();
  var blocks = String(html || '').match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var i = 0; i < blocks.length; i++) {
    var raw = blocks[i].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    var data;
    try { data = JSON.parse(raw); } catch (e) { continue; }
    var items = [].concat(data['@graph'] || data);
    var job = items.filter(function (x) { return x && x['@type'] === 'JobPosting'; })[0];
    if (!job) continue;
    p.title = job.title || '';
    p.company = (job.hiringOrganization && job.hiringOrganization.name) || '';
    p.remote = job.jobLocationType === 'TELECOMMUTE';
    var loc = [].concat(job.jobLocation || [])[0];
    p.location = (loc && loc.address && (loc.address.addressLocality || loc.address.addressRegion)) || (p.remote ? 'Remote' : '');
    var v = job.baseSalary && job.baseSalary.value;
    if (v) { p.payMin = v.minValue || v.value || null; p.payMax = v.maxValue || v.value || null; }
    return p;
  }
  var t = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
          String(html || '').match(/<title>([^<]+)<\/title>/i);
  if (t) p.title = t[1].trim();
  return p;
}

/** Finds the first "$184,000 - $200,000" style range in text. */
function parsePayRange(text) {
  var m = String(text || '').match(/\$\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])/);
  if (!m) return null;
  function num(s) { s = s.replace(/[,\s]/g, ''); return /k$/i.test(s) ? parseFloat(s) * 1000 : parseFloat(s); }
  return { min: num(m[1]), max: num(m[2]) };
}

// ---------- Stats for the web app ----------

var DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

function hadHumanContact(app) {
  return !!(app.prescreen || app.interview1) || [STATUS.THREAD, STATUS.PRESCREEN, STATUS.INTERVIEW,
    STATUS.FIRST_DONE, STATUS.SECOND_DONE, STATUS.REJ_EMAIL, STATUS.REJ_FINAL].indexOf(app.status) >= 0;
}

function heardBack(app) {
  return app.status !== STATUS.NO_ACK || !!app.rejected || hadHumanContact(app);
}

/**
 * The path one application took, as Sankey node names. Every path starts at "Applied".
 */
function journey(app, now) {
  var path = ['Applied'];
  var waited = app.submitted ? daysBetween(app.submitted, now || new Date()) : 0;
  if (/^Job Closed/i.test(app.status)) return path.concat(['Closed, no answer']);
  if (!heardBack(app)) return path.concat([waited >= 30 ? 'Ghosted' : 'Waiting']);
  path.push('Heard back');
  if (!hadHumanContact(app)) return path.concat([app.rejected || /^Reject/i.test(app.status) ? 'Auto-rejected' : 'Acknowledged only']);
  path.push('Human contact');
  if (!app.prescreen && !app.interview1) return path.concat([/^Reject/i.test(app.status) ? 'Rejected after contact' : 'Talking']);
  path.push('Pre-screen');
  if (!app.interview1) return path.concat([/^Reject/i.test(app.status) ? 'Rejected after screen' : 'Screen pending']);
  path.push('Interviews');
  return path.concat([/^Reject/i.test(app.status) ? 'Rejected after interviews' : 'Still interviewing']);
}

function sankeyEdges(apps, now) {
  var counts = {};
  apps.forEach(function (app) {
    var p = journey(app, now);
    for (var i = 0; i < p.length - 1; i++) {
      var k = p[i] + '\u0000' + p[i + 1];
      counts[k] = (counts[k] || 0) + 1;
    }
  });
  return Object.keys(counts).map(function (k) { var a = k.split('\u0000'); return [a[0], a[1], counts[k]]; });
}

/** Open applications that need a follow-up or look ghosted. */
function followUps(apps, now, followUpDays, ghostDays) {
  var out = { followUp: [], ghosted: [] };
  apps.forEach(function (app) {
    if (!app.submitted || isClosedStatus(app.status) || hadHumanContact(app)) return;
    var d = Math.floor(daysBetween(app.submitted, now));
    var item = { company: app.company, title: app.title, days: d, url: app.url, row: app.row };
    if (d >= ghostDays) out.ghosted.push(item);
    else if (d >= followUpDays) out.followUp.push(item);
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    STATUS: STATUS, isClosedStatus: isClosedStatus, classifyEmail: classifyEmail, nextStatus: nextStatus,
    companyKey: companyKey, matchApplication: matchApplication, parsePostingUrl: parsePostingUrl,
    fromAshby: fromAshby, fromGreenhouse: fromGreenhouse, fromLever: fromLever, fromJsonLd: fromJsonLd,
    parsePayRange: parsePayRange, journey: journey, sankeyEdges: sankeyEdges, followUps: followUps,
    heardBack: heardBack, hadHumanContact: hadHumanContact, emailExcerpt: emailExcerpt
  };
}
