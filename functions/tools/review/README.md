# Report review

A small page for reviewing vlrb reports on your Mac. It lists reports waiting for an outcome, shows one report with the reporter's history and the original-file check, plays a shared video, and records your decision. Nothing is hosted or deployed: it runs on `127.0.0.1` with your own Google credentials.

The full reporting path, the threat model, and what each outcome means are in albondigas `docs/REPORTING.md`.

## Run it

1. Sign in once with Application Default Credentials:

   ```bash
   gcloud auth application-default login
   ```

2. From the repo root, after `npm --prefix functions install`:

   ```bash
   npm --prefix functions run review
   ```

3. Open the address it prints, which includes a one-time token. Press Control-C to stop.

`REVIEW_PORT` changes the port (default 8765).

## What it shows

- **Waiting:** reports with no outcome, urgent ones (self-harm, a child at risk) first, then oldest first. A misspelled outcome set in the console still counts as waiting.
- **Reviewed:** the last 25.
- **One report:** the reason, when it was sent, who was reported and who reported (names from `users/`), the reporter's history from `moderation/`, the note, and for a video, the original-file check and the message path.
- **The video:** streamed from `reportEvidence/` through this server, with byte ranges so Safari plays it. It isn't saved on your Mac, and no link to it exists outside this page.

## What it can change

Only three things, through the Admin SDK:

- `outcome` and `reviewNote` on a report. The buttons write `action_taken`, `no_action`, or `false_report`, so a typo can't happen. `recordReportOutcome` then records the review and updates the reporter's counts.
- `reportingSuspended` on the reporter's `moderation/{uid}`, from Turn Off Their Reporting and Turn Reporting Back On.

It never removes reports, evidence, or accounts.

## Guardrails

- **Child-safety videos never play or download here.** The page shows the CyberTipline steps instead, and the video address refuses them even when asked directly.
- **Only this Mac.** The server listens on `127.0.0.1` only. Every request needs the random token it printed at start, compared in constant time.
- **Only this page.** Requests with another `Host` (DNS rebinding) or another `Origin` (a form on some other site) are refused.
- **Nothing runs from a report.** Every value from a report is HTML-escaped. The Content Security Policy allows no scripts at all, and the page can't be framed. Nothing is cached.
- **Logs name only report IDs and outcomes**, never a note.

Your credentials can do anything your Google account can. The page limits itself to the writes above, but the credentials don't, so stop the server when you're done.

## Try it without real reports

Start the Firestore and Storage emulators, seed some reports, and point the page at them:

```bash
REVIEW_PROJECT=demo-vlrb-review \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8288 \
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9298 \
npm --prefix functions run review
```

`recordReportOutcome` doesn't run on the emulators unless you also start the Functions emulator, so the counts won't change there.

## Tests

`functions/test/review.test.js`, run with `npm --prefix functions test`. They cover the queue order, what can play, the only writes allowed, escaping, the token, Host and Origin checks, byte ranges, and that a child-safety video is never read.
