const { test } = require('node:test');
const assert = require('node:assert/strict');

const reports = require('../reports.js');
const {
  HOURLY_EMAIL_CAP,
  REASON_LABELS,
  buildReportEmail,
  buildSummaryEmail,
  emailDecision,
  evidencePath,
  mailWindowId,
  parseUploadPath,
  uploadMatchesReport,
} = reports;

const REPORT_ID = '0F8FAD5B-D9CB-469F-A165-70867728950E';

// The document ReportService.swift writes
function report(overrides = {}) {
  return {
    id: REPORT_ID,
    reporterUserId: 'alice-uid',
    reportedUserId: 'bob-uid',
    reason: 'harassment',
    source: 'video',
    details: 'He keeps sending these at night.',
    chatId: 'chat-ab',
    messageId: 'message-1',
    videoAttached: true,
    status: 'pending',
    appVersion: '2.17.0',
    ...overrides,
  };
}

test('notifyOwnerOfReport listens for new reports, and moveReportedVideo for uploads', () => {
  const { notifyOwnerOfReport, moveReportedVideo } = reports({ admin: {}, db: {} });
  assert.ok(notifyOwnerOfReport.__endpoint.eventTrigger, 'expected an event trigger');
  assert.match(notifyOwnerOfReport.__endpoint.eventTrigger.eventType, /document\.v1\.created/);
  assert.equal(notifyOwnerOfReport.__endpoint.eventTrigger.eventFilterPathPatterns.document, 'reports/{reportId}');
  assert.match(moveReportedVideo.__endpoint.eventTrigger.eventType, /object\.v1\.finalized/);
  assert.equal(moveReportedVideo.__endpoint.eventTrigger.eventFilters.bucket, 'albondigas-8cfd9.appspot.com');
});

test('the email names no one and carries no content', () => {
  const { subject, text } = buildReportEmail(REPORT_ID, report());
  for (const secret of ['alice-uid', 'bob-uid', 'chat-ab', 'message-1', 'He keeps sending']) {
    assert.ok(!subject.includes(secret) && !text.includes(secret), `email leaked ${secret}`);
  }
  assert.match(text, new RegExp(REPORT_ID));
  assert.match(text, /Reason: Bullying or harassment/);
  assert.match(text, /About: A video/);
  assert.match(text, /Video shared: Yes/);
  assert.match(text, /Note: Yes, read it in the console/);
  assert.match(text, /console\.firebase\.google\.com\/project\/.+~2Freports~2F0F8FAD5B/);
});

test('a profile report without a note or video says so', () => {
  const { text } = buildReportEmail(REPORT_ID, report({ source: 'profile', details: undefined, videoAttached: false }));
  assert.match(text, /About: A profile/);
  assert.match(text, /Video shared: No/);
  assert.match(text, /Note: None/);
});

test('child-safety and self-harm reports are urgent, and child safety says not to download', () => {
  const child = buildReportEmail(REPORT_ID, report({ reason: 'child_safety' }));
  assert.match(child.subject, /^\[Urgent\] /);
  assert.match(child.text, /Don't download the video/);
  assert.match(child.text, /NCMEC/);

  assert.match(buildReportEmail(REPORT_ID, report({ reason: 'self_harm' })).subject, /^\[Urgent\] /);
  assert.doesNotMatch(buildReportEmail(REPORT_ID, report({ reason: 'spam' })).subject, /Urgent/);
});

test('every reason the rules accept has a label, and unknown ones read as something else', () => {
  const allowed = ['spam', 'harassment', 'sexual_content', 'violence', 'hate', 'self_harm', 'child_safety', 'something_else'];
  assert.deepEqual(Object.keys(REASON_LABELS).sort(), [...allowed].sort());
  assert.match(buildReportEmail(REPORT_ID, report({ reason: 'made_up' })).text, /Reason: Something else/);
});

test('emails stop at the hourly cap with one summary, but urgent reports always send', () => {
  assert.equal(emailDecision('spam', 0), 'send');
  assert.equal(emailDecision('spam', HOURLY_EMAIL_CAP - 1), 'send');
  assert.equal(emailDecision('spam', HOURLY_EMAIL_CAP), 'summary');
  assert.equal(emailDecision('spam', HOURLY_EMAIL_CAP + 1), 'skip');
  assert.equal(emailDecision('child_safety', 500), 'send');
  assert.equal(emailDecision('self_harm', 500), 'send');
  assert.match(buildSummaryEmail().text, /~2Freports$/m);
});

test('the mail window is the UTC hour', () => {
  assert.equal(mailWindowId(new Date('2026-11-02T14:59:59Z')), '2026110214');
  assert.equal(mailWindowId(new Date('2026-11-02T15:00:00Z')), '2026110215');
});

test('only report uploads are moved', () => {
  assert.deepEqual(parseUploadPath(`reportUploads/alice-uid/${REPORT_ID}`), { userId: 'alice-uid', reportId: REPORT_ID });
  assert.equal(parseUploadPath(`errorReports/alice-uid/K7QX-2M4P.txt`), null);
  assert.equal(parseUploadPath(`reportUploads/alice-uid/not-a-report`), null);
  assert.equal(parseUploadPath(`reportUploads/alice-uid/${REPORT_ID}/extra`), null);
  assert.equal(parseUploadPath(undefined), null);
});

test('evidence keeps the video type', () => {
  assert.equal(evidencePath(REPORT_ID, 'video/mp4'), `reportEvidence/${REPORT_ID}.mp4`);
  assert.equal(evidencePath(REPORT_ID, 'video/quicktime'), `reportEvidence/${REPORT_ID}.mov`);
});

test('an upload is kept only for the reporter\'s own report that shares a video', () => {
  const upload = { userId: 'alice-uid', reportId: REPORT_ID };
  assert.equal(uploadMatchesReport(upload, report()), true);
  assert.equal(uploadMatchesReport(upload, null), false);
  assert.equal(uploadMatchesReport(upload, report({ reporterUserId: 'mallory-uid' })), false);
  assert.equal(uploadMatchesReport(upload, report({ videoAttached: false })), false);
});
