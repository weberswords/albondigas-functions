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

        if (!batch.entries || !Array.isArray(batch.entries)) {
          res.status(400).send('Invalid batch format');
          return;
        }

        console.log(`📥 Ingesting ${batch.entries.length} log entries (batchId: ${batch.batchId})`);

        // Convert to Cloud Logging entries
        const logEntries = batch.entries.map(entry => {
          const metadata = {
            severity: entry.severity,
            labels: {
              category: entry.category,
              app_version: entry.device.appVersion,
              build_number: entry.device.buildNumber,
              device_model: entry.device.model,
              os_version: entry.device.osVersion,
              network_type: entry.device.networkType,
            },
          };

          const data = {
            message: entry.message,
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
