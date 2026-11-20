/**
 * Everything specific to one person's sheet lives here.
 * Change these values instead of editing the other files.
 */
var CONFIG = {
  // Leave blank when the script is bound to the sheet (clasp create --parentId).
  SHEET_ID: '',
  DATA_TAB: 'data',
  ACTIVITY_TAB: 'activity',

  // Header names in the data tab. Columns are found by header, so they can move.
  HEADERS: {
    title: 'Title',
    company: 'Company',
    status: 'Status?',
    url: 'Url',
    url2: 'Url2',
    resume: 'Resume',
    coverLetter: 'Cover Letter',
    submitted: 'Submitted Datetime',
    rejected: 'Rejection Datetime',
    prescreen: 'Prescreen Datetime',
    interview1: 'First Interview Datetime',
    interview2: 'Second Interview Datetime',
    interview3: 'Third Interview Datetime',
    source: 'Source',
    companyType: 'Company Type',
    fit: 'Fit',
    payMin: 'Pay Min',
    payMax: 'Pay Max',
    notes: 'Notes'
  },

  // Columns the app uses if they exist. If a header is missing, that feature is skipped.
  OPTIONAL_HEADERS: {
    postingDoc: 'Posting Doc',   // link to a saved copy of the job posting
    contacts: 'Contacts'         // people who emailed about this application
  },

  POSTING: {
    FOLDER_NAME: 'Job Postings (tracker)',  // Drive folder for saved postings
    MIN_CHARS: 300,                         // shorter than this = probably not the real description
    BACKFILL_MAX: 15                        // postings saved per "save missing postings" run
  },

  // Columns that hold formulas. When a row is added past the pre-filled rows,
  // these formulas are copied down from the row above.
  FORMULA_HEADERS: ['Days to Response', 'Days Waiting', 'date'],

  DEFAULT_RESUME: 'Peter.Owen-Resume-2026.11.16',

  GMAIL: {
    LOOKBACK_DAYS: 3,      // how far back each sync looks
    MAX_THREADS: 100,
    DRY_RUN: false,        // true = only log what would change
    EXTRA_QUERY: '-in:sent -category:promotions -category:social'
  },

  NUDGE: {
    FOLLOW_UP_DAYS: 14,    // no human reply after this many days -> follow up
    GHOST_DAYS: 30,        // no reply at all after this many days -> likely ghosted
    DIGEST_WEEKDAY: ScriptAppWeekday_('MONDAY'),
    DIGEST_HOUR: 8
  }
};

function ScriptAppWeekday_(name) {
  // Lets Config load in Node tests, where ScriptApp doesn't exist.
  return (typeof ScriptApp !== 'undefined') ? ScriptApp.WeekDay[name] : name;
}

if (typeof module !== 'undefined') module.exports = { CONFIG: CONFIG };
