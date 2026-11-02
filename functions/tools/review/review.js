// What the local report review page shows and what it's allowed to write.
// Pure functions, so tests cover every decision without Firebase. The server
// (server.js) does the reading and writing. See README.md.
const { OUTCOMES, REASON_LABELS } = require('../../reports.js');

const OUTCOME_LABELS = {
  action_taken: 'Took Action',
  no_action: 'No Action',
  false_report: 'False Report',
};

// Waiting reports come first by urgency, then oldest first, so nothing urgent
// sits behind a pile of spam and nothing waits forever.
const URGENT = new Set(['child_safety', 'self_harm']);

function isUrgent(report) {
  return URGENT.has(report.reason);
}

function millis(timestamp) {
  if (!timestamp) return 0;
  if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
  if (timestamp instanceof Date) return timestamp.getTime();
  return new Date(timestamp).getTime() || 0;
}

// Splits reports into waiting (no outcome yet) and reviewed (newest first)
function sortQueue(reports) {
  const waiting = reports
    .filter((report) => !OUTCOMES.includes(report.outcome))
    .sort((a, b) => (Number(isUrgent(b)) - Number(isUrgent(a))) || (millis(a.reportedAt) - millis(b.reportedAt)));
  const reviewed = reports
    .filter((report) => OUTCOMES.includes(report.outcome))
    .sort((a, b) => millis(b.reportedAt) - millis(a.reportedAt));
  return { waiting, reviewed };
}

// The video plays only when it's stored and the report isn't about a child.
// Child-safety evidence is never shown or downloaded from this page: under
// 18 U.S.C. 2258A it's reported to NCMEC and preserved, not viewed here.
function videoAccess(report) {
  if (report.reason === 'child_safety') return 'withheld';
  if (report.videoStatus === 'stored' && typeof report.evidencePath === 'string'
      && report.evidencePath.startsWith('reportEvidence/')) {
    return 'playable';
  }
  if (report.videoAttached) return 'awaiting';
  return 'none';
}

// The only writes the page can make. Anything else is refused.
function outcomeUpdate(form) {
  const outcome = form.outcome;
  if (!OUTCOMES.includes(outcome)) return null;
  const note = typeof form.reviewNote === 'string' ? form.reviewNote.trim().slice(0, 1000) : '';
  return note ? { outcome, reviewNote: note } : { outcome };
}

function reportingUpdate(form) {
  if (form.reportingSuspended === 'on') return { reportingSuspended: true };
  if (form.reportingSuspended === 'off') return { reportingSuspended: false };
  return null;
}

// Report IDs are uppercase UUIDs (firestore.rules), which also keeps them
// safe in paths and URLs.
function isReportId(value) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value || '');
}

// Parses a Range header like "bytes=0-1023" against a file size, for Safari,
// which won't play video without byte ranges.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || size <= 0) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

// MARK: - Page

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(timestamp) {
  const ms = millis(timestamp);
  return ms ? new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';
}

function reasonLabel(report) {
  return REASON_LABELS[report.reason] || 'Something else';
}

function historyText(moderation) {
  if (!moderation || !moderation.reportsReviewed) return 'None reviewed yet';
  const suffix = moderation.reportingSuspended ? ' · reporting is turned off' : '';
  return `${moderation.reportsReviewed} reviewed, ${moderation.falseReports || 0} false${suffix}`;
}

function originalText(check) {
  if (!check) return 'Not checked yet';
  if (!check.found) return 'Not found in Storage';
  if (check.replacedAfterSend) {
    return `Stored ${check.minutesAfterMessage} minutes after the message was sent. It may have been replaced.`;
  }
  return `Stored when it was sent (${Math.round((check.size || 0) / 1024)} KB)`;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf7; --card: #fff; --text: #1d1d1f; --muted: #5f6368;
  --line: #e2e2dc; --accent: #0b6e4f; --warn: #a33a00; --urgent: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201e; --text: #f2f2ee;
  --muted: #b5b5ad; --line: #3a3a36; --accent: #6fd3a8; --warn: #ffb27a; --urgent: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 16px; } h2 { font-size: 18px; margin: 32px 0 8px; }
a { color: var(--accent); }
ul.list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
ul.list li { border-bottom: 1px solid var(--line); }
ul.list a { display: flex; justify-content: space-between; gap: 12px; padding: 12px 4px; text-decoration: none; color: var(--text); }
.muted { color: var(--muted); } .urgent { color: var(--urgent); font-weight: 600; } .warn { color: var(--warn); font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 16px 0; }
.steps { border-color: var(--urgent); } .steps ol { padding-left: 20px; } .steps li { margin: 6px 0; }
h3 { font-size: 16px; margin: 16px 0 8px; }
video { width: 100%; max-height: 70vh; border-radius: 8px; background: #000; }
form.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
textarea { width: 100%; min-height: 72px; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button { font: inherit; padding: 10px 16px; min-height: 44px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function link(path, token) {
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

function queueRow(report, token) {
  const flag = isUrgent(report) ? '<span class="urgent">Urgent · </span>' : '';
  const outcome = report.outcome ? ` · ${escapeHtml(OUTCOME_LABELS[report.outcome])}` : '';
  return `<li><a href="${escapeHtml(link(`/report/${report.id}`, token))}">
<span>${flag}${escapeHtml(reasonLabel(report))} <span class="muted">· ${report.source === 'video' ? 'Video' : 'Profile'}${outcome}</span></span>
<span class="muted">${escapeHtml(formatTime(report.reportedAt))}</span></a></li>`;
}

function renderQueue({ waiting, reviewed }, token) {
  const waitingList = waiting.length
    ? `<ul class="list">${waiting.map((r) => queueRow(r, token)).join('')}</ul>`
    : '<p class="muted">Nothing waiting. Every report has an outcome.</p>';
  const reviewedList = reviewed.length
    ? `<ul class="list">${reviewed.slice(0, 25).map((r) => queueRow(r, token)).join('')}</ul>`
    : '<p class="muted">None yet.</p>';
  return page('Reports', `<h1>Reports</h1>
<h2>Waiting (${waiting.length})</h2>${waitingList}
<h2>Reviewed</h2>${reviewedList}`);
}

function videoSection(report, token) {
  switch (videoAccess(report)) {
    case 'playable':
      return `<video controls preload="metadata" src="${escapeHtml(link(`/video/${report.id}`, token))}"></video>
<p class="muted">The reporter's decrypted copy. It streams from Storage and isn't saved on this Mac.</p>`;
    case 'withheld':
      return '<p class="urgent">This page doesn\'t show child-safety videos. Follow the steps above.</p>';
    case 'awaiting':
      return '<p class="muted">The reporter chose to share the video, but it hasn\'t arrived. They may have stopped it.</p>';
    default:
      return '<p class="muted">No video was shared with this report.</p>';
  }
}

const CYBERTIPLINE_URL = 'https://report.cybertip.org';

// Where the evidence stands, in words for the child-safety steps
function evidenceStatus(report) {
  if (report.videoStatus === 'stored' && report.evidencePath) return `Kept at ${report.evidencePath}`;
  if (report.videoAttached) return 'The reporter chose to share it, but it hasn\'t arrived';
  return 'No video was shared';
}

// The steps for a report about a child, with the details NCMEC asks for
// filled in, so the owner never has to look them up mid-crisis. Shown for
// every child-safety report, with or without a video.
function childSafetySection(report, reported) {
  const details = [
    ['vlrb report', report.id],
    ['Reported account', `${reported?.displayName || 'No profile'} (user ID ${report.reportedUserId})`],
    ['Reported at', `${formatTime(report.reportedAt)} (${new Date(millis(report.reportedAt) || 0).toISOString()})`],
    ['About', report.source === 'video' ? 'A video sent in a private, end-to-end encrypted chat' : 'A profile'],
    ...(report.source === 'video' ? [['Message', `chats/${report.chatId}/messages/${report.messageId}`]] : []),
    ['Evidence', evidenceStatus(report)],
  ];
  return `<section class="box steps" aria-labelledby="cs-steps">
<h2 id="cs-steps" class="urgent">Child safety: what to do now</h2>
<ol>
<li><strong>If a child is in danger right now, call 911</strong> (or local police) first.</li>
<li><strong>Don't open, download, or forward the video.</strong> Copying it can be a crime even for you, and this page won't play it. It stays in Storage, where only the project can reach it.</li>
<li><strong>Report it to the <a href="${CYBERTIPLINE_URL}" rel="noreferrer">NCMEC CyberTipline</a> within a day.</strong> US law (18 U.S.C. § 2258A) requires it once you know. Give them the details below. Tell them you're keeping the video and ask how they want it; don't email it.</li>
<li><strong>Write the CyberTipline report number</strong> in the note below, then choose <strong>Took Action</strong>.</li>
<li><strong>Stop the account, but keep its data.</strong> In the Firebase console, go to Authentication, find the user ID below, and choose Disable account. Don't delete it.</li>
<li><strong>Keep everything for at least a year</strong> after you report: this report, the video, and the account's data. The REPORT Act requires it.</li>
<li><strong>Talk to a lawyer</strong> about anything beyond these steps.</li>
</ol>
<h3>Details for the CyberTipline</h3>
<dl>${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
</section>`;
}

function renderReport({ report, reported, reporter, moderation }, token) {
  const check = report.originalCheck;
  const outcomeButtons = OUTCOMES.map((outcome) => `<button type="submit" name="outcome" value="${outcome}"${
    report.outcome === outcome ? ' class="primary" aria-pressed="true"' : ''}>${OUTCOME_LABELS[outcome]}</button>`).join('');
  const suspended = moderation?.reportingSuspended === true;
  return page(`Report ${report.id.slice(0, 8)}`, `<p><a href="${escapeHtml(link('/', token))}">← All reports</a></p>
<h1>${isUrgent(report) ? '<span class="urgent">Urgent · </span>' : ''}${escapeHtml(reasonLabel(report))}</h1>
${report.reason === 'child_safety' ? childSafetySection(report, reported) : ''}
<div class="box"><dl>
<dt>About</dt><dd>${report.source === 'video' ? 'A video' : 'A profile'}</dd>
<dt>Sent</dt><dd>${escapeHtml(formatTime(report.reportedAt))}</dd>
<dt>Reported</dt><dd>${escapeHtml(reported?.displayName || 'No profile')} <span class="muted">${escapeHtml(report.reportedUserId)}</span></dd>
<dt>Reporter</dt><dd>${escapeHtml(reporter?.displayName || 'No profile')} <span class="muted">${escapeHtml(report.reporterUserId)}</span></dd>
<dt>Their history</dt><dd>${escapeHtml(historyText(moderation))}</dd>
<dt>Note</dt><dd>${report.details ? escapeHtml(report.details) : '<span class="muted">None</span>'}</dd>
${report.source === 'video' ? `<dt>Original</dt><dd${check?.replacedAfterSend ? ' class="warn"' : ''}>${escapeHtml(originalText(check))}</dd>
<dt>Message</dt><dd class="muted">chats/${escapeHtml(report.chatId)}/messages/${escapeHtml(report.messageId)}</dd>` : ''}
<dt>Report ID</dt><dd class="muted">${escapeHtml(report.id)}</dd>
</dl></div>
${report.source === 'video' ? `<h2>Video</h2>${videoSection(report, token)}` : ''}
<p class="muted">Everything here comes from the reporter. Treat it as untrusted.</p>
<h2>Outcome</h2>
<form class="box" method="post" action="/report/${report.id}/outcome">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<label for="note">Note for yourself (optional)</label>
<textarea id="note" name="reviewNote" maxlength="1000">${escapeHtml(report.reviewNote || '')}</textarea>
<div class="actions" role="group" aria-label="Outcome">${outcomeButtons}</div>
<p class="muted">Use False Report only when you're confident it was made to hurt someone. No Action when you can't tell.</p>
</form>
<h2>Reporter</h2>
<form class="box actions" method="post" action="/report/${report.id}/reporting">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<span>${suspended ? 'Their reporting is turned off.' : 'They can send reports.'}</span>
<button type="submit" name="reportingSuspended" value="${suspended ? 'off' : 'on'}">${suspended ? 'Turn Reporting Back On' : 'Turn Off Their Reporting'}</button>
</form>`);
}

function renderMessage(title, message, token) {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
${token ? `<p><a href="${escapeHtml(link('/', token))}">← All reports</a></p>` : ''}`);
}

module.exports = {
  OUTCOME_LABELS,
  escapeHtml,
  isReportId,
  isUrgent,
  outcomeUpdate,
  parseRange,
  renderMessage,
  renderQueue,
  renderReport,
  reportingUpdate,
  sortQueue,
  videoAccess,
};
