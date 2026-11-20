/**
 * Looks up a job posting from its URL: title, company, pay range, location.
 * Uses each ATS's public API where there is one, then falls back to the page's
 * schema.org JobPosting data.
 */

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Accept: 'application/json' } });
  if (res.getResponseCode() !== 200) return null;
  try { return JSON.parse(res.getContentText()); } catch (e) { return null; }
}

function fetchHtml_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  return res.getResponseCode() === 200 ? res.getContentText() : '';
}

function lookupPosting(url) {
  var ref = parsePostingUrl(url);
  var p;
  if (ref.ats === 'ashby') {
    var board = fetchJson_('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(ref.org) + '?includeCompensation=true');
    var page = fetchHtml_('https://jobs.ashbyhq.com/' + encodeURIComponent(ref.org) + '/' + ref.id);
    var title = (page.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
    p = fromAshby(board, ref.id, title);
    if (!p.company) p.company = titleCaseSlug(ref.org);
  } else if (ref.ats === 'greenhouse') {
    p = fromGreenhouse(fetchJson_('https://boards-api.greenhouse.io/v1/boards/' + ref.org + '/jobs/' + ref.id + '?pay_transparency=true'), ref.org);
  } else if (ref.ats === 'lever') {
    p = fromLever(fetchJson_('https://api.lever.co/v0/postings/' + ref.org + '/' + ref.id), ref.org);
  }
  // Fall back to the page itself for anything still missing.
  if (!p || !p.title || !p.company || p.payMin === null) {
    var html = fetchHtml_(url);
    var ld = fromJsonLd(html);
    p = p || ld;
    ['title', 'company', 'location', 'description'].forEach(function (k) { if (!p[k]) p[k] = ld[k]; });
    if (p.remote === null) p.remote = ld.remote;
    if (p.payMin === null) {
      var pay = (ld.payMin !== null) ? { min: ld.payMin, max: ld.payMax } : parsePayRange(html.replace(/<[^>]+>/g, ' '));
      if (pay) { p.payMin = pay.min; p.payMax = pay.max; }
    }
  }
  if (!p.description && html) p.description = htmlToText(html).slice(0, 20000); // last resort: page text
  p.ats = ref.ats;
  p.url = url;
  return p;
}

/**
 * Saves the posting text to a Google Doc so it survives the posting being taken down.
 * Returns the doc URL, or null if the text looks too thin to be the real description.
 */
function savePostingDoc(company, title, url, posting) {
  var text = String(posting && posting.description || '').slice(0, 60000);
  if (text.length < CONFIG.POSTING.MIN_CHARS) return null;
  var doc = DocumentApp.openById(createPostingFile_('Posting - ' + company + ' - ' + title, company));
  var body = doc.getBody();
  var head = body.getParagraphs()[0];
  head.setText(title); // setText returns nothing in Apps Script, so no chaining
  head.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  var pay = posting.payMin ? ' · $' + Math.round(posting.payMin / 1000) + 'k–$' + Math.round((posting.payMax || posting.payMin) / 1000) + 'k' : '';
  body.appendParagraph(company + (posting.location ? ' · ' + posting.location : '') + pay);
  body.appendParagraph('Saved ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy') + ' from ' + url);
  body.appendParagraph('');
  text.split('\n').forEach(function (line) { if (line.trim()) body.appendParagraph(line); });
  var link = doc.getUrl();
  doc.saveAndClose();
  return link;
}

// Uses the Drive API advanced service, which works with the narrow drive.file scope
// (only files this app created). DriveApp would need access to all of Drive.
function postingFolderId_() {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty('postingFolderId');
  if (id) {
    try { if (!Drive.Files.get(id, { fields: 'id,trashed' }).trashed) return id; } catch (e) { /* gone; make a new one */ }
  }
  id = Drive.Files.create({ name: CONFIG.POSTING.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }).id;
  props.setProperty('postingFolderId', id);
  return id;
}

/**
 * Creates an empty Google Doc inside the postings folder and returns its ID.
 * It must be created through the Drive API: drive.file can't see docs made by DocumentApp.create.
 * If the folder can't be used, the doc goes in My Drive and the reason is logged.
 */
function createPostingFile_(name, company) {
  var meta = { name: name, mimeType: 'application/vnd.google-apps.document' };
  try {
    meta.parents = [postingFolderId_()];
  } catch (e) {
    logActivity('Posting folder unavailable', company || '', e.message);
  }
  return Drive.Files.create(meta).id;
}

/** Looks up and saves the posting for one application row. Returns the doc URL or null. Never throws. */
function savePostingForApp_(row, company, title, url) {
  try {
    var link = savePostingDoc(company, title, url, lookupPosting(url));
    if (!link) { logActivity('Posting not saved', company, 'Could not read the job description from ' + url); return null; }
    updateApplication(row, company, { postingDoc: link });
    logActivity('Saved posting', company, link);
    return link;
  } catch (e) {
    logActivity('Posting not saved', company, e.message);
    return null;
  }
}

/** Menu: save postings for open applications that have a URL but no saved copy yet. */
function saveMissingPostings() {
  var apps = readApplications();
  if (apps.length && !('postingDoc' in apps[0])) return { error: 'Add a "' + CONFIG.OPTIONAL_HEADERS.postingDoc + '" column to the data tab first.' };
  var todo = apps.filter(function (a) { return a.url && !a.postingDoc && !isClosedStatus(a.status); }).slice(0, CONFIG.POSTING.BACKFILL_MAX);
  var saved = 0;
  todo.forEach(function (a) { if (savePostingForApp_(a.row, a.company, a.title, a.url)) saved++; });
  return { tried: todo.length, saved: saved };
}
