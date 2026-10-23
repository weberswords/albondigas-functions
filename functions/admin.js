const { onRequest, HttpsError } = require('firebase-functions/v2/https');

// Wraps an admin task as an HTTPS function that only Google accounts with an
// IAM role on the project (Owner, or Cloud Run Invoker) can call. Cloud Run
// checks that role before this code runs, so no field in Firestore decides
// who is an admin, and the app has no way to reach these functions.
//
// Call from a terminal signed in to gcloud with a project account:
//   curl -X POST "https://us-central1-albondigas-8cfd9.cloudfunctions.net/<name>" \
//     -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
//     -H "Content-Type: application/json" \
//     -d '{"dryRun":true}'
//
// The handler gets the JSON body and the caller's email, and returns the
// response body. Throwing an HttpsError sends its matching HTTP status.
function adminFunction(options, handler) {
    return onRequest({ region: 'us-central1', ...options, invoker: 'private' }, async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'POST only' });
            return;
        }

        const caller = callerEmail(req);
        try {
            res.json(await handler(req.body || {}, caller));
        } catch (error) {
            const status = error instanceof HttpsError ? error.httpErrorCode.status : 500;
            console.error(`Admin function error for ${caller}:`, error);
            res.status(status).json({ error: error.message });
        }
    });
}

// Cloud Run has already verified the identity token before the request gets
// here, so this only reads the email out of it for the logs.
function callerEmail(req) {
    try {
        const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        return payload.email || 'iam';
    } catch (error) {
        return 'iam';
    }
}

module.exports = { adminFunction };
