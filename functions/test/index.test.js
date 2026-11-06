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

// presence.js writes Realtime Database, and passing options to initializeApp
// stops the SDK reading FIREBASE_CONFIG itself, so index.js must pass the URL.
test('index.js passes the Realtime Database URL from FIREBASE_CONFIG', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /process\.env\.FIREBASE_CONFIG/);
  assert.match(source, /databaseURL: firebaseConfig\.databaseURL/);
  assert.match(source, /exports\.mirrorFriendsOf = presenceFunctions\.mirrorFriendsOf/);
  assert.match(source, /exports\.adminBackfillFriendsOf = presenceFunctions\.adminBackfillFriendsOf/);
});
