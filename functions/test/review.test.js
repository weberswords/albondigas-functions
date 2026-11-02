const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  escapeHtml,
  isReportId,
  outcomeUpdate,
  parseRange,
  renderQueue,
  renderReport,
  reportingUpdate,
  sortQueue,
  videoAccess,
} = require('../tools/review/review.js');
const { createReviewServer } = require('../tools/review/server.js');

const ID = '0F8FAD5B-D9CB-469F-A165-70867728950E';
const CHILD_ID = '1C6B9F3A-0D2E-4B7C-9A1F-2E3D4C5B6A70';
const TOKEN = 'a'.repeat(48);

function report(overrides = {}) {
  return {
    id: ID,
    reporterUserId: 'alice-uid',
    reportedUserId: 'bob-uid',
    reason: 'harassment',
    source: 'video',
    details: 'He keeps sending these.',
    chatId: 'chat-ab',
    messageId: 'message-1',
    videoAttached: true,
    videoStatus: 'stored',
    evidencePath: `reportEvidence/${ID}.mp4`,
    reportedAt: new Date('2026-11-02T10:00:00Z'),
    status: 'pending',
    ...overrides,
  };
}

// MARK: - What the page shows

test('waiting reports put urgent ones first, then the oldest', () => {
  const { waiting, reviewed } = sortQueue([
    report({ id: 'spam-new', reason: 'spam', reportedAt: new Date('2026-11-03') }),
    report({ id: 'spam-old', reason: 'spam', reportedAt: new Date('2026-11-01') }),
    report({ id: 'urgent', reason: 'self_harm', reportedAt: new Date('2026-11-04') }),
    report({ id: 'done', outcome: 'no_action' }),
    report({ id: 'typo', outcome: 'no action' }),
  ]);
  assert.deepEqual(waiting.map((r) => r.id), ['urgent', 'spam-old', 'typo', 'spam-new'],
    'A misspelled outcome still counts as waiting');
  assert.deepEqual(reviewed.map((r) => r.id), ['done']);
});

test('child-safety videos are never playable here', () => {
  assert.equal(videoAccess(report()), 'playable');
  assert.equal(videoAccess(report({ reason: 'child_safety' })), 'withheld');
  assert.equal(videoAccess(report({ videoStatus: 'awaiting' })), 'awaiting');
  assert.equal(videoAccess(report({ videoAttached: false, videoStatus: 'none', evidencePath: undefined })), 'none');
  assert.equal(videoAccess(report({ evidencePath: 'encrypted_videos/chat-ab/x.enc' })), 'awaiting',
    'Only files in reportEvidence/ can play');
});

test('only the three outcomes and the suspension flag can be written', () => {
  assert.deepEqual(outcomeUpdate({ outcome: 'false_report', reviewNote: '  Made up.  ' }), { outcome: 'false_report', reviewNote: 'Made up.' });
  assert.deepEqual(outcomeUpdate({ outcome: 'no_action', reviewNote: '' }), { outcome: 'no_action' });
  assert.equal(outcomeUpdate({ outcome: 'delete_everything' }), null);
  assert.equal(outcomeUpdate({}), null);
  assert.equal(outcomeUpdate({ outcome: 'no_action', reviewNote: 'x'.repeat(2000) }).reviewNote.length, 1000);
  assert.deepEqual(reportingUpdate({ reportingSuspended: 'on' }), { reportingSuspended: true });
  assert.deepEqual(reportingUpdate({ reportingSuspended: 'off' }), { reportingSuspended: false });
  assert.equal(reportingUpdate({ reportingSuspended: 'true' }), null);
});

test('report IDs must be the uppercase UUIDs the rules allow', () => {
  assert.equal(isReportId(ID), true);
  assert.equal(isReportId(ID.toLowerCase()), false);
  assert.equal(isReportId('../users/alice'), false);
  assert.equal(isReportId(undefined), false);
});

test('byte ranges for Safari', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=0-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=200-300', 100), null);
  assert.equal(parseRange('bytes=5-2', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
});

test('everything from a report is escaped', () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
  const html = renderReport({
    report: report({ details: '<img src=x onerror=alert(1)>' }),
    reported: { displayName: '<b>Bob</b>' },
    reporter: { displayName: 'Alice' },
    moderation: null,
  }, TOKEN);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>Bob<\/b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the report page shows history, a replaced original, and the outcome buttons', () => {
  const html = renderReport({
    report: report({ originalCheck: { found: true, replacedAfterSend: true, minutesAfterMessage: 1440 } }),
    reported: { displayName: 'Bob' },
    reporter: { displayName: 'Alice' },
    moderation: { reportsReviewed: 4, falseReports: 2 },
  }, TOKEN);
  assert.match(html, /4 reviewed, 2 false/);
  assert.match(html, /1440 minutes after the message was sent/);
  assert.match(html, /<video controls/);
  for (const label of ['Took Action', 'No Action', 'False Report', 'Turn Off Their Reporting']) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /<script/i);
});

test('a child-safety report shows the steps instead of the video', () => {
  const html = renderReport({ report: report({ reason: 'child_safety' }), reported: null, reporter: null, moderation: null }, TOKEN);
  assert.doesNotMatch(html, /<video/);
  assert.match(html, /NCMEC CyberTipline/);
  assert.match(html, /Don't download it/);
});

test('an empty queue says so', () => {
  assert.match(renderQueue({ waiting: [], reviewed: [] }, TOKEN), /Nothing waiting/);
});

// MARK: - The server

// A small stand-in for Firestore and a bucket, recording every write
function fakes() {
  const docs = {
    [`reports/${ID}`]: report(),
    [`reports/${CHILD_ID}`]: report({ id: CHILD_ID, reason: 'child_safety', evidencePath: `reportEvidence/${CHILD_ID}.mp4` }),
    'users/alice-uid': { displayName: 'Alice' },
    'users/bob-uid': { displayName: 'Bob' },
  };
  const writes = [];
  const snapshot = (path) => ({ exists: path in docs, data: () => docs[path] });
  const db = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => snapshot(`${name}/${id}`),
        update: async (data) => { writes.push({ op: 'update', path: `${name}/${id}`, data }); },
        set: async (data, options) => { writes.push({ op: 'set', path: `${name}/${id}`, data, options }); },
      }),
      orderBy: () => ({
        limit: () => ({
          get: async () => ({
            docs: Object.keys(docs).filter((p) => p.startsWith(`${name}/`))
              .map((p) => ({ id: p.split('/')[1], data: () => docs[p] })),
          }),
        }),
      }),
    }),
  };
  const video = Buffer.from('0123456789');
  const reads = [];
  const bucket = {
    file: (path) => ({
      getMetadata: async () => [{ size: String(video.length), contentType: 'video/mp4' }],
      createReadStream: (options = {}) => {
        reads.push(path);
        return Readable.from(video.subarray(options.start ?? 0, (options.end ?? video.length - 1) + 1));
      },
    }),
  };
  return { db, bucket, writes, reads };
}

let server;
let port;
let state;

before(async () => {
  state = fakes();
  // The port has to be known before the server checks Host, so listen first
  server = await new Promise((resolve) => {
    const probe = require('node:http').createServer();
    probe.listen(0, '127.0.0.1', () => {
      port = probe.address().port;
      probe.close(() => {
        const s = createReviewServer({ ...state, token: TOKEN, port, log: () => {} });
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
    });
  });
});

after(() => server?.close());

const base = () => `http://127.0.0.1:${port}`;
const post = (path, body, headers = {}) => fetch(`${base()}${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});

test('every page needs the token', async () => {
  assert.equal((await fetch(`${base()}/`)).status, 403);
  assert.equal((await fetch(`${base()}/?t=wrong`)).status, 403);
  assert.equal((await fetch(`${base()}/report/${ID}`)).status, 403);
  const ok = await fetch(`${base()}/?t=${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Waiting \(2\)/);
});

test('pages carry headers that allow no scripts and no caching', async () => {
  const res = await fetch(`${base()}/report/${ID}?t=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  // no-referrer makes browsers send "Origin: null" on the forms, which the
  // origin check refuses, so every outcome button stopped working
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
});

test('another host or origin is refused', async () => {
  // fetch won't send a different Host, so use http directly (DNS rebinding)
  const wrongHost = await new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port, path: `/?t=${TOKEN}`, headers: { Host: `evil.example:${port}` } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 421);
  const wrongOrigin = await post(`/report/${ID}/outcome`, { t: TOKEN, outcome: 'no_action' }, { Origin: 'https://evil.example' });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(state.writes.length, 0);
});

test('a post without the token writes nothing', async () => {
  const res = await post(`/report/${ID}/outcome`, { outcome: 'false_report' });
  assert.equal(res.status, 403);
  assert.equal(state.writes.length, 0);
});

test('the video streams with byte ranges', async () => {
  const res = await fetch(`${base()}/video/${ID}?t=${TOKEN}`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await res.text(), '234');
});

test('a child-safety video is refused and never read', async () => {
  const before = state.reads.length;
  const res = await fetch(`${base()}/video/${CHILD_ID}?t=${TOKEN}`);
  assert.equal(res.status, 403);
  assert.equal(state.reads.length, before);
});

test('setting an outcome writes only the outcome and note', async () => {
  const res = await post(`/report/${ID}/outcome`, { t: TOKEN, outcome: 'false_report', reviewNote: 'Made up', status: 'resolved' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), new RegExp(`/report/${ID}\\?t=`));
  assert.deepEqual(state.writes.at(-1), { op: 'update', path: `reports/${ID}`, data: { outcome: 'false_report', reviewNote: 'Made up' } });

  const bad = await post(`/report/${ID}/outcome`, { t: TOKEN, outcome: 'delete' });
  assert.equal(bad.status, 400);
});

test('turning off reporting writes only the flag, on the reporter', async () => {
  const res = await post(`/report/${ID}/reporting`, { t: TOKEN, reportingSuspended: 'on' });
  assert.equal(res.status, 303);
  assert.deepEqual(state.writes.at(-1), {
    op: 'set', path: 'moderation/alice-uid', data: { reportingSuspended: true }, options: { merge: true },
  });
});

test('unknown reports and addresses are not found', async () => {
  assert.equal((await fetch(`${base()}/report/${'B'.repeat(8)}-0000-0000-0000-000000000000?t=${TOKEN}`)).status, 404);
  assert.equal((await fetch(`${base()}/report/..%2Fusers?t=${TOKEN}`)).status, 404);
});
