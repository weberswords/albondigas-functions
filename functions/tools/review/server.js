#!/usr/bin/env node
// Local report review page. Runs on this Mac only, with the owner's own
// Google credentials, and writes nothing but a report's outcome and note and
// a reporter's reportingSuspended flag. See README.md.
//
//   gcloud auth application-default login
//   node functions/tools/review/server.js
const http = require('node:http');
const crypto = require('node:crypto');
const {
  isReportId,
  outcomeUpdate,
  parseRange,
  renderMessage,
  renderQueue,
  renderReport,
  reportingUpdate,
  sortQueue,
  videoAccess,
} = require('./review.js');

const PROJECT_ID = 'albondigas-8cfd9';
const BUCKET = 'albondigas-8cfd9.appspot.com';
const MAX_FORM_BYTES = 8 * 1024;
const QUEUE_LIMIT = 300;

// No scripts at all; styles inline; video only from this server
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; "
    + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null"
  // on the outcome forms, and the token in links never leaves this server anyway
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
};

function sameToken(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        reject(new Error('form too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object} deps.bucket A Cloud Storage bucket
 * @param {string} deps.token Required on every request
 * @param {number} deps.port Used to check Host and Origin
 * @param {(line: object) => void} [deps.log]
 */
function createReviewServer({ db, bucket, token, port, log = (line) => console.log(JSON.stringify(line)) }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  }

  async function loadReport(reportId) {
    const snapshot = await db.collection('reports').doc(reportId).get();
    return snapshot.exists ? { id: reportId, ...snapshot.data() } : null;
  }

  async function data(collection, id) {
    if (!id) return null;
    const snapshot = await db.collection(collection).doc(id).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async function streamVideo(req, res, report) {
    const file = bucket.file(report.evidencePath);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size) || 0;
    const type = metadata.contentType === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
    const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' };

    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (req.headers.range && !range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (range) {
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': range.end - range.start + 1 });
      file.createReadStream({ start: range.start, end: range.end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    file.createReadStream().on('error', () => res.destroy()).pipe(res);
  }

  async function handle(req, res) {
    // Another site can't reach this page through DNS tricks or a form post
    if (!allowedHosts.has(req.headers.host)) return send(res, 421, 'Wrong host');
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(res, 403, 'Wrong origin');

    const url = new URL(req.url, `http://${req.headers.host}`);
    const form = req.method === 'POST' ? await readForm(req) : {};
    const given = req.method === 'POST' ? form.t : url.searchParams.get('t');
    if (!sameToken(given, token)) {
      return send(res, 403, renderMessage('Open the link from the terminal',
        'This page needs the address the review server printed when it started.'));
    }

    const back = (reportId) => ({ Location: `/report/${reportId}?t=${encodeURIComponent(token)}` });
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parts.length === 0) {
      const snapshot = await db.collection('reports').orderBy('reportedAt', 'desc').limit(QUEUE_LIMIT).get();
      const reports = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      return send(res, 200, renderQueue(sortQueue(reports), token));
    }

    const [kind, reportId, action] = parts;
    if (!isReportId(reportId)) return send(res, 404, renderMessage('Not found', 'There\'s no report at that address.', token));
    const report = await loadReport(reportId);
    if (!report) return send(res, 404, renderMessage('Not found', 'There\'s no report with that ID.', token));

    if (req.method === 'GET' && kind === 'report' && !action) {
      const [reported, reporter, moderation] = await Promise.all([
        data('users', report.reportedUserId), data('users', report.reporterUserId), data('moderation', report.reporterUserId),
      ]);
      return send(res, 200, renderReport({ report, reported, reporter, moderation }, token));
    }

    if (req.method === 'GET' && kind === 'video' && !action) {
      if (videoAccess(report) !== 'playable') return send(res, 403, 'This video isn\'t shown here');
      return streamVideo(req, res, report);
    }

    if (req.method === 'POST' && kind === 'report' && action === 'outcome') {
      const update = outcomeUpdate(form);
      if (!update) return send(res, 400, renderMessage('Choose an outcome', 'Pick Took Action, No Action, or False Report.', token));
      // recordReportOutcome (reports.js) keeps the audit trail and the counts
      await db.collection('reports').doc(reportId).update(update);
      log({ event: 'review_outcome_set', reportId, outcome: update.outcome });
      res.writeHead(303, { ...SECURITY_HEADERS, ...back(reportId) });
      return res.end();
    }

    if (req.method === 'POST' && kind === 'report' && action === 'reporting') {
      const update = reportingUpdate(form);
      if (!update || !report.reporterUserId) return send(res, 400, renderMessage('Nothing changed', 'That didn\'t say whether to turn reporting on or off.', token));
      await db.collection('moderation').doc(report.reporterUserId).set(update, { merge: true });
      log({ event: 'review_reporting_set', reportId, reportingSuspended: update.reportingSuspended });
      res.writeHead(303, { ...SECURITY_HEADERS, ...back(reportId) });
      return res.end();
    }

    return send(res, 404, renderMessage('Not found', 'There\'s nothing at that address.', token));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log({ event: 'review_error', error: error.message });
      if (!res.headersSent) send(res, 500, renderMessage('Something went wrong', `${error.message}. Check the terminal.`, token));
      else res.destroy();
    });
  });
}

module.exports = { createReviewServer, SECURITY_HEADERS };

if (require.main === module) {
  const admin = require('firebase-admin');
  // REVIEW_PROJECT points it at the emulators (with FIRESTORE_EMULATOR_HOST
  // and FIREBASE_STORAGE_EMULATOR_HOST) to try it without real reports
  const projectId = process.env.REVIEW_PROJECT || PROJECT_ID;
  const bucketName = process.env.REVIEW_PROJECT ? `${projectId}.appspot.com` : BUCKET;
  admin.initializeApp({ projectId, storageBucket: bucketName });
  const port = Number(process.env.REVIEW_PORT) || 8765;
  const token = crypto.randomBytes(24).toString('hex');
  const server = createReviewServer({
    db: admin.firestore(),
    bucket: admin.storage().bucket(bucketName),
    token,
    port,
  });
  // 127.0.0.1 only: nothing else on the network can reach it
  server.listen(port, '127.0.0.1', () => {
    console.log(`Report review is running. Open:\n\n  http://127.0.0.1:${port}/?t=${token}\n\nPress Control-C to stop.`);
  });
}
