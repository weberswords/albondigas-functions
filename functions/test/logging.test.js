const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpsError } = require('firebase-functions/v2/https');

const loggingModule = require('../logging.js');
const { ingestBatch, MAX_ENTRIES, MAX_MESSAGE_LENGTH } = loggingModule;

// Records what ingestBatch would write to Cloud Logging.
function fakeLog() {
  return {
    written: null,
    entry(metadata, data) {
      return { metadata, data };
    },
    async write(entries) {
      this.written = entries;
    },
  };
}

// The shape CloudLoggingService.swift encodes (JSONEncoder, ISO 8601 dates).
function clientBatch(entries) {
  return {
    entries,
    batchTimestamp: '2026-10-31T20:00:00Z',
    batchId: 'b1',
  };
}

function clientEntry(overrides = {}) {
  return {
    timestamp: '2026-10-31T20:00:00Z',
    severity: 'WARNING',
    category: 'video',
    message: 'video_lifecycle_health',
    correlationId: '0a1b2c3d',
    context: { session_id: 'abcd1234' },
    device: {
      model: 'iPhone17,1',
      osVersion: '26.1',
      appVersion: '2.15.46',
      buildNumber: '412',
      networkType: 'wifi',
    },
    ...overrides,
  };
}

test('ingestLogs is a callable, matching the client httpsCallable', () => {
  const { ingestLogs } = loggingModule({});
  assert.ok(ingestLogs.__endpoint.callableTrigger, 'expected a callable trigger');
  assert.equal(ingestLogs.__endpoint.httpsTrigger, undefined);
});

test('writes a client batch with labels from the device info', async () => {
  const log = fakeLog();
  const result = await ingestBatch(clientBatch([clientEntry()]), log);

  assert.deepEqual(result, { success: true, entriesLogged: 1, batchId: 'b1' });
  assert.equal(log.written.length, 1);
  const [{ metadata, data }] = log.written;
  assert.equal(metadata.severity, 'WARNING');
  assert.deepEqual(metadata.labels, {
    category: 'video',
    app_version: '2.15.46',
    build_number: '412',
    device_model: 'iPhone17,1',
    os_version: '26.1',
    network_type: 'wifi',
  });
  assert.equal(data.message, 'video_lifecycle_health');
  assert.equal(data.correlationId, '0a1b2c3d');
  assert.deepEqual(data.context, { session_id: 'abcd1234' });
});

test('rejects a batch without an entries array', async () => {
  for (const batch of [undefined, null, {}, { entries: 'nope' }, { data: { entries: [] } }]) {
    await assert.rejects(ingestBatch(batch, fakeLog()), (error) => {
      assert.ok(error instanceof HttpsError);
      assert.equal(error.code, 'invalid-argument');
      return true;
    });
  }
});

test('rejects a batch over the entry cap', async () => {
  const entries = Array.from({ length: MAX_ENTRIES + 1 }, () => clientEntry());
  await assert.rejects(ingestBatch(clientBatch(entries), fakeLog()), /Too many entries/);
});

test('accepts an empty batch without writing', async () => {
  const log = fakeLog();
  const result = await ingestBatch(clientBatch([]), log);
  assert.equal(result.entriesLogged, 0);
  assert.equal(log.written, null);
});

test('tolerates missing device and null entries', async () => {
  const log = fakeLog();
  const entry = clientEntry();
  delete entry.device;
  await ingestBatch(clientBatch([entry, null]), log);
  assert.equal(log.written.length, 2);
  assert.equal(log.written[0].metadata.labels.app_version, undefined);
});

test('truncates long messages and maps unknown severities to DEFAULT', async () => {
  const log = fakeLog();
  const entry = clientEntry({ message: 'x'.repeat(MAX_MESSAGE_LENGTH + 10), severity: 'LOUD' });
  await ingestBatch(clientBatch([entry]), log);
  assert.equal(log.written[0].data.message.length, MAX_MESSAGE_LENGTH);
  assert.equal(log.written[0].metadata.severity, 'DEFAULT');
});
