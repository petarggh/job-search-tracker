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
    ['title', 'company', 'location'].forEach(function (k) { if (!p[k]) p[k] = ld[k]; });
    if (p.remote === null) p.remote = ld.remote;
    if (p.payMin === null) {
      var pay = (ld.payMin !== null) ? { min: ld.payMin, max: ld.payMax } : parsePayRange(html.replace(/<[^>]+>/g, ' '));
      if (pay) { p.payMin = pay.min; p.payMax = pay.max; }
    }
  }
  p.ats = ref.ats;
  p.url = url;
  return p;
}
