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
  CLOSED: 'Job Closed - No Rejection',
  OFFER: 'Offer Received',
  OFFER_ACCEPTED: 'Offer Accepted',
  OFFER_DECLINED: 'Offer Declined',
  WITHDREW: 'Withdrew'
};

var STAGE_RANK = {};
STAGE_RANK[STATUS.NO_ACK] = 0;
STAGE_RANK[STATUS.ACK] = 1;
STAGE_RANK[STATUS.THREAD] = 2;
STAGE_RANK[STATUS.PRESCREEN] = 3;
STAGE_RANK[STATUS.INTERVIEW] = 4;
STAGE_RANK[STATUS.FIRST_DONE] = 5;
STAGE_RANK[STATUS.SECOND_DONE] = 6;
STAGE_RANK[STATUS.OFFER] = 7;

/** Finished one way or another: rejected, closed, offer accepted or declined, or withdrawn. */
function isClosedStatus(status) {
  return /^(Reject|Job Closed|Offer Accepted|Offer Declined|Withdrew)/i.test(status || '');
}

function isOfferStatus(status) {
  return /^Offer/i.test(status || '');
}

// ---------- Email classification ----------

var EMAIL_RULES = [
  { type: 'rejection', patterns: [
    /not (?:be )?moving forward/i, /decided (?:not )?to (?:move|proceed) forward with (?:other|another)/i,
    /(?:pursu(?:e|ing)|mov(?:e|ing) forward with|proceed(?:ing)? with) (?:other|another|a different) (?:candidates?|applicants?|individuals?)/i,
    /unfortunately/i, /will not be (?:moving|proceeding)/i,
    // "won't be moving forward", "aren't moving forward", "not able to move forward", "chosen not to proceed", "decided to not move ahead"
    /(?:\bnot|n['’]t|\bunable)\s+(?:be\s+|able\s+)?(?:to\s+)?(?:mov(?:e|ing)|proceed(?:ing)?|advanc(?:e|ing)|progress(?:ing)?)\s+(?:forward|ahead)/i,
    // "will not be advancing your application", "decided not to proceed with your candidacy"
    /(?:\bnot|n['’]t|\bunable)\s+(?:be\s+|able\s+)?(?:to\s+)?(?:proceed(?:ing)?|advanc(?:e|ing)|progress(?:ing)?)\s+(?:with\s+)?your\s+(?:application|candidacy)/i,
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
  // At offer stage Peter manages the status himself; Gmail.js logs the email instead.
  if (current === STATUS.OFFER) return null;
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
  return { title: '', company: '', payMin: null, payMax: null, location: '', remote: null, description: '' };
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
    p.description = job.descriptionPlain || htmlToText(job.descriptionHtml);
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
  p.description = htmlToText(job.content);
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
  p.description = [job.descriptionPlain || htmlToText(job.description)].concat((job.lists || []).map(function (l) {
    return (l.text || '') + '\n' + htmlToText(l.content);
  })).concat([job.additionalPlain || htmlToText(job.additional)]).filter(Boolean).join('\n').trim();
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
    p.description = htmlToText(job.description);
    return p;
  }
  var t = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
          String(html || '').match(/<title>([^<]+)<\/title>/i);
  if (t) p.title = t[1].trim();
  return p;
}

var PAY_AMOUNT = '(\\d{2,3}(?:,\\d{3})+|\\d{2,3}(?:\\.\\d)?\\s?[kK])';
// "$184,000 - $200,000", "$150k–$175k", "$120,000/year - $190,000/year", "$120,000 USD to $190,000 USD"
var PAY_UNIT = '\\s*(?:USD)?\\s*(?:\\/\\s?(?:year|yr|annum)|per year|annually|a year)?\\s*';
var PAY_RANGE_RE = '\\$\\s?' + PAY_AMOUNT + PAY_UNIT + '(?:-|–|—|to)\\s*\\$?\\s?' + PAY_AMOUNT;

/** Every distinct pay range in the text, in order. */
function parsePayRanges(text) {
  function num(s) { s = s.replace(/[,\s]/g, ''); return /k$/i.test(s) ? parseFloat(s) * 1000 : parseFloat(s); }
  var re = new RegExp(PAY_RANGE_RE, 'g'), m, out = [], seen = {};
  while ((m = re.exec(String(text || '')))) {
    var r = { min: num(m[1]), max: num(m[2]) };
    if (r.max < r.min || seen[r.min + '-' + r.max]) continue;
    seen[r.min + '-' + r.max] = true;
    out.push(r);
  }
  return out;
}

/** The pay range, only if the text lists exactly one. Several (e.g. by location) is ambiguous, so null. */
function parsePayRange(text) {
  var all = parsePayRanges(text);
  return all.length === 1 ? all[0] : null;
}

function formatPayRange(r) {
  return '$' + Math.round(r.min / 1000) + 'k–$' + Math.round(r.max / 1000) + 'k';
}

/**
 * How to lay out one line of posting text in a Doc: a section heading, a bullet,
 * a numbered item, or a plain paragraph. Headings are short lines with no closing punctuation.
 */
function postingLineKind(line) {
  var t = String(line || '').trim(), m;
  if ((m = t.match(/^(?:[-•*·▪●]|–)\s+(.*)$/))) return { kind: 'bullet', text: m[1] };
  if ((m = t.match(/^(\d{1,2})[.)]\s+(.*)$/))) return { kind: 'number', text: m[1] + '. ' + m[2] };
  if (t.length <= 60 && t.split(/\s+/).length <= 8 && !/[.,;!?]$/.test(t) && !/^\$/.test(t)) return { kind: 'heading', text: t.replace(/:$/, '') };
  return { kind: 'para', text: t };
}

// ---------- Stats for the web app ----------

var DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

function hadHumanContact(app) {
  return !!(app.prescreen || app.interview1) || isOfferStatus(app.status) || [STATUS.THREAD, STATUS.PRESCREEN, STATUS.INTERVIEW,
    STATUS.FIRST_DONE, STATUS.SECOND_DONE, STATUS.REJ_EMAIL, STATUS.REJ_FINAL].indexOf(app.status) >= 0;
}

function heardBack(app) {
  var silent = !app.status || app.status === STATUS.NO_ACK || app.status === STATUS.WITHDREW;
  return !silent || !!app.rejected || hadHumanContact(app);
}

/**
 * The path one application took, as Sankey node names. Every path starts at "Applied".
 */
function journey(app, now) {
  var s = app.status || '';
  var rejected = /^Reject/i.test(s);
  var withdrew = s === STATUS.WITHDREW;
  var OFFER_END = {};
  OFFER_END[STATUS.OFFER] = 'Offer (deciding)';
  OFFER_END[STATUS.OFFER_ACCEPTED] = 'Offer accepted';
  OFFER_END[STATUS.OFFER_DECLINED] = 'Offer declined';
  function end(still, rej) { return OFFER_END[s] || (withdrew ? 'Withdrew' : rejected ? rej : still); }

  var path = ['Applied'];
  var waited = app.submitted ? daysBetween(app.submitted, now || new Date()) : 0;
  if (/^Job Closed/i.test(s)) return path.concat(['Closed, no answer']);
  if (!heardBack(app)) return path.concat([withdrew ? 'Withdrew' : waited >= 30 ? 'Ghosted' : 'Waiting']);
  path.push('Heard back');
  if (!hadHumanContact(app)) return path.concat([withdrew ? 'Withdrew' : app.rejected || rejected ? 'Auto-rejected' : 'Acknowledged only']);
  path.push('Human contact');
  if (!app.prescreen && !app.interview1) return path.concat([end('Talking', 'Rejected after contact')]);
  path.push('Pre-screen');
  if (!app.interview1) return path.concat([end('Screen pending', 'Rejected after screen')]);
  path.push('Interviews');
  return path.concat([end('Still interviewing', 'Rejected after interviews')]);
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

// ---------- Response rates by resume, source, etc. ----------

var BREAKDOWNS = {
  resume: { label: 'Resume version', key: function (a) { return a.resume || 'Not set'; } },
  coverLetter: { label: 'Cover letter', key: function (a) {
    return !a.coverLetter || /^(n\/?a|none|no)$/i.test(String(a.coverLetter).trim()) ? 'No cover letter' : 'Cover letter'; } },
  source: { label: 'Source', key: function (a) { return a.source || 'Not set'; } },
  fit: { label: 'Fit', key: function (a) { return a.fit || 'Not set'; } },
  companyType: { label: 'Company type', key: function (a) { return a.companyType || 'Not set'; } }
};

/** For each value of a field: how many applied, heard back, got human contact, interviewed. Biggest groups first. */
function breakdown(apps, field) {
  var keyFn = BREAKDOWNS[field].key, groups = {};
  apps.forEach(function (a) {
    var k = keyFn(a);
    var g = groups[k] = groups[k] || { label: k, applied: 0, heard: 0, human: 0, interviewed: 0 };
    g.applied++;
    if (heardBack(a)) g.heard++;
    if (hadHumanContact(a)) g.human++;
    if (a.interview1) g.interviewed++;
  });
  return Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (x, y) { return y.applied - x.applied || (x.label < y.label ? -1 : 1); });
}

function allBreakdowns(apps) {
  var out = {};
  Object.keys(BREAKDOWNS).forEach(function (f) { out[f] = { label: BREAKDOWNS[f].label, rows: breakdown(apps, f) }; });
  return out;
}

/** Resume used on the most recently submitted application, or the fallback. Peter revises it often. */
function latestResume(apps, fallback) {
  var best = null;
  apps.forEach(function (a) {
    if (a.resume && a.submitted && (!best || new Date(a.submitted) > new Date(best.submitted))) best = a;
  });
  return best ? best.resume : fallback;
}

// ---------- Duplicate check ----------

/** Lowercase URL without scheme, www, query or trailing slash. Keeps Greenhouse's gh_jid, which identifies the job. */
function normalizeUrl(url) {
  var u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  var jid = u.match(/[?&](gh_jid=\d+)/);
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/(application|apply)\/?$/, '').replace(/\/+$/, '');
  return jid ? u + '?' + jid[1] : u;
}

function titleKey(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Earlier applications to the same company or the same posting URL. sameRole = same URL or same title. */
function findDuplicates(apps, company, title, url) {
  var key = companyKey(company), nu = normalizeUrl(url), tk = titleKey(title);
  var out = [];
  apps.forEach(function (a) {
    var urlMatch = !!nu && (normalizeUrl(a.url) === nu || normalizeUrl(a.url2) === nu);
    var companyMatch = key.length >= 3 && companyKey(a.company) === key;
    if (!urlMatch && !companyMatch) return;
    out.push({ row: a.row, company: a.company, title: a.title, status: a.status, submitted: a.submitted,
      sameRole: urlMatch || (!!tk && titleKey(a.title) === tk) });
  });
  return out;
}

// ---------- Contacts from email senders ----------

var NOT_A_PERSON = /^(no-?reply|do-?not-?reply|notifications?|jobs|careers|talent|recruiting|recruitment|hiring|hr|people|team|hello|info|support|apply|applications?|candidates?|mailer|bounce)([+._-]|$)/i;
var ATS_DOMAINS = /(greenhouse\.io|ashbyhq\.com|lever\.co|myworkday(jobs)?\.com|workday\.com|workablemail\.com|workable\.com|smartrecruiters\.com|icims\.com|jobvite\.com|bamboohr\.com|rippling\.com|linkedin\.com|indeed\.com|breezy\.hr|recruitee\.com|teamtailor\.com|jazzhr\.com|applytojob\.com|gem\.com|dover\.com|wellfound\.com|ziprecruiter\.com)$/i;

/** "Jane Doe <jane@acme.com>" -> "Jane Doe <jane@acme.com>", or null for no-reply and ATS senders. */
function contactFromSender(from) {
  var s = String(from || '').trim();
  var m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  var name = m ? m[1].trim() : '', email = (m ? m[2] : s).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return null;
  var local = email.split('@')[0], domain = email.split('@')[1];
  if (NOT_A_PERSON.test(local) || ATS_DOMAINS.test(domain)) return null;
  if (/\b(team|careers|recruiting|talent|hiring|jobs|via)\b/i.test(name)) return null;
  return name ? name + ' <' + email + '>' : email;
}

/** Adds a contact to a "; "-separated list unless that email is already in it. Returns null if nothing changes. */
function mergeContacts(existing, contact) {
  if (!contact) return null;
  var email = (contact.match(/<([^>]+)>/) || [null, contact])[1].toLowerCase();
  var cur = String(existing || '');
  if (cur.toLowerCase().indexOf(email) >= 0) return null;
  return cur.trim() ? cur.trim().replace(/[;,]\s*$/, '') + '; ' + contact : contact;
}

// ---------- Posting text ----------

function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&bull;/g, '•')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Readable plain text from posting HTML: one paragraph or bullet per line. */
function htmlToText(html) {
  var h = String(html || '');
  if (h.indexOf('<') < 0 && /&lt;/.test(h)) h = decodeEntities(h); // Greenhouse escapes its HTML
  h = h.replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities(h).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

if (typeof module !== 'undefined') {
  module.exports = {
    STATUS: STATUS, isClosedStatus: isClosedStatus, classifyEmail: classifyEmail, nextStatus: nextStatus,
    companyKey: companyKey, matchApplication: matchApplication, parsePostingUrl: parsePostingUrl,
    fromAshby: fromAshby, fromGreenhouse: fromGreenhouse, fromLever: fromLever, fromJsonLd: fromJsonLd,
    parsePayRange: parsePayRange, parsePayRanges: parsePayRanges, formatPayRange: formatPayRange, postingLineKind: postingLineKind, journey: journey, sankeyEdges: sankeyEdges, followUps: followUps,
    heardBack: heardBack, hadHumanContact: hadHumanContact, emailExcerpt: emailExcerpt,
    isOfferStatus: isOfferStatus, breakdown: breakdown, allBreakdowns: allBreakdowns, normalizeUrl: normalizeUrl,
    findDuplicates: findDuplicates, latestResume: latestResume, contactFromSender: contactFromSender, mergeContacts: mergeContacts,
    htmlToText: htmlToText, decodeEntities: decodeEntities
  };
}
