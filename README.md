# Job Search Tracker

A Google Apps Script web app on top of my job-search Google Sheet. It keeps the sheet as the source of truth and adds:

- **Log from a URL.** Paste an Ashby, Greenhouse, Lever or most other job links and it fills in the title, company, pay range and location. Only used *after* applying.
- **Gmail auto-updates.** An hourly job reads recent email, spots acknowledgements, rejections and interview invites, and moves the matching application forward. It never moves an application backwards or reopens a closed one. Every change is written to an `activity` tab.
- **Follow-up nudges.** A weekly email lists applications with no human reply after 14 days, plus likely-ghosted ones after 30.
- **Richer visuals.** A Sankey diagram of where applications end up, a calendar heatmap, a timeline of every application, response-time histogram, and response rate by company type.

```
src/
  Config.js      everything specific to my sheet (IDs, headers, thresholds)
  Logic.js       pure logic: email classification, status rules, URL parsing, stats
  Sheet.js       read/write the data tab by header name, activity log
  Posting.js     job posting lookup (ATS APIs, then schema.org JobPosting)
  Gmail.js       hourly Gmail sync
  Nudges.js      weekly follow-up digest
  Code.js        web app, page API, sheet menu, triggers
  Index.html     the web app UI (Google Charts)
test/            Node tests, including fakes of the Google services
```

## Setup (one time)

Use the Google account that **owns the sheet and receives application emails**. The Gmail sync reads that account's inbox.

1. Turn on the Apps Script API: <https://script.google.com/home/usersettings>
2. Install clasp and sign in:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
3. Create a script bound to the tracker sheet:
   ```bash
   clasp create --type sheets --title "Job Search Tracker" \
     --parentId 1plUWkvqzIuXQy0wNMuJ397-R-dSt1tVrenKinRvuuCM --rootDir src
   ```
   This writes `.clasp.json`. If it also created a `src/appsscript.json`, keep the one in this repo.
4. Push the code: `npm run push`
5. Open the sheet and reload it. A **Job Tracker** menu appears.
   - First set `GMAIL.DRY_RUN: true` in `Config.js`, push, and run **Sync Gmail now**. Check the `activity` tab to see what it would change. Then set it back to `false` and push again.
   - Run **Install hourly Gmail sync + weekly digest** and approve the permissions.
6. Deploy the web app: `npm run deploy`. Open the URL from **Deploy → Manage deployments** in the Apps Script editor, and add it to your phone's home screen.

## Updating

```bash
npm test                         # run the tests
npm run push                     # push code to Apps Script
clasp deploy -i <deploymentId>   # update the existing web app URL in place
```

`clasp deployments` lists the deployment IDs. Deploying with `-i` keeps the same URL; a plain `clasp deploy` makes a new one.

## How it decides things

- **Email types:** rejection language beats everything else, then interview scheduling, then "thanks for applying". Conditional sentences ("*if* we don't move forward…") are ignored when looking for rejections.
- **Matching email to an application:** the company name must appear in the sender or subject (or, failing that, uniquely in the body). If two applications could match, nothing changes and an "Unmatched" line goes to the activity log.
- **Status moves:** ack only upgrades `Applied - no Ack`. An interview invite moves early stages to `Email Thread`; the date still needs to be set by hand. A rejection picks `Rejection First Contact`, `Rejection after Email` or `Rejection after final interview` depending on how far it got, and fills the rejection date.
- Thresholds and header names live in `Config.js`.

## Privacy

Application data stays in the Google Sheet. This repo only holds code. The web app is set to "Only myself".
