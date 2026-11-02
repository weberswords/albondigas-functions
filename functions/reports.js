// Reports from the app (albondigas ReportService.swift). The app writes
// reports/{reportId} and, if the reporter chose to share the video, uploads it
// to reportUploads/{uid}/{reportId}. Rules for both live in the albondigas
// repo (firestore.rules, storage.rules), and docs/REPORTING.md there covers
// the whole path and its threat model.
//
// notifyOwnerOfReport emails the owner when a report arrives. The email names
// no one and carries no content: just the report ID, the reason, and a console
// link that needs the owner's sign-in. moveReportedVideo moves a shared video
// out of the client-writable folder into reportEvidence/, which no client rule
// matches, and records where it went on the report.
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
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
function buildReportEmail(reportId, report) {
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
    '',
    'Open it in the Firebase console (you need to sign in):',
    consoleLink(`reports/${reportId}`),
    '',
    'Everything in a report comes from the reporter, so treat it as untrusted.',
  ];
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

      let emailed = false;
      if (decision !== 'skip') {
        const message = decision === 'summary' ? buildSummaryEmail() : buildReportEmail(reportId, report);
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
  HOURLY_EMAIL_CAP,
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
