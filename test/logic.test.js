const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/Logic.js');
const S = L.STATUS;

test('classifies rejection, interview and ack emails', () => {
  assert.strictEqual(L.classifyEmail('Your application to Vetcove', 'Unfortunately, we have decided to move forward with other candidates.'), 'rejection');
  assert.strictEqual(L.classifyEmail('Next steps', 'We would love to chat. Please share your availability this week.'), 'interview');
  assert.strictEqual(L.classifyEmail('Thank you for applying to GoodParty.org', 'We have received your application and will review it soon.'), 'ack');
  assert.strictEqual(L.classifyEmail('Weekly newsletter', 'Here are some articles.'), null);
});

test('conditional "if we don\'t move forward" in an ack is not a rejection', () => {
  const body = 'Thanks for applying! We have received your application. If we decide not to move forward, we will let you know.';
  assert.strictEqual(L.classifyEmail('Application received', body), 'ack');
});

test('ack that says "unfortunately unable to send rejection emails" is not a rejection', () => {
  const body = 'Thank you so much for taking the time to apply for the Senior Product Manager position! ' +
    'Confirming that we’ve successfully received your application. We are currently reviewing applications ' +
    'and will reach out directly if your experience is a strong match for this role.\n\n' +
    'Due to the high volume of applications we receive, we are unfortunately unable to send individual rejection ' +
    'emails or respond to personal status inquiries. If you do not hear from us, please assume we have decided to ' +
    'move forward with other candidates whose experience more closely align with this role.';
  assert.strictEqual(L.classifyEmail('Thank you for applying to Vetcove!', body), 'ack');
  assert.strictEqual(L.classifyEmail('Update', 'Confirming that we’ve successfully received your application.'), 'ack');
});

test('email excerpt drops links, collapses whitespace, and truncates', () => {
  assert.strictEqual(L.emailExcerpt('Hi Peter,\n\n  Thanks!  See https://x.com/a?b=1 now'), 'Hi Peter, Thanks! See now');
  const long = L.emailExcerpt('a'.repeat(2000), 100);
  assert.strictEqual(long.length, 101);
  assert.strictEqual(L.emailExcerpt(null), '');
});

test('rejection wrapped across lines is still a rejection (Thrive Market)', () => {
  const body = 'Hi Peter,\n\nThank you for your interest in Thrive Market and for taking the time to apply. After a\r\n' +
    'thorough review of your qualifications, we\u2019ve decided to move\r\nforward with other candidates for this role.\n\n' +
    'While we\u2019re unable to offer individual feedback due to the number of candidates, we appreciate your time.';
  assert.strictEqual(L.classifyEmail('Thanks for your interest in Thrive Market', body), 'rejection');
});

test('rejection beats a polite thank-you in the same email', () => {
  assert.strictEqual(L.classifyEmail('Thank you for your interest', 'Thank you for applying. We regret to inform you the position has been filled.'), 'rejection');
});

test('status transitions only move forward and pick the right rejection', () => {
  assert.strictEqual(L.nextStatus(S.NO_ACK, 'ack'), S.ACK);
  assert.strictEqual(L.nextStatus(S.ACK, 'ack'), null);
  assert.strictEqual(L.nextStatus(S.ACK, 'interview'), S.THREAD);
  assert.strictEqual(L.nextStatus(S.PRESCREEN, 'interview'), null);
  assert.strictEqual(L.nextStatus(S.NO_ACK, 'rejection'), S.REJ_FIRST);
  assert.strictEqual(L.nextStatus(S.THREAD, 'rejection'), S.REJ_EMAIL);
  assert.strictEqual(L.nextStatus(S.FIRST_DONE, 'rejection'), S.REJ_FINAL);
  assert.strictEqual(L.nextStatus(S.REJ_FIRST, 'interview'), null);
});

test('matches emails to the right company and skips ambiguous ones', () => {
  const apps = [{ company: 'Vetcove' }, { company: 'GoodParty.org' }, { company: 'Help Scout' }];
  assert.strictEqual(L.matchApplication(apps, { from: 'no-reply@ashbyhq.com', subject: 'Thank you for applying to GoodParty.org', body: '' }), 1);
  assert.strictEqual(L.matchApplication(apps, { from: 'Talent Team <talent@vetcove.com>', subject: 'Update', body: '' }), 0);
  assert.strictEqual(L.matchApplication(apps, { from: 'jobs@helpscout.com', subject: 'Hi', body: '' }), 2);
  assert.strictEqual(L.matchApplication(apps, { from: 'x@y.com', subject: 'Vetcove and Help Scout', body: '' }), -1);
  assert.strictEqual(L.matchApplication(apps, { from: 'x@y.com', subject: 'Hello', body: 'nothing here' }), -1);
});

test('parses ATS posting URLs', () => {
  assert.deepStrictEqual(L.parsePostingUrl('https://jobs.ashbyhq.com/goodparty/e3a16838-9b9b-4318-893a-898b062f4c38/application'),
    { ats: 'ashby', org: 'goodparty', id: 'e3a16838-9b9b-4318-893a-898b062f4c38' });
  assert.deepStrictEqual(L.parsePostingUrl('https://job-boards.greenhouse.io/blab/jobs/8374947002'), { ats: 'greenhouse', org: 'blab', id: '8374947002' });
  assert.deepStrictEqual(L.parsePostingUrl('https://jobs.lever.co/veeva/a22a1872-2a10-4b42-80e5-db22e13e3740'),
    { ats: 'lever', org: 'veeva', id: 'a22a1872-2a10-4b42-80e5-db22e13e3740' });
  assert.strictEqual(L.parsePostingUrl('https://lattice.com/job?gh_jid=7832484002').ats, 'greenhouse-embed');
  assert.strictEqual(L.parsePostingUrl('https://example.com/careers/pm').ats, 'generic');
});

test('normalizes Ashby, Greenhouse, Lever and JSON-LD postings', () => {
  const id = 'e3a16838-9b9b-4318-893a-898b062f4c38';
  const a = L.fromAshby({ jobs: [{ id, title: 'Staff Product Manager', location: 'Remote (United States)', isRemote: true,
    compensation: { summaryComponents: [{ compensationType: 'Salary', minValue: 184000, maxValue: 200000 }] } }] }, id, 'Staff Product Manager @ GoodParty.org');
  assert.deepStrictEqual(a, { title: 'Staff Product Manager', company: 'GoodParty.org', payMin: 184000, payMax: 200000, location: 'Remote (United States)', remote: true });

  const g = L.fromGreenhouse({ title: 'Senior PM', company_name: 'B Lab', location: { name: 'Remote - US' }, pay_input_ranges: [{ min_cents: 12700000, max_cents: 13400000 }] }, 'blab');
  assert.strictEqual(g.payMin, 127000); assert.strictEqual(g.company, 'B Lab'); assert.strictEqual(g.remote, true);

  const l = L.fromLever({ text: 'Senior PM', categories: { location: 'Boston' }, workplaceType: 'remote', salaryRange: { min: 120000, max: 200000 } }, 'veeva');
  assert.strictEqual(l.company, 'Veeva'); assert.strictEqual(l.remote, true); assert.strictEqual(l.payMax, 200000);

  const html = '<script type="application/ld+json">{"@type":"JobPosting","title":"PM","hiringOrganization":{"name":"Acme"},"jobLocationType":"TELECOMMUTE","baseSalary":{"value":{"minValue":150000,"maxValue":170000}}}</script>';
  assert.deepStrictEqual(L.fromJsonLd(html), { title: 'PM', company: 'Acme', payMin: 150000, payMax: 170000, location: 'Remote', remote: true });
});

test('parses pay ranges written in text', () => {
  assert.deepStrictEqual(L.parsePayRange('The salary range is $184,000 - 200,000 for this role'), { min: 184000, max: 200000 });
  assert.deepStrictEqual(L.parsePayRange('Pay: $150k–$175k'), { min: 150000, max: 175000 });
  assert.strictEqual(L.parsePayRange('Competitive pay'), null);
});

test('journeys and Sankey edges', () => {
  const now = new Date('2026-12-30T00:00:00');
  const apps = [
    { status: S.NO_ACK, submitted: '2026-11-17T21:41:00' },
    { status: S.REJ_FIRST, submitted: '2026-11-17T21:41:00', rejected: '2026-11-18T10:00:00' },
    { status: S.SECOND_DONE, submitted: '2026-11-17T21:41:00', prescreen: '2026-11-20', interview1: '2026-11-25' }
  ];
  assert.deepStrictEqual(L.journey(apps[0], now), ['Applied', 'Ghosted']);
  assert.deepStrictEqual(L.journey(apps[1], now), ['Applied', 'Heard back', 'Auto-rejected']);
  assert.deepStrictEqual(L.journey(apps[2], now), ['Applied', 'Heard back', 'Human contact', 'Pre-screen', 'Interviews', 'Still interviewing']);
  const edges = L.sankeyEdges(apps, now);
  assert.deepStrictEqual(edges.find(e => e[0] === 'Applied' && e[1] === 'Heard back'), ['Applied', 'Heard back', 2]);
});

test('follow-ups and ghosted lists', () => {
  const now = new Date('2026-12-20T00:00:00');
  const apps = [
    { company: 'A', status: S.NO_ACK, submitted: '2026-12-01T00:00:00' },
    { company: 'B', status: S.ACK, submitted: '2026-11-01T00:00:00' },
    { company: 'C', status: S.REJ_FIRST, submitted: '2026-11-01T00:00:00' },
    { company: 'D', status: S.THREAD, submitted: '2026-11-01T00:00:00' }
  ];
  const f = L.followUps(apps, now, 14, 30);
  assert.deepStrictEqual(f.followUp.map(x => x.company), ['A']);
  assert.deepStrictEqual(f.ghosted.map(x => x.company), ['B']);
});
