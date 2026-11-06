const { test } = require('node:test');
const assert = require('node:assert/strict');

const errorReports = require('../errorReports.js');
const {
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
} = errorReports;

// Personal details a real report carries, which no email may include
const SECRETS = ['tester@example.com', "Sam's iPhone", 'alice-uid-secret-line', 'chat-ab-12345'];

// The text ErrorLogExporter uploads (ErrorReport.body + FieldTestingLogger.exportRecentLogs)
function reportText({ id = 'U4E4-HX8A', version = '2.17.8', build = '452', context = 'User-initiated bug report', note } = {}) {
  return [
    `==================== VLRB REPORT ${id} ====================`,
    'Submitted: 2026-11-06T17:41:03Z',
    '',
    '==================== VLRB ERROR REPORT ====================',
    'Generated: 11/6/26, 9:41 AM',
    '',
    'App Information:',
    `- App Version: ${version}`,
    `- Build Number: ${build}`,
    '- Bundle ID: com.vlrb.app',
    '',
    'Device Information:',
    '- Device Model: iPhone',
    `- Device Name: ${SECRETS[1]}`,
    '========================================================',
    '',
    '==================== ERROR CONTEXT ====================',
    `User Action: ${context}`,
    ...(note ? [`Note: ${note}`] : []),
    '',
    '==================== RECENT LOGS (Last 30 minutes) ====================',
    `[09:40:01] ℹ️ Signed in as ${SECRETS[0]}`,
    `[09:40:02] ❌ Upload didn't work for ${SECRETS[3]}`,
    `[09:40:03] ⚠️ ${SECRETS[2]}`,
    '[09:40:04] ❌ Something else went wrong',
    '',
    '==================== END OF LOGS ====================',
  ].join('\n');
}

test('sendErrorReportDigest runs every morning, Pacific time, with the Mailgun key', () => {
  const { sendErrorReportDigest } = errorReports({ admin: {}, db: {} });
  const endpoint = sendErrorReportDigest.__endpoint;
  assert.equal(endpoint.scheduleTrigger.schedule, '0 8 * * *');
  assert.equal(endpoint.scheduleTrigger.timeZone, 'America/Los_Angeles');
  assert.deepEqual(endpoint.secretEnvironmentVariables.map((secret) => secret.key), ['MAILGUN_API_KEY']);
});

test('only report files are read', () => {
  assert.deepEqual(parseReportPath('errorReports/alice-uid/U4E4-HX8A.txt'), { userId: 'alice-uid', reportId: 'U4E4-HX8A' });
  assert.equal(parseReportPath('errorReports/alice-uid/U4E4-HX8O.txt'), null, 'O is never in an ID');
  assert.equal(parseReportPath('errorReports/alice-uid/U4E4-HX8A.mp4'), null);
  assert.equal(parseReportPath('errorReports/U4E4-HX8A.txt'), null);
  assert.equal(parseReportPath('errorReports/alice-uid/extra/U4E4-HX8A.txt'), null);
  assert.equal(parseReportPath('reportUploads/alice-uid/U4E4-HX8A.txt'), null);
  assert.equal(parseReportPath(undefined), null);
});

test('a report is summarized without its log lines or device details', () => {
  const summary = summarizeReport(reportText({ note: 'The video froze after I tapped send.' }));
  assert.deepEqual(summary, {
    appVersion: '2.17.8',
    build: '452',
    context: 'User-initiated bug report',
    note: 'The video froze after I tapped send.',
    errors: 2,
    warnings: 1,
  });
  for (const secret of SECRETS) {
    assert.ok(!JSON.stringify(summary).includes(secret), `summary leaked ${secret}`);
  }
});

test('a report without a note or labels still summarizes', () => {
  assert.equal(summarizeReport(reportText()).note, null);
  assert.deepEqual(summarizeReport('just some text'), {
    appVersion: null, build: null, context: null, note: null, errors: 0, warnings: 0,
  });
  assert.equal(summarizeReport(undefined).errors, 0);
});

test('text from the phone stays on one line and is capped', () => {
  assert.equal(clean('Line one\r\nSubject: injected\u0007', 100), 'Line one Subject: injected');
  assert.equal(clean('a'.repeat(50), 10), `${'a'.repeat(9)}…`);
  assert.equal(clean('   ', 10), null);
  assert.equal(clean(undefined, 10), null);
  assert.equal(summarizeReport(reportText({ note: 'x'.repeat(2000) })).note.length, 500);
});

const at = (iso) => new Date(iso);

test('one tap sent twice is one report that names both numbers', () => {
  const groups = groupDuplicates([
    { userId: 'tester', reportId: 'UU29-RGKA', createdAt: at('2026-11-06T17:41:04Z') },
    { userId: 'tester', reportId: 'U4E4-HX8A', createdAt: at('2026-11-06T17:41:03Z') },
    { userId: 'tester', reportId: 'K7QX-2M4P', createdAt: at('2026-11-06T19:00:00Z') },
    { userId: 'someone-else', reportId: 'ABCD-EFGH', createdAt: at('2026-11-06T17:41:04Z') },
  ]);
  assert.deepEqual(groups.map((group) => group.map((report) => report.reportId)), [
    ['U4E4-HX8A', 'UU29-RGKA'],
    ['ABCD-EFGH'],
    ['K7QX-2M4P'],
  ]);
});

test('reports further apart than the duplicate window stay separate', () => {
  const groups = groupDuplicates([
    { userId: 'tester', reportId: 'AAAA-AAAA', createdAt: at('2026-11-06T17:00:00Z') },
    { userId: 'tester', reportId: 'BBBB-BBBB', createdAt: new Date(at('2026-11-06T17:00:00Z').getTime() + (DUPLICATE_SECONDS + 1) * 1000) },
  ]);
  assert.equal(groups.length, 2);
});

test('the digest names both numbers of a double tap and carries no log', () => {
  const summary = summarizeReport(reportText());
  const groups = groupDuplicates([
    { userId: 'tester-uid', reportId: 'U4E4-HX8A', createdAt: at('2026-11-06T17:41:03Z'), summary },
    { userId: 'tester-uid', reportId: 'UU29-RGKA', createdAt: at('2026-11-06T17:41:04Z'), summary },
  ]);
  const { subject, text } = buildDigestEmail(groups);
  assert.equal(subject, 'vlrb bug report U4E4-HX8A');
  assert.match(text, /Report U4E4-HX8A and UU29-RGKA/);
  assert.match(text, /Sent 2 times within 1 second, so it's one tap sent more than once/);
  assert.match(text, /Sent: Fri, Nov 6, 9:41 AM PST/);
  assert.match(text, /App: 2\.17\.8 \(452\)/);
  assert.match(text, /What they were doing: User-initiated bug report/);
  assert.match(text, /Their note: None/);
  assert.match(text, /Log: 2 errors \(❌\), 1 warning \(⚠️\)/);
  assert.match(text, /console\.firebase\.google\.com\/project\/.+\/storage\/.+\/files\/~2FerrorReports~2Ftester-uid/);
  for (const secret of SECRETS) {
    assert.ok(!subject.includes(secret) && !text.includes(secret), `email leaked ${secret}`);
  }
  assert.doesNotMatch(text, /Signed in as|RECENT LOGS|Device Name/);
});

test('several reports get a count in the subject', () => {
  const groups = [
    [{ userId: 'a', reportId: 'AAAA-AAAA', createdAt: at('2026-11-06T17:00:00Z'), summary: summarizeReport('') }],
    [{ userId: 'b', reportId: 'BBBB-BBBB', createdAt: at('2026-11-06T18:00:00Z'), metadataVersion: '2.17.8' }],
  ];
  const { subject, text } = buildDigestEmail(groups);
  assert.equal(subject, 'vlrb bug reports: 2 new');
  assert.match(text, /What they were doing: Not given/);
  assert.match(text, /App: 2\.17\.8\n {2}Not read, because the digest reads at most 50 reports/);
});

test('the console link encodes the UID as one path segment', () => {
  assert.match(consoleLink('a/b'), /~2FerrorReports~2Fa%2Fb$/);
});

test('the digest covers from the last one through now, or a day back', () => {
  const now = at('2026-11-07T16:00:00Z');
  assert.deepEqual(digestWindow(null, now), { since: at('2026-11-06T16:00:00Z'), until: now });
  assert.deepEqual(digestWindow(at('2026-11-05T16:00:00Z'), now), { since: at('2026-11-05T16:00:00Z'), until: now });
  assert.deepEqual(digestWindow(at('2026-11-08T00:00:00Z'), now), { since: at('2026-11-06T16:00:00Z'), until: now });
});

test('only reports inside the window are picked up', () => {
  const file = (name, timeCreated) => ({ name, metadata: { timeCreated, size: '10', metadata: { appVersion: '2.17.8' } } });
  const reports = reportsInWindow([
    file('errorReports/u/AAAA-AAAA.txt', '2026-11-06T16:00:00Z'), // exactly at since: already sent
    file('errorReports/u/BBBB-BBBB.txt', '2026-11-06T17:00:00Z'),
    file('errorReports/u/CCCC-CCCC.txt', '2026-11-07T17:00:00Z'), // after until
    file('errorReports/u/not-a-report.txt', '2026-11-06T17:00:00Z'),
    file('errorReports/u/DDDD-DDDD.txt', 'garbage'),
  ], { since: at('2026-11-06T16:00:00Z'), until: at('2026-11-07T16:00:00Z') });
  assert.deepEqual(reports.map((report) => report.reportId), ['BBBB-BBBB']);
  assert.equal(reports[0].metadataVersion, '2.17.8');
  assert.equal(reports[0].size, 10);
});

// In-memory stand-ins for the bucket and Firestore
function fakes(files, stateData = null) {
  const state = { data: stateData };
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: state.data !== null, data: () => state.data }),
        set: async (value) => { state.data = { ...(state.data || {}), ...value }; },
      }),
    }),
  };
  const bucket = {
    getFiles: async () => [files.map(({ name, timeCreated, text, unreadable }) => ({
      name,
      metadata: { timeCreated, size: String(text.length), metadata: { appVersion: '2.17.8' } },
      download: async () => {
        if (unreadable) throw new Error('nope');
        return [Buffer.from(text)];
      },
    }))],
  };
  const Timestamp = { fromDate: (date) => ({ toDate: () => date }) };
  const sent = [];
  const sendMail = async (message) => { sent.push(message); };
  return { db, bucket, Timestamp, sent, sendMail, state };
}

test('a run with a double tap sends one email and moves the window forward', async () => {
  const now = at('2026-11-07T16:00:00Z');
  const deps = fakes([
    { name: 'errorReports/tester/U4E4-HX8A.txt', timeCreated: '2026-11-06T17:41:03Z', text: reportText() },
    { name: 'errorReports/tester/UU29-RGKA.txt', timeCreated: '2026-11-06T17:41:04Z', text: reportText({ id: 'UU29-RGKA' }) },
  ]);
  const result = await runDigest({ ...deps, now });
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0].text, /U4E4-HX8A and UU29-RGKA/);
  assert.deepEqual({ ...result, reportIds: undefined }, {
    event: 'error_report_digest', reports: 2, groups: 1, duplicates: 1, emailed: true, reportIds: undefined,
  });
  assert.equal(deps.state.data.sentThrough.toDate().toISOString(), now.toISOString());

  // The next morning has nothing new, so nothing is sent
  const next = await runDigest({ ...deps, now: at('2026-11-08T16:00:00Z') });
  assert.equal(next.emailed, false);
  assert.equal(deps.sent.length, 1);
});

test('when the email does not go out, the next run covers the same reports', async () => {
  const deps = fakes([
    { name: 'errorReports/tester/U4E4-HX8A.txt', timeCreated: '2026-11-06T17:41:03Z', text: reportText() },
  ], { sentThrough: { toDate: () => at('2026-11-06T16:00:00Z') } });
  await assert.rejects(runDigest({ ...deps, sendMail: async () => { throw new Error('mailgun down'); }, now: at('2026-11-07T16:00:00Z') }));
  assert.equal(deps.state.data.sentThrough.toDate().toISOString(), '2026-11-06T16:00:00.000Z');
  await runDigest({ ...deps, now: at('2026-11-08T16:00:00Z') });
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0].text, /U4E4-HX8A/);
});

test('a report that can\'t be read is still listed', async () => {
  const deps = fakes([
    { name: 'errorReports/tester/U4E4-HX8A.txt', timeCreated: '2026-11-06T17:41:03Z', text: '', unreadable: true },
  ]);
  await runDigest({ ...deps, now: at('2026-11-07T16:00:00Z') });
  assert.match(deps.sent[0].text, /U4E4-HX8A\n {2}Sent: .+\n {2}App: 2\.17\.8\n {2}Couldn't be read/);
});

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

test('a flood is read only up to the cap', async () => {
  const files = Array.from({ length: MAX_DESCRIBED + 2 }, (_, index) => ({
    name: `errorReports/user${index}/AAAA-${ALPHABET[Math.floor(index / 32)]}${ALPHABET[index % 32]}22.txt`,
    timeCreated: new Date(at('2026-11-06T17:00:00Z').getTime() + index * 60000).toISOString(),
    text: reportText(),
  }));
  let downloads = 0;
  const deps = fakes(files);
  const [listing] = await deps.bucket.getFiles();
  for (const file of listing) {
    const original = file.download;
    file.download = async () => { downloads += 1; return original(); };
  }
  deps.bucket.getFiles = async () => [listing];
  const result = await runDigest({ ...deps, now: at('2026-11-07T16:00:00Z') });
  assert.equal(result.reports, MAX_DESCRIBED + 2);
  assert.equal(new Set(result.reportIds).size, MAX_DESCRIBED + 2);
  assert.equal(downloads, MAX_DESCRIBED);
  assert.equal((deps.sent[0].text.match(/Not read, because/g) || []).length, 2);
});
