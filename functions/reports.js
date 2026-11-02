// Reports from the app (albondigas ReportService.swift). The app writes
// reports/{reportId} and, if the reporter chose to share the video, uploads it
// to reportUploads/{uid}/{reportId}. Rules for both live in the albondigas
// repo (firestore.rules, storage.rules), and docs/REPORTING.md there covers
// the whole path and its threat model.
//
// notifyOwnerOfReport emails the owner when a report arrives. The email names
// no one and carries no content: just the report ID, the reason, how this
// reporter's earlier reports were judged, and a console link that needs the
// owner's sign-in. For a video report it also records when the original file
// was stored, so a file swapped in after sending stands out. moveReportedVideo
// moves a shared video out of the client-writable folder into reportEvidence/,
// which no client rule matches. recordReportOutcome keeps the audit trail when
// the owner sets a report's outcome, and counts false reports per reporter.
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const mailgun = require('./mailer');

const mailgunApiKey = defineSecret('MAILGUN_API_KEY');
const mailgunDomain = 'mail.vlrb.app';

// Where report notifications go. A forward, so changing who reads reports
// doesn't need a deploy.
const OWNER_REPORTS_EMAIL = 'support@vlrb.app';

// After this many report emails in one hour, send one summary and stop until
// the next hour, so a flood can't bury the inbox. Urgent reasons always email.
const HOURLY_EMAIL_CAP = 20;

// The default bucket, the same one index.js gives admin.initializeApp
const BUCKET = 'albondigas-8cfd9.appspot.com';
const UPLOAD_FOLDER = 'reportUploads';
const EVIDENCE_FOLDER = 'reportEvidence';

// Matches ReportReason.label in the app
const REASON_LABELS = {
  spam: 'Spam or a scam',
  harassment: 'Bullying or harassment',
  sexual_content: 'Nudity or sexual content',
  violence: 'Violence or threats',
  hate: 'Hate toward who someone is',
  self_harm: 'Self-harm or suicide',
  child_safety: 'Puts a child at risk',
  something_else: 'Something else',
};

// Reasons that can't wait: someone may be in danger, or the law sets a duty
// to act (child safety, 18 U.S.C. 2258A).
const URGENT_REASONS = new Set(['child_safety', 'self_harm']);

// What the owner can set as a report's outcome, in the console
const OUTCOMES = ['action_taken', 'no_action', 'false_report'];

// After this many false reports from one person, the owner is emailed to
// consider turning off their reporting (moderation/{uid}.reportingSuspended).
// A person decides; nothing is turned off on its own.
const FALSE_REPORT_ALERT = 3;

// The app uploads a video before it writes the message, so the stored file
// is older than the message. One created long after it was replaced.
const REPLACED_AFTER_MINUTES = 60;

const REPORT_ID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

function projectId() {
  return process.env.GCLOUD_PROJECT || 'albondigas-8cfd9';
}

function consoleLink(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('~2F');
  return `https://console.firebase.google.com/project/${projectId()}/firestore/databases/-default-/data/~2F${encoded}`;
}

// The hour a report email counts against, in UTC, like 2026110214
function mailWindowId(date) {
  return date.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

// Whether to email about a report, given how many report emails already went
// out this hour: 'send', 'summary' (the one email that says the cap was
// reached), or 'skip'.
function emailDecision(reason, sentThisHour) {
  if (URGENT_REASONS.has(reason)) return 'send';
  if (sentThisHour < HOURLY_EMAIL_CAP) return 'send';
  if (sentThisHour === HOURLY_EMAIL_CAP) return 'summary';
  return 'skip';
}

// The owner email for one report. Leaves out names, UIDs, and the note: the
// email passes through Mailgun and an inbox, and the console link needs the
// owner's sign-in to show the rest.
function buildReportEmail(reportId, report, history = null, original = null) {
  const reason = REASON_LABELS[report.reason] || 'Something else';
  const urgent = URGENT_REASONS.has(report.reason);
  const subject = `${urgent ? '[Urgent] ' : ''}vlrb report: ${reason} (${reportId.slice(0, 8)})`;
  const source = report.source === 'video' ? 'A video' : 'A profile';
  const video = report.videoAttached
    ? 'Yes. It moves to reportEvidence/ when it finishes uploading.'
    : 'No';
  const lines = [
    'Someone sent a report in vlrb.',
    '',
    `Report: ${reportId}`,
    `Reason: ${reason}`,
    `About: ${source}`,
    `Video shared: ${video}`,
    `Note: ${report.details ? 'Yes, read it in the console' : 'None'}`,
    `This person's earlier reports: ${describeHistory(history)}`,
  ];
  if (original) {
    lines.push(`Original video: ${describeOriginal(original)}`);
  }
  lines.push(
    '',
    'Open it in the Firebase console (you need to sign in):',
    consoleLink(`reports/${reportId}`),
    '',
    'Everything in a report comes from the reporter, so treat it as untrusted.'
  );
  if (report.reason === 'child_safety') {
    lines.push(
      '',
      'This is a child-safety report. Don\'t download the video. Follow the',
      'child-safety steps in albondigas docs/REPORTING.md, which include',
      'reporting to the NCMEC CyberTipline.'
    );
  }
  return { subject, text: lines.join('\n') };
}

function buildSummaryEmail() {
  return {
    subject: `vlrb reports: more than ${HOURLY_EMAIL_CAP} this hour`,
    text: [
      `More than ${HOURLY_EMAIL_CAP} reports arrived this hour, so vlrb stopped emailing`,
      'each one until the next hour. Urgent reports still email.',
      '',
      'See them all in the Firebase console (you need to sign in):',
      consoleLink('reports'),
    ].join('\n'),
  };
}

// How this reporter's earlier reports were judged, without naming them
function describeHistory(history) {
  if (!history || !history.reportsReviewed) return 'None reviewed yet';
  const reviewed = history.reportsReviewed;
  const falseReports = history.falseReports || 0;
  const suffix = history.reportingSuspended ? '. Reporting is turned off for them.' : '';
  return `${reviewed} reviewed, ${falseReports} false${suffix}`;
}

function describeOriginal(original) {
  if (!original.found) return 'Not found in Storage (removed, or the message has none)';
  if (original.replacedAfterSend) {
    return `Stored ${original.minutesAfterMessage} minutes after the message was sent. It may have been replaced, so check it.`;
  }
  return 'Stored when it was sent';
}

// The Storage path inside a Firebase download URL
// (https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media&token=...)
function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/o\/([^?]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return null;
  }
}

// What the server can say about the reported message's original file. It
// can't decrypt it, but Storage's own creation time can't be set by a client.
function checkOriginal(message, fileMetadata) {
  const path = storagePathFromUrl(message?.encryptedVideoUrl) || storagePathFromUrl(message?.videoUrl);
  if (!path || !fileMetadata) return { found: false, path: path || null };
  const createdAt = message.createdAt?.toDate ? message.createdAt.toDate() : null;
  const storedAt = new Date(fileMetadata.timeCreated);
  const minutesAfterMessage = createdAt ? Math.round((storedAt - createdAt) / 60000) : null;
  return {
    found: true,
    path,
    storedAt: fileMetadata.timeCreated,
    md5Hash: fileMetadata.md5Hash || null,
    size: Number(fileMetadata.size) || 0,
    minutesAfterMessage,
    replacedAfterSend: minutesAfterMessage !== null && minutesAfterMessage > REPLACED_AFTER_MINUTES,
  };
}

// How a new or changed outcome moves the reporter's counts
function outcomeChange(before, after) {
  const beforeOutcome = OUTCOMES.includes(before?.outcome) ? before.outcome : null;
  const afterOutcome = OUTCOMES.includes(after?.outcome) ? after.outcome : null;
  if (!afterOutcome || beforeOutcome === afterOutcome) return null;
  return {
    outcome: afterOutcome,
    reviewedDelta: beforeOutcome ? 0 : 1,
    falseDelta: (afterOutcome === 'false_report' ? 1 : 0) - (beforeOutcome === 'false_report' ? 1 : 0),
  };
}

function buildFalseReportAlert(reportId, falseReports) {
  return {
    subject: `vlrb reports: one person's reports were false ${falseReports} times`,
    text: [
      `You've marked ${falseReports} reports from the same person as false. The latest is`,
      `report ${reportId}.`,
      '',
      'To turn off their reporting, open that report, copy its reporterUserId, and set',
      'reportingSuspended to true on moderation/{that ID} in the Firebase console.',
      'Nothing changes until you do. See docs/REPORTING.md in albondigas.',
      '',
      consoleLink(`reports/${reportId}`),
    ].join('\n'),
  };
}

// reportUploads/{uid}/{reportId} -> { userId, reportId }, or null for any
// other object
function parseUploadPath(name) {
  const parts = (name || '').split('/');
  if (parts.length !== 3 || parts[0] !== UPLOAD_FOLDER) return null;
  const [, userId, reportId] = parts;
  if (!userId || !REPORT_ID_PATTERN.test(reportId)) return null;
  return { userId, reportId };
}

function evidencePath(reportId, contentType) {
  const extension = contentType === 'video/quicktime' ? 'mov' : 'mp4';
  return `${EVIDENCE_FOLDER}/${reportId}.${extension}`;
}

// Whether an upload belongs to this report. The Storage rule already checks
// this; the function checks again before it keeps anything.
function uploadMatchesReport(upload, report) {
  return Boolean(report)
    && report.reporterUserId === upload.userId
    && report.videoAttached === true;
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

  async function readHistory(reporterUserId) {
    const snapshot = await db.collection('moderation').doc(reporterUserId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  // Looks up the reported message's original file and records what Storage
  // says about it on the report, before anyone can act on the report.
  async function recordOriginal(reportRef, report) {
    try {
      const messageSnapshot = await db.collection('chats').doc(report.chatId)
        .collection('messages').doc(report.messageId).get();
      const message = messageSnapshot.data();
      const path = storagePathFromUrl(message?.encryptedVideoUrl) || storagePathFromUrl(message?.videoUrl);
      let fileMetadata = null;
      if (path) {
        const [exists] = await admin.storage().bucket(BUCKET).file(path).exists();
        if (exists) [fileMetadata] = await admin.storage().bucket(BUCKET).file(path).getMetadata();
      }
      const original = checkOriginal(message, fileMetadata);
      await reportRef.update({ originalCheck: { ...original, checkedAt: admin.firestore.Timestamp.now() } });
      return original;
    } catch (error) {
      console.error(JSON.stringify({ event: 'report_original_check_failed', reportId: report.id, error: error.message }));
      return null;
    }
  }

  return {
    notifyOwnerOfReport: onDocumentCreated({
      region: 'us-central1',
      document: 'reports/{reportId}',
      secrets: [mailgunApiKey],
    }, async (event) => {
      const reportId = event.params.reportId;
      const report = event.data?.data();
      if (!report) return;

      const reportRef = db.collection('reports').doc(reportId);
      const notificationRef = db.collection('reportNotifications').doc(reportId);
      const windowRef = db.collection('reportMailWindow').doc(mailWindowId(new Date()));

      // Triggers can run more than once, so the transaction records each
      // report's notification and counts this hour's emails in one step.
      const decision = await db.runTransaction(async (tx) => {
        const [notification, window, current] = await Promise.all([
          tx.get(notificationRef), tx.get(windowRef), tx.get(reportRef),
        ]);
        if (notification.exists) return 'duplicate';

        const sent = window.exists ? (window.data().sent || 0) : 0;
        const result = emailDecision(report.reason, sent);
        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(notificationRef, { decision: result, createdAt: now });
        if (result !== 'skip') {
          tx.set(windowRef, { sent: sent + 1, updatedAt: now }, { merge: true });
        }
        // moveReportedVideo may have finished first and set 'stored'
        if (current.exists && !current.data().videoStatus) {
          tx.update(reportRef, { videoStatus: report.videoAttached ? 'awaiting' : 'none' });
        }
        return result;
      });

      if (decision === 'duplicate') return;

      const history = await readHistory(report.reporterUserId);
      const original = report.source === 'video' ? await recordOriginal(reportRef, report) : null;

      let emailed = false;
      if (decision !== 'skip') {
        const message = decision === 'summary'
          ? buildSummaryEmail()
          : buildReportEmail(reportId, report, history, original);
        try {
          await sendMail(message);
          emailed = true;
        } catch (error) {
          // The report is saved either way; this shows up in Cloud Logging.
          console.error(JSON.stringify({ event: 'report_email_failed', reportId, error: error.message }));
        }
      }

      // Never the note or anyone's ID besides the report's
      console.log(JSON.stringify({
        event: 'report_received',
        reportId,
        reason: report.reason,
        source: report.source,
        videoAttached: report.videoAttached === true,
        decision,
        emailed,
        originalReplaced: original?.replacedAfterSend === true,
      }));
    }),

    recordReportOutcome: onDocumentUpdated({
      region: 'us-central1',
      document: 'reports/{reportId}',
      secrets: [mailgunApiKey],
    }, async (event) => {
      const reportId = event.params.reportId;
      const before = event.data?.before?.data();
      const after = event.data?.after?.data();
      const change = outcomeChange(before, after);
      if (!change || !after.reporterUserId) return;

      const reviewRef = db.collection('reportReviews').doc(reportId);
      const moderationRef = db.collection('moderation').doc(after.reporterUserId);

      // One transaction per event, recorded by event ID, so a retried trigger
      // can't count the same decision twice.
      const falseReports = await db.runTransaction(async (tx) => {
        const [review, moderation] = await Promise.all([tx.get(reviewRef), tx.get(moderationRef)]);
        if ((review.data()?.eventIds || []).includes(event.id)) return null;

        const counts = moderation.data() || {};
        const nextFalse = Math.max(0, (counts.falseReports || 0) + change.falseDelta);
        const now = admin.firestore.Timestamp.now();
        tx.set(reviewRef, {
          reportId,
          outcome: change.outcome,
          updatedAt: now,
          history: admin.firestore.FieldValue.arrayUnion({ outcome: change.outcome, at: now }),
          eventIds: admin.firestore.FieldValue.arrayUnion(event.id),
        }, { merge: true });
        tx.set(moderationRef, {
          reportsReviewed: (counts.reportsReviewed || 0) + change.reviewedDelta,
          falseReports: nextFalse,
          updatedAt: now,
        }, { merge: true });
        return change.falseDelta > 0 ? nextFalse : null;
      });

      if (falseReports === FALSE_REPORT_ALERT) {
        try {
          await sendMail(buildFalseReportAlert(reportId, falseReports));
        } catch (error) {
          console.error(JSON.stringify({ event: 'false_report_alert_failed', reportId, error: error.message }));
        }
      }

      console.log(JSON.stringify({
        event: 'report_reviewed',
        reportId,
        outcome: change.outcome,
        falseReportAlert: falseReports === FALSE_REPORT_ALERT,
      }));
    }),

    moveReportedVideo: onObjectFinalized({
      bucket: BUCKET,
      region: 'us-central1',
      memory: '512MiB',
      timeoutSeconds: 300,
    }, async (event) => {
      const upload = parseUploadPath(event.data.name);
      if (!upload) return;

      const bucket = admin.storage().bucket(event.data.bucket);
      const staged = bucket.file(event.data.name);
      const reportRef = db.collection('reports').doc(upload.reportId);
      const reportSnapshot = await reportRef.get();
      const report = reportSnapshot.exists ? reportSnapshot.data() : null;

      if (!uploadMatchesReport(upload, report)) {
        await staged.delete({ ignoreNotFound: true });
        console.warn(JSON.stringify({ event: 'report_video_rejected', reportId: upload.reportId }));
        return;
      }

      const destination = evidencePath(upload.reportId, event.data.contentType);
      try {
        await staged.copy(bucket.file(destination));
      } catch (error) {
        // A retried event can arrive after the staged copy is gone
        if (error.code === 404) return;
        throw error;
      }
      await staged.delete({ ignoreNotFound: true });
      await reportRef.update({
        videoStatus: 'stored',
        evidencePath: destination,
        videoBytes: Number(event.data.size) || 0,
      });

      console.log(JSON.stringify({ event: 'report_video_stored', reportId: upload.reportId }));
    }),
  };
};

Object.assign(module.exports, {
  FALSE_REPORT_ALERT,
  HOURLY_EMAIL_CAP,
  OUTCOMES,
  buildFalseReportAlert,
  checkOriginal,
  describeHistory,
  outcomeChange,
  storagePathFromUrl,
  OWNER_REPORTS_EMAIL,
  REASON_LABELS,
  buildReportEmail,
  buildSummaryEmail,
  emailDecision,
  evidencePath,
  mailWindowId,
  parseUploadPath,
  uploadMatchesReport,
});
