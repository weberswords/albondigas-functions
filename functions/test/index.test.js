const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Cloud Build checks out the repo without the gitignored key file, and
// `firebase deploy` loads index.js to find the functions, so index.js must not
// depend on a service-account key.
test('index.js does not load a service-account key file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /firebase_admin\.json/);
  assert.doesNotMatch(source, /credential\.cert\(/);
});
