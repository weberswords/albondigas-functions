// Bug reports from the app (albondigas ErrorLogExporter.swift). A signed-in
// person's "Get Help" or "Report a Bug" uploads errorReports/{uid}/{ID}.txt,
// where the ID looks like K7QX-2M4P. Rules live in the albondigas repo
// (storage.rules), and docs/ERROR_REPORTS.md there covers the whole path and
// its threat model.
//
// sendErrorReportDigest emails the owner once a day, at 8 AM Pacific, with the
// reports that arrived since the last digest, so nobody has to send the owner
// a report number. A day with no reports sends nothing. The email says what
// each report is about but never carries its log: reports hold the person's
// email address and device details. Each report links to its folder in the
// Firebase console, which needs the owner's sign-in.
//
// Two reports from one person a few seconds apart are one tap sent twice
// (U4E4-HX8A and UU29-RGKA, one second apart on 2026-11-05), so the digest
// lists them as one report and names both.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const mailgun = require('./mailer');
const { OWNER_REPORTS_EMAIL } = require('./reports.js');

const mailgunApiKey = defineSecret('MAILGUN_API_KEY');
const mailgunDomain = 'mail.vlrb.app';

// The default bucket, the same one index.js gives admin.initializeApp
const BUCKET = 'albondigas-8cfd9.appspot.com';
const FOLDER = 'errorReports';

// Matches storage.rules and ErrorReport.isValidReportId in the app
const REPORT_FILE_PATTERN = /^([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})\.txt$/;

// Reports from one person this close together are one tap sent twice
const DUPLICATE_SECONDS = 10;

// The first digest, or one after a long gap, looks back this far. Reports are
// removed 30 days after upload anyway.
const FIRST_LOOKBACK_HOURS = 24;

// The digest reads and describes at most this many reports, so a flood of
// uploads can't make it slow or huge. The rest are counted.
const MAX_DESCRIBED = 50;

// Lengths kept from the parts of a report the email shows
const CONTEXT_MAX = 200;
const NOTE_MAX = 500;

// Where the digest keeps the time it has covered through. No client rule
// matches this collection, so only functions can read or write it.
const STATE_COLLECTION = 'errorReportDigest';
const STATE_DOC = 'state';

function projectId() {
  return process.env.GCLOUD_PROJECT || 'albondigas-8cfd9';
}

// errorReports/{uid}/{ID}.txt -> { userId, reportId }, or null for any other
// object
function parseReportPath(name) {
  const parts = (name || '').split('/');
  if (parts.length !== 3 || parts[0] !== FOLDER || !parts[1]) return null;
  const match = parts[2].match(REPORT_FILE_PATTERN);
  if (!match) return null;
  return { userId: parts[1], reportId: match[1] };
}

// Report text comes from the phone, so it's untrusted: drop control
// characters, keep it on one line, and cap its length.
function clean(value, max) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The first value after a label like "- App Version:" or "User Action:"
function field(text, label) {
  const pattern = new RegExp(`^\\s*(?:- )?${label}:[ \\t]*(.*)$`, 'm');
  const match = text.match(pattern);
  return match ? match[1] : null;
}

// What the email can say about a report, read from its text. Only these
// fields leave the report: never a log line, the device name, or an email
// address.
function summarizeReport(text) {
  const body = typeof text === 'string' ? text : '';
  let errors = 0;
  let warnings = 0;
  for (const line of body.split('\n')) {
    if (line.includes('❌')) errors += 1;
    if (line.includes('⚠️')) warnings += 1;
  }
  return {
    appVersion: clean(field(body, 'App Version'), 20),
    build: clean(field(body, 'Build Number'), 20),
    context: clean(field(body, 'User Action'), CONTEXT_MAX),
    // The app doesn't ask for a note yet. When it does, it goes on a "Note:"
    // line in the report's context section.
    note: clean(field(body, 'Note'), NOTE_MAX),
    errors,
    warnings,
  };
}

// Groups reports so one tap sent twice reads as one report. Reports are
// { userId, reportId, createdAt: Date }. Returns groups of reports, oldest
// group first; each group is one person's reports, each within
// DUPLICATE_SECONDS of the one before.
function groupDuplicates(reports) {
  const sorted = [...reports].sort((a, b) =>
    a.userId.localeCompare(b.userId) || a.createdAt - b.createdAt || a.reportId.localeCompare(b.reportId));
  const groups = [];
  for (const report of sorted) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && previous.userId === report.userId
      && report.createdAt - previous.createdAt <= DUPLICATE_SECONDS * 1000) {
      current.push(report);
    } else {
      groups.push([report]);
    }
  }
  return groups.sort((a, b) => a[0].createdAt - b[0].createdAt || a[0].reportId.localeCompare(b[0].reportId));
}

// The report's folder in the Firebase console. Opening it needs the owner's
// sign-in, unlike a signed URL, which works for anyone holding the email.
function consoleLink(userId) {
  const path = [FOLDER, userId].map(encodeURIComponent).join('~2F');
  return `https://console.firebase.google.com/project/${projectId()}/storage/${BUCKET}/files/~2F${path}`;
}

// Like "Thu, Nov 6, 9:41 AM PST"
function pacificTime(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeGroup(group) {
  const [first] = group;
  const summary = first.summary || {};
  const ids = group.map((report) => report.reportId);
  const lines = [];

  if (group.length === 1) {
    lines.push(`Report ${first.reportId}`);
  } else {
    const seconds = Math.round((group[group.length - 1].createdAt - first.createdAt) / 1000);
    lines.push(`Report ${ids.join(' and ')}`);
    lines.push(`  Sent ${group.length} times within ${plural(seconds, 'second')}, so it's one tap sent more than once.`);
  }
  lines.push(`  Sent: ${pacificTime(first.createdAt)}`);
  if (first.summary) {
    const version = summary.appVersion || first.metadataVersion || 'Unknown';
    lines.push(`  App: ${version}${summary.build ? ` (${summary.build})` : ''}`);
    lines.push(`  What they were doing: ${summary.context || 'Not given'}`);
    lines.push(`  Their note: ${summary.note || 'None'}`);
    lines.push(`  Log: ${plural(summary.errors, 'error')} (❌), ${plural(summary.warnings, 'warning')} (⚠️)`);
  } else {
    lines.push(`  App: ${first.metadataVersion || 'Unknown'}`);
    lines.push(first.readFailed
      ? '  Couldn\'t be read for this email. Open it in the console.'
      : `  Not read, because the digest reads at most ${MAX_DESCRIBED} reports. Open it in the console.`);
  }
  lines.push(`  Open it (you need to sign in): ${consoleLink(first.userId)}`);
  return lines;
}

// The digest email. Lists each report, or each tap sent twice once, without
// any log lines or anyone's email address.
function buildDigestEmail(groups) {
  const reportCount = groups.reduce((sum, group) => sum + group.length, 0);
  const subject = groups.length === 1
    ? `vlrb bug report ${groups[0][0].reportId}`
    : `vlrb bug reports: ${groups.length} new`;
  const lines = [
    groups.length === 1
      ? 'Someone sent a bug report in vlrb since the last digest.'
      : `${groups.length} bug reports came in to vlrb since the last digest.`,
  ];
  if (reportCount > groups.length) {
    lines.push(`Some were sent more than once, so ${plural(reportCount, 'upload')} make ${plural(groups.length, 'report')}.`);
  }
  for (const group of groups) {
    lines.push('', ...describeGroup(group));
  }
  lines.push(
    '',
    'To download the newest reports, run scripts/latest-error-reports in albondigas.',
    'Everything in a report comes from the phone that sent it, so treat it as untrusted.',
    'Reports are removed 30 days after they arrive.'
  );
  return { subject, text: lines.join('\n') };
}

// The span this digest covers: from where the last one stopped (or a day
// back) through now
function digestWindow(sentThrough, now) {
  const dayBack = new Date(now.getTime() - FIRST_LOOKBACK_HOURS * 3600 * 1000);
  const since = sentThrough && sentThrough < now ? sentThrough : dayBack;
  return { since, until: now };
}

// Reports created in (since, until], read from a bucket file listing
function reportsInWindow(files, { since, until }) {
  const reports = [];
  for (const file of files) {
    const parsed = parseReportPath(file.name);
    if (!parsed) continue;
    const createdAt = new Date(file.metadata?.timeCreated);
    if (Number.isNaN(createdAt.getTime()) || createdAt <= since || createdAt > until) continue;
    reports.push({
      ...parsed,
      createdAt,
      size: Number(file.metadata?.size) || 0,
      metadataVersion: clean(file.metadata?.metadata?.appVersion, 20),
      file,
    });
  }
  return reports;
}

// One digest run. Separate from the trigger so tests and the emulator check
// can run it with their own bucket, database, and mail.
async function runDigest({ bucket, db, sendMail, now = new Date(), Timestamp }) {
  const stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOC);
  const state = await stateRef.get();
  const sentThrough = state.exists ? state.data().sentThrough?.toDate?.() : null;
  const window = digestWindow(sentThrough, now);

  const [files] = await bucket.getFiles({ prefix: `${FOLDER}/`, autoPaginate: true });
  const reports = reportsInWindow(files, window);

  // Oldest first, so a flood's first reports are the ones read
  reports.sort((a, b) => a.createdAt - b.createdAt);
  for (const report of reports.slice(0, MAX_DESCRIBED)) {
    try {
      const [contents] = await report.file.download();
      report.summary = summarizeReport(contents.toString('utf8'));
    } catch (error) {
      report.readFailed = true;
      console.error(JSON.stringify({ event: 'error_report_read_failed', reportId: report.reportId, error: error.message }));
    }
  }

  const groups = groupDuplicates(reports);
  let emailed = false;
  if (groups.length > 0) {
    // If the email doesn't go out, the window stays open and tomorrow's
    // digest includes these reports.
    await sendMail(buildDigestEmail(groups));
    emailed = true;
  }
  await stateRef.set({ sentThrough: Timestamp.fromDate(window.until), lastRunAt: Timestamp.fromDate(now) }, { merge: true });

  // Report numbers only: never a UID, context, or note
  const result = {
    event: 'error_report_digest',
    reports: reports.length,
    groups: groups.length,
    duplicates: reports.length - groups.length,
    emailed,
    reportIds: reports.map((report) => report.reportId),
  };
  console.log(JSON.stringify(result));
  return result;
}

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

  function sendMail(message) {
    const mg = mailgun({ apiKey: mailgunApiKey.value(), domain: mailgunDomain });
    return new Promise((resolve, reject) => {
      mg.messages().send({
        from: 'vlrb <noreply@vlrb.app>',
        to: OWNER_REPORTS_EMAIL,
        subject: message.subject,
        text: message.text,
      }, (error, body) => (error ? reject(error) : resolve(body)));
    });
  }

  return {
    sendErrorReportDigest: onSchedule({
      schedule: '0 8 * * *', // Every day at 8 AM
      timeZone: 'America/Los_Angeles',
      region: 'us-central1',
      maxInstances: 1,
      memory: '512MiB',
      timeoutSeconds: 300,
      secrets: [mailgunApiKey],
    }, async () => {
      try {
        await runDigest({
          bucket: admin.storage().bucket(BUCKET),
          db,
          sendMail,
          Timestamp: admin.firestore.Timestamp,
        });
      } catch (error) {
        // Shows up in Cloud Logging; the next run covers the same reports
        console.error(JSON.stringify({ event: 'error_report_digest_failed', error: error.message }));
      }
    }),
  };
};

Object.assign(module.exports, {
  DUPLICATE_SECONDS,
  MAX_DESCRIBED,
  buildDigestEmail,
  clean,
  consoleLink,
  digestWindow,
  groupDuplicates,
  parseReportPath,
  reportsInWindow,
  runDigest,
  summarizeReport,
});
