const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Logging } = require('@google-cloud/logging');

// A real client batch is small (CloudLoggingService flushes at 50); these caps
// are generous and exist so one request cannot write an unbounded number of
// attacker-controlled entries into Cloud Logging (a cost and log-injection
// vector) or bloat the log with one huge message.
const MAX_ENTRIES = 500;
const MAX_MESSAGE_LENGTH = 8192;

// Cloud Logging rejects an unknown severity string and fails the whole write,
// so anything outside the client's set is logged as DEFAULT instead.
const SEVERITIES = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

// Validate a batch from CloudLoggingService and write it to `log`.
// Kept separate from the callable wrapper so tests can pass a fake log.
async function ingestBatch(batch, log) {
  if (!batch || !Array.isArray(batch.entries)) {
    throw new HttpsError('invalid-argument', 'Invalid batch format');
  }
  if (batch.entries.length > MAX_ENTRIES) {
    throw new HttpsError('invalid-argument', 'Too many entries');
  }

  console.log(`📥 Ingesting ${batch.entries.length} log entries (batchId: ${batch.batchId})`);

  // Every field is client-controlled and any of them may be missing, so read
  // defensively (a missing device object used to throw and fail the batch).
  const logEntries = batch.entries.map(entry => {
    const safeEntry = entry || {};
    const device = safeEntry.device || {};
    const message = typeof safeEntry.message === 'string'
      ? safeEntry.message.slice(0, MAX_MESSAGE_LENGTH)
      : safeEntry.message;

    const metadata = {
      severity: SEVERITIES.has(safeEntry.severity) ? safeEntry.severity : 'DEFAULT',
      labels: {
        category: safeEntry.category,
        app_version: device.appVersion,
        build_number: device.buildNumber,
        device_model: device.model,
        os_version: device.osVersion,
        network_type: device.networkType,
      },
    };

    const data = {
      message: message,
      correlationId: safeEntry.correlationId,
      context: safeEntry.context,
      timestamp: safeEntry.timestamp,
    };

    return log.entry(metadata, data);
  });

  if (logEntries.length > 0) {
    await log.write(logEntries);
  }

  console.log(`✅ Successfully ingested ${logEntries.length} log entries`);

  return {
    success: true,
    entriesLogged: logEntries.length,
    batchId: batch.batchId,
  };
}

module.exports = (firebaseHelper) => {
  const logging = new Logging();
  const log = logging.log('vlrb-ios-logs');

  return {
    // Callable endpoint for iOS log ingestion. The app calls it with
    // `httpsCallable("ingestLogs")`, which wraps the batch in the callable
    // protocol's `{ data: ... }` envelope. As an onRequest function this read
    // `req.body.entries`, found nothing, and rejected every batch with a 400
    // the SDK reports as INVALID ARGUMENT.
    //
    // Unauthenticated by design: the client can log before sign-in.
    ingestLogs: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (request) => {
      try {
        return await ingestBatch(request.data, log);
      } catch (error) {
        if (error instanceof HttpsError) {
          throw error;
        }
        console.error('❌ Error ingesting logs:', error);
        throw new HttpsError('internal', 'Could not ingest logs');
      }
    })
  };
};

module.exports.ingestBatch = ingestBatch;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
module.exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
