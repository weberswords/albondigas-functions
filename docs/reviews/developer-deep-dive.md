# VLRB Cloud Functions: developer deep-dive security and build review

Dated 2026-07-29. A deep security and engineering pass over the Firebase Cloud
Functions backend for the vlrb iOS app, the real server-side trust boundary for
the product. Scope is `/home/user/albondigas-functions` only. This review reads
every function file end to end and walks the OWASP Top 10 (2025), a STRIDE pass,
and the build-audit fundamentals. It does not change function code.

> This review catches the common, high-frequency failures. It is not a
> substitute for a professional penetration test or a formal audit. Given that
> this backend holds a social graph, private video content, account-deletion
> powers, and email-sending capability, a professional review is warranted
> before the user base grows. The specific items that most warrant expert
> scrutiny are called out inline.

---

## Stack Read

- **Platform / kind:** Backend serverless functions (Firebase Cloud Functions,
  2nd gen) for a consumer iOS app. Triggers span HTTPS callable (`onCall`), raw
  HTTP (`onRequest`), Firestore document triggers (`onDocumentCreated`), and
  scheduled Pub/Sub jobs (`onSchedule`).
- **Language / framework:** Node.js 20, CommonJS, `firebase-functions` v7,
  `firebase-admin` v12.7. No TypeScript, no build step (`predeploy` is empty).
- **Build / deps:** npm with a committed `package-lock.json`. Deploy runs on
  Cloud Build (`cloudbuild.yaml`: `npm ci` then `firebase deploy --only
  functions`). Runtime dependencies: `firebase-admin`, `firebase-functions`,
  `@google-cloud/logging`, `jsonwebtoken`, and `mailgun-js`.
- **Data / external I/O:** Firestore (owned, primary store), Firebase Storage
  (video and thumbnail objects), Firebase Auth (identity), Firebase Cloud
  Messaging (push), Cloud Logging (log sink), and Mailgun (email, a foreign
  trust boundary reached with an API key). Secrets are declared with
  `defineSecret` (`MAILGUN_API_KEY`, `JWT_SIGNING_SECRET`) and bound per
  function, which is the correct Firebase pattern.
- **Tests / CI:** None. `firebase-functions-test` is a dev dependency, and no
  test files exist. No lint, no type-check, no CI gate beyond the deploy step.
- **Conventions:** Module factory pattern (`module.exports = (firebaseHelper)
  => {...}`), a shared `admin`/`db` helper built once in `index.js`, singletons,
  event-driven scheduling for cleanup, verbose emoji `console.log` throughout.
- **Observability in place:** `console.log`/`console.error` to Cloud Logging,
  plus structured run and error records written to `systemLogs/*` subcollections.
  No error tracker, no alerting, no uptime or health check.
- **Trust / data boundaries:** The client to function boundary is the primary
  one; all `request.data` and every HTTP body is untrusted. Function to Mailgun,
  function to FCM, and function to Cloud Logging are outbound boundaries. PII in
  the system includes email addresses, display names, the friend graph, video
  and thumbnail objects, push tokens, and short-lived verification and reset
  codes.
- **Maturity:** Partial. A real, coherently structured backend with a sound
  ownership-based authorization model on the callable functions, undercut by no
  App Check, no tests, no CI, a heavily vulnerable dependency tree, and one
  wide-open unauthenticated endpoint.

**Floors most in play:** security (access control, injection surface at the
email endpoints, supply chain), privacy (PII in logs and in permanent system
logs, deletion completeness), and build-audit fundamentals (idempotency,
fail-closed error handling, input validation).

---

## Overall security verdict

The core authorization model is the strong part of this backend. Every callable
that mutates user data derives the actor from `request.auth.uid` and checks
ownership or admin status server-side before acting, and the friend-graph
functions consistently verify that the caller is a party to the friendship they
are modifying. I found no confirmed horizontal IDOR or auth bypass on the
callable surface, which is the highest-priority axis and the one this backend
gets right.

The weaknesses are concentrated elsewhere, and three of them rise to blocker
level: a fully unauthenticated log-ingestion HTTP endpoint that accepts unbounded
input, the complete absence of App Check across a backend whose only intended
caller is the app, and a dependency tree that `npm audit` reports as carrying 3
critical and 18 high advisories, driven substantially by the deprecated
`mailgun-js`. Below those sit real should-fix issues: predictable verification
and reset codes generated with `Math.random`, unrate-limited email-sending
endpoints that enable email bombing, a verified-email state that a client can
spoof, PII written to logs and to permanent system logs, and cleanup queries
that silently skip documents missing a field.

None of these is an argument that the model is unsound. The ownership checks are
the load-bearing control, and they hold. The gaps are in the defenses that sit
around that model, and they are fixable without restructuring.

---

## Findings

### Blockers

**B1. `ingestLogs` is unauthenticated and accepts unbounded input.**
`functions/logging.js:12-71`. The endpoint is `onRequest` with no
`request.auth` check, no App Check, no shared secret, and no cap on
`batch.entries.length`. Anyone on the internet who knows the URL can POST an
arbitrary array of entries, each written straight into the `vlrb-ios-logs`
Cloud Logging log via `log.write(logEntries)`.

- *Exploit:* An attacker scripts POSTs with large `entries` arrays and
  attacker-chosen `severity`, `category`, `message`, `correlationId`, and
  `device.*` labels. This inflates the Cloud Logging bill, buries genuine app
  telemetry under injected noise, and lets an attacker forge log lines and
  correlation IDs that an operator might later trust during an investigation.
  It is a log-injection and cost-amplification denial-of-service rolled into
  one. Maps to A01, A06, and A09.
- *Fix:* Require Firebase Auth and enforce App Check (the only legitimate caller
  is the signed-in app), cap `entries` to a sane maximum, validate each entry's
  shape and `severity` against an allowlist, and reject oversized bodies. If
  truly pre-auth logging is needed, gate it behind App Check at minimum and
  bound it hard.

**B2. The dependency tree carries 3 critical and 18 high advisories, and
`mailgun-js` is deprecated.** `functions/package.json:15-21`,
`functions/package-lock.json`. `npm audit --package-lock-only` reports 40
vulnerabilities: 3 critical, 18 high, 17 moderate, 2 low. The critical entries
include arbitrary code execution in `protobufjs`, octal-parsing flaws in
`netmask`, and a resource-limit bypass in `websocket-driver`. A large share of
the high-severity chain comes in through `mailgun-js@0.22.0`, which is an
abandoned, deprecated package that pulls in `proxy-agent@3.1.1`, `pac-resolver`
(code injection), `netmask`, `socks`, and `ip` (SSRF misclassification). The
rest arrive transitively through `firebase-admin` and `@google-cloud/logging`.

- *Exploit:* Reachability varies by advisory, and several require conditions
  this code may not meet (the `proxy-agent` chain is only exercised when a proxy
  is configured, and the `protobufjs`/`grpc-js` issues need a malicious protobuf
  or malformed gRPC frame). The point is not any single guaranteed exploit, it
  is that the backend ships a large, unmaintained, and unmonitored vulnerable
  surface with no audit gate to catch the next one. Maps to A03 and A08.
- *Fix:* Replace `mailgun-js` with the maintained official `mailgun.js` SDK (or
  a small direct HTTPS call to the Mailgun API), which removes the entire
  `proxy-agent`/`pac-resolver`/`netmask` chain. Upgrade `firebase-admin` and
  `firebase-functions` to current patch releases to clear the `protobufjs` and
  `grpc-js` advisories. Add `npm audit` (failing on high and critical) to the
  Cloud Build pipeline so this is caught on every deploy rather than never. This
  is the item most worth a careful, tool-assisted remediation pass.

**B3. No App Check on any function.** A grep for `enforceAppCheck` /
`appCheck` across `functions/` returns nothing. Every callable and every HTTP
endpoint is reachable by any script that can mint or replay a Firebase ID token,
or, for the HTTP endpoints, by any client at all. For a consumer app whose sole
intended caller is the vlrb app, App Check is the platform-level
anti-automation control, and its absence is what makes the email-bomb and
enumeration vectors below cheap to run at scale.

- *Exploit:* An attacker extracts or forges the flow to obtain an anonymous or
  low-value Firebase token, then drives `initiateSignup`, `sendPasswordResetCode`,
  `sendVerificationCode`, and `sendFriendRequest` in a loop from a script that
  never touches the app binary. Maps to A06.
- *Fix:* Set `enforceAppCheck: true` on the callable functions and verify App
  Check tokens on the `onRequest` endpoints. Roll it out in monitor mode first
  so legitimate clients are not broken, then enforce. Pair this with the
  per-endpoint rate limiting in the should-fix items below, since App Check
  raises the cost of abuse but does not by itself bound a single authenticated
  client.

### Should-fix

**S1. Verification and password-reset codes use `Math.random`.**
`functions/verification.js:36` and `functions/verification.js:190`. Both the
email verification code and the password reset code are generated with
`Math.floor(100000 + Math.random() * 900000)`. `Math.random` is not a
cryptographically secure generator; its internal state is recoverable from a
run of outputs, so the sequence is predictable rather than unguessable.

- *Exploit:* The reset code is a six-digit secret protecting an account. An
  attacker who can observe or influence enough generated values could predict a
  target's code, and the predictability compounds any weakness in the
  three-attempt limit. Maps to A04 and A07. The signup flow in `signup.js`
  already does this correctly with `crypto` and signed JWTs, so the fix matches
  existing house practice.
- *Fix:* Generate codes with `crypto.randomInt(100000, 1000000)`.

**S2. `sendPasswordResetCode` has no rate limiting.**
`functions/verification.js:166-251`. Unlike `signup.js`, which rate-limits per
email hash, this endpoint sends a reset email on every call with no throttle and
overwrites `passwordResetCodes/{uid}` each time.

- *Exploit:* An attacker repeatedly calls it with a victim's email, bombing that
  inbox with reset codes and running up Mailgun cost and reputation risk. Because
  it is unauthenticated (correctly, for a reset flow) and unbounded, this is the
  cheapest abuse vector in the backend. Maps to A06. `sendVerificationCode` and
  `initiateSignup`/`resendSignupLink` share the same email-bombing exposure
  absent App Check; signup at least caps repeats per email but not across
  distinct victim addresses.
- *Fix:* Add per-email and per-caller rate limiting (the `signup.js`
  `pendingRegistrations` pattern is a good model), and enforce App Check per B3.

**S3. `sendVerificationCode` trusts a client-supplied email, so the verified
state is spoofable.** `functions/verification.js:11-91` and
`functions/verification.js:144-148`. The function takes `email` from
`request.data` rather than from the authenticated user's token, stores it, and
`verifyCode` later sets `users/{uid}.isEmailVerified = true` for whatever email
the client supplied.

- *Exploit:* An authenticated user can mark their own account as having a
  verified email they do not control, rendering the `isEmailVerified` flag
  untrustworthy for any downstream decision, and can also use the endpoint to
  send a code to an arbitrary address. Maps to A01 and A06.
- *Fix:* Derive the email from `request.auth.token.email` (or verify the
  supplied email matches it), and do not let the client choose the address that
  gets marked verified.

**S4. Deleted users' email addresses are written to permanent system logs.**
`functions/inactive.js:290-296` and `functions/inactive.js:305-310`, committed at
`inactive.js:342-347`. The scheduled deletion job pushes each deleted user's
email into `deletionResults`, which is then written to
`systemLogs/scheduledDeletions/runs` with no retention limit.

- *Effect:* Account deletion is supposed to remove the person's data, yet this
  job records their email into a system log that is never cleaned up, so the PII
  survives the deletion that was meant to erase it. This is a deletion-
  completeness gap under privacy-by-design and an information-disclosure risk if
  the logs collection is ever over-read. The `friendshipEvents` records
  (`friends.js:537-544`, `friends.js:891-898`) similarly retain the deleted
  user's uid indefinitely.
- *Fix:* Record only the uid (or a hashed identifier) in the run log, set a
  retention window on `systemLogs`, and include `friendshipEvents` in the
  deletion cascade or age them out.

**S5. Email addresses are logged to Cloud Logging in plaintext.**
`functions/verification.js:84,185,244`, `functions/inactive.js:100,119,123`,
`functions/inactive.js:289`, and the friend-request logs in `friends.js`. Many
`console.log` calls include raw email addresses. `signup.js` sets the better
example by logging only an eight-character prefix of the email hash.

- *Effect:* PII lands in Cloud Logging, a store nobody classified as holding it,
  widening the blast radius of any log access and raising a
  data-residency/retention question. Maps to A09 and privacy-by-design.
- *Fix:* Log a uid or a hashed email rather than the address, and set log
  retention deliberately.

**S6. Cleanup and deletion queries use `!= true`, which silently skips
documents missing the field.** `functions/videos.js:29`,
`functions/videos.js:452`, and `functions/account.js:106-109`. Firestore
inequality filters do not match documents where the field is absent, so
`.where('contentRemoved', '!=', true)` and `.where('senderDeleted', '!=', true)`
never return a message that lacks that field entirely.

- *Effect:* Any expired video whose message document was never written with a
  `contentRemoved` field is skipped by the cleanup job forever. That means
  expired private video content can outlive its expiry in Storage, which is both
  a storage-cost problem and a privacy problem given the product's promise that
  content expires. This is a correctness bug worth confirming against how the
  iOS client writes message documents.
- *Fix:* Ensure the client always writes `contentRemoved: false` on new
  messages, or restructure the query to select on `expiresAt` alone and filter
  the removed ones in code, so a missing field does not hide an expired video.

**S7. Internal error detail is returned to clients.**
`functions/account.js:240-249` returns `${error.code}: ${error.message}` or
`error.toString()` to the caller, and several functions rethrow
`new HttpsError('internal', error.message)` (for example
`friends.js:475-478`, `friends.js:586-587`, `inactive.js:547`). Callable
functions also return raw `error.message` in `{ success: false, error }`
objects (`friends.js:253-254`, `friends.js:817-819`).

- *Effect:* Internal messages can leak implementation detail and stack context
  to the client. Maps to A10 and A02.
- *Fix:* Return a stable, generic message to the client and log the detail
  server-side, as the app's own error-handling guidance already prefers.

**S8. The backend authenticates with a service-account key file rather than
runtime credentials.** `functions/index.js:4-10` requires
`./firebase_admin.json` and calls `admin.credential.cert(serviceAccount)`. The
file is gitignored and is not committed, which is correct, yet the pattern
itself is weaker than the platform default. Cloud Functions provide application
default credentials at runtime, so a long-lived private key on disk is an
avoidable key-management liability.

- *Fix:* Call `admin.initializeApp()` with no explicit credential and let the
  runtime service account supply credentials, keeping only the `storageBucket`
  option. This removes a standing secret from the deployment.

**S9. Firestore triggers have no idempotency guard.**
`functions/notifications.js:8-135`. `onDocumentCreated` delivers at least once,
so a retry can fire a duplicate push notification.

- *Effect:* Duplicate FCM notifications on retry. Low impact, but it is the kind
  of double-fire build-audit calls out.
- *Fix:* Record a processed marker (for example a `notifiedAt` field or a
  dedicated doc keyed by message id) and no-op if it is already set.

**S10. Thin input validation on several endpoints.** `adminDeleteAccounts`
(`account.js:315-319`) does not check that each `uid` is a non-empty string;
`completeSignup` (`signup.js:506-508`) does not bound `displayName` length;
`ingestLogs` does not bound the entry count (see B1). Password minimum is six
characters (`signup.js:502`, `verification.js:335`), which meets the Firebase
floor but is weak.

- *Fix:* Allowlist-validate type, shape, and length at each boundary, and
  consider a stronger password policy.

### Polish

**P1. `getCleanupStats` requires only authentication, not admin.**
`functions/videos.js:438-501`. Unlike the manual cleanup functions, it omits the
`isAdmin` check, so any signed-in user can read system-wide counts and the last
run record (which includes the triggering admin's uid). Low-value disclosure;
add the admin gate for consistency.

**P2. Display names are interpolated into outbound email HTML without
encoding.** `functions/inactive.js:207` renders `Hi ${name}` into the HTML body
where `name` is the user-controlled `displayName`. The email goes to the user's
own address, so impact is low, yet it is an output-encoding gap; HTML-escape the
value.

**P3. `blockUser` queries a top-level `messages` collection that the rest of the
code does not use.** `functions/friends.js:707-714` reads
`db.collection('messages').where('chatId', ...)` with a non-transactional
`.get()` inside a transaction, while messages actually live in
`chats/{chatId}/messages`. This branch is likely dead and, if it ever matched,
would read outside transactional guarantees. Remove it or correct the path.

**P4. New accounts may never be swept by the inactivity job.**
`functions/signup.js:563-572` creates user documents without `lastActive` or
`scheduledForDeletion`, and `inactive.js:56-59` filters on
`scheduledForDeletion == false` and `lastActive <= threshold`, both of which
exclude documents missing the field. A user who never calls `updateLastActive`
may fall out of the inactivity lifecycle entirely. Initialize both fields at
account creation.

**P5. Observability is console-and-Firestore only.** There is no error tracker
and no alerting, so a failing scheduled deletion or a spike of 500s from
`ingestLogs` is invisible until someone reads the logs. Sized to a pre-scale
consumer backend this is defensible, but the account-deletion and email paths
carry enough stakes that a lightweight error tracker on the failure event, with
an email or chat alert, is worth adding. Route to the observability skill.

---

## STRIDE threat model (summary)

Scope: the Cloud Functions backend and its boundaries to the iOS client,
Firestore, Storage, Firebase Auth, FCM, Cloud Logging, and Mailgun. Assets worth
attacking: user accounts and the ability to delete them, the friend graph,
private video and thumbnail objects, verification and password-reset codes, push
tokens, email-sending capability, and the Cloud Logging and Mailgun spend.

| # | STRIDE | Threat (how the attack works) | Likelihood x Impact | Current mitigation | Gap / response |
|---|---|---|---|---|---|
| 1 | Spoofing | Caller forges the app to drive callables from a script, since no App Check binds calls to the real client | high x med | Firebase Auth on callables; ownership checks | No App Check (B3); mitigate |
| 2 | Spoofing | Client marks an email it does not own as verified via `sendVerificationCode`/`verifyCode` | med x med | Auth required | Email taken from payload, not token (S3); mitigate |
| 3 | Tampering | Forged or bulk log entries injected through the open `ingestLogs` endpoint | high x med | None | Unauthenticated, unbounded (B1); mitigate |
| 4 | Tampering | Acting on another user's friendship or video | low x high | Server-side ownership and admin checks on every mutating callable | Confirmed sound; accept |
| 5 | Repudiation | Deleted user's identifiers linger in `friendshipEvents` and system logs | med x low | `systemLogs` run records | PII retained post-deletion (S4); mitigate |
| 6 | Info disclosure | Emails in Cloud Logging and in permanent system logs | med x med | Hash prefix in signup only | Plaintext emails elsewhere (S4, S5); mitigate |
| 7 | Info disclosure | Account enumeration via `sendFriendRequest` distinct `not-found`, and internal errors returned to clients | med x low | Signup and reset flows return generic messages | Friend request enumerates; errors leak (S7); mitigate |
| 8 | Info disclosure | Expired private videos outlive expiry because cleanup skips field-less docs | med x med | Scheduled cleanup jobs | `!= true` query gap (S6); mitigate |
| 9 | Denial of service | Email bombing and cost amplification through unrate-limited send endpoints and `ingestLogs` | high x med | Per-email rate limit in signup only | Reset and verification unbounded (B1, S2); mitigate |
| 10 | Denial of service | Malicious protobuf or gRPC frame against a vulnerable transitive dependency | low x high | None | Vulnerable deps (B2); mitigate |
| 11 | Elevation | User reaches an admin-only function | low x high | `users/{uid}.isAdmin` checked server-side | Depends on Firestore rules forbidding self-set `isAdmin` (see below); verify |

**Cross-repo dependency worth verifying:** every admin gate reads
`users/{uid}.isAdmin` from Firestore. That control is only as strong as the
`firestore.rules` that must prevent a user from writing `isAdmin: true` to their
own document. Those rules live in the app repo, not here, so this backend's
privilege model rests on a file outside its own scope. Confirm the rule exists
and denies client writes to `isAdmin`.

---

## What is already done well

- Ownership-based authorization is applied consistently on the callable surface,
  with no confirmed IDOR.
- The signup flow is the model to copy: signed JWTs with purposes and short
  expiries, SHA-256 email hashing at rest, enumeration-safe responses, and
  per-email rate limiting.
- Secrets use `defineSecret` and are bound per function rather than hardcoded,
  and no secret is committed to the repo.
- `adminDeleteAccounts` is correctly gated with `invoker: 'private'` (IAM)
  rather than left public.
- Password reset uses a transaction to mark the code used before changing the
  password, which closes the obvious replay window, and the reset and signup
  flows return generic messages that do not confirm account existence.
- Cleanup and deletion are scheduled and event-driven, with run and error
  records written to `systemLogs`, giving a basic audit trail.

---

## A note on scope and next steps

This is a code and configuration review of the functions backend. It does not
exercise the deployed endpoints, does not review the `firestore.rules` or
Storage rules that enforce data access outside these functions, and is not a
penetration test. The account-deletion powers, the email-sending capability, and
the private-video lifecycle are the highest-stakes surfaces here, and once B1
through B3 are addressed, a professional review that includes the Firestore and
Storage security rules is the right next step before scaling the user base.
