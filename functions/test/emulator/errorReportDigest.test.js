// Runs the bug-report digest against the Storage and Firestore emulators:
// two reports uploaded as one tap sent twice, plus one from someone else.
// Mail is captured here, never sent. Run with `npm run test:emulator`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { runDigest } = require('../../errorReports.js');

const PROJECT = 'demo-vlrb';
const BUCKET = `${PROJECT}.appspot.com`;

// Personal details a real report carries, which the email must leave out
const EMAIL = 'tester@example.com';
const DEVICE = "Sam's iPhone";

function reportText(id) {
  return [
    `==================== VLRB REPORT ${id} ====================`,
    '- App Version: 2.17.8',
    '- Build Number: 452',
    `- Device Name: ${DEVICE}`,
    '==================== ERROR CONTEXT ====================',
    'User Action: User-initiated bug report',
    '==================== RECENT LOGS (Last 30 minutes) ====================',
    `[09:40:01] ℹ️ Signed in as ${EMAIL}`,
    '[09:40:02] ❌ Upload didn\'t work',
    '[09:40:03] ⚠️ Slow network',
    '==================== END OF LOGS ====================',
  ].join('\n');
}

test('a double tap uploaded to the emulator makes one email with no log in it', async () => {
  assert.ok(process.env.FIREBASE_STORAGE_EMULATOR_HOST, 'run this under firebase emulators:exec');
  const app = admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
  const bucket = admin.storage().bucket(BUCKET);
  const db = admin.firestore();

  for (const [uid, id] of [['tester-uid', 'U4E4-HX8A'], ['tester-uid', 'UU29-RGKA'], ['other-uid', 'K7QX-2M4P']]) {
    await bucket.file(`errorReports/${uid}/${id}.txt`).save(reportText(id), {
      contentType: 'text/plain',
      metadata: { metadata: { appVersion: '2.17.8', context: 'User-initiated bug report' } },
    });
  }
  // Something that isn't a report is skipped
  await bucket.file('reportUploads/tester-uid/whatever').save('not a report');

  const sent = [];
  const result = await runDigest({
    bucket,
    db,
    sendMail: async (message) => { sent.push(message); },
    Timestamp: admin.firestore.Timestamp,
  });

  assert.equal(sent.length, 1, 'expected one email');
  const { subject, text } = sent[0];
  assert.equal(subject, 'vlrb bug reports: 2 new');
  assert.match(text, /Report U4E4-HX8A and UU29-RGKA/);
  assert.match(text, /Report K7QX-2M4P/);
  assert.match(text, /App: 2\.17\.8 \(452\)/);
  assert.match(text, /Log: 1 error \(❌\), 1 warning \(⚠️\)/);
  for (const secret of [EMAIL, DEVICE, 'Signed in as', 'RECENT LOGS', 'Slow network']) {
    assert.ok(!subject.includes(secret) && !text.includes(secret), `email leaked ${secret}`);
  }
  assert.deepEqual([result.reports, result.groups, result.duplicates], [3, 2, 1]);

  // The window moved forward, so a second run right away sends nothing
  const again = await runDigest({ bucket, db, sendMail: async (message) => { sent.push(message); }, Timestamp: admin.firestore.Timestamp });
  assert.equal(again.emailed, false);
  assert.equal(sent.length, 1);

  await app.delete();
});
