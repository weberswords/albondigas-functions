const { onRequest } = require('firebase-functions/v2/https');
const { Logging } = require('@google-cloud/logging');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

  const logging = new Logging();
  const log = logging.log('vlrb-ios-logs');

  return {
    // HTTP endpoint for iOS log ingestion
    ingestLogs: onRequest({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (req, res) => {
      // Only accept POST requests
      if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
      }

      try {
        const batch = req.body;

        if (!batch || !batch.entries || !Array.isArray(batch.entries)) {
          res.status(400).send('Invalid batch format');
          return;
        }

        // This endpoint is unauthenticated by design (the client can log before
        // sign-in), so it has to defend itself. Cap the batch so a single
        // request cannot write an unbounded number of attacker-controlled
        // entries into Cloud Logging, which would be a cost and log-injection
        // vector. A real client batch is small; MAX_ENTRIES is generous.
        const MAX_ENTRIES = 500;
        const MAX_MESSAGE_LENGTH = 8192;
        if (batch.entries.length > MAX_ENTRIES) {
          res.status(413).send('Too many entries');
          return;
        }

        console.log(`📥 Ingesting ${batch.entries.length} log entries (batchId: ${batch.batchId})`);

        // Convert to Cloud Logging entries. Every field is client-controlled and
        // any of them may be missing, so read defensively (a missing device
        // object used to throw and 500 the whole batch) and bound the message
        // length so one entry cannot bloat the log.
        const logEntries = batch.entries.map(entry => {
          const device = (entry && entry.device) || {};
          const message = typeof entry.message === 'string'
            ? entry.message.slice(0, MAX_MESSAGE_LENGTH)
            : entry.message;

          const metadata = {
            severity: entry.severity,
            labels: {
              category: entry.category,
              app_version: device.appVersion,
              build_number: device.buildNumber,
              device_model: device.model,
              os_version: device.osVersion,
              network_type: device.networkType,
            },
          };

          const data = {
            message: message,
            correlationId: entry.correlationId,
            context: entry.context,
            timestamp: entry.timestamp,
          };

          return log.entry(metadata, data);
        });

        // Write all entries to Cloud Logging
        await log.write(logEntries);

        console.log(`✅ Successfully ingested ${logEntries.length} log entries`);

        res.status(200).json({
          success: true,
          entriesLogged: logEntries.length,
          batchId: batch.batchId,
        });
      } catch (error) {
        console.error('❌ Error ingesting logs:', error);
        res.status(500).send('Internal Server Error');
      }
    })
  };
};
