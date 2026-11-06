const { test } = require('node:test');
const assert = require('node:assert/strict');

const presence = require('../presence.js');
const {
  areFriends,
  chunkUpdate,
  friendshipPair,
  isValidUid,
  mirrorUpdate,
  reconcileUpdate,
} = presence;

// A fake Realtime Database that applies multi-path updates to a plain tree.
function fakeRtdb(initial = {}) {
  const tree = JSON.parse(JSON.stringify(initial));
  const updates = [];
  const setPath = (path, value) => {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] || {};
      node = node[part];
    }
    const leaf = parts[parts.length - 1];
    if (value === null) {
      delete node[leaf];
    } else {
      node[leaf] = value;
    }
  };
  return {
    tree,
    updates,
    database() {
      return {
        ref(path) {
          return {
            async update(update) {
              assert.equal(path, undefined, 'updates go to the root');
              updates.push(update);
              for (const [p, v] of Object.entries(update)) setPath(p, v);
            },
            async get() {
              return { val: () => (path === 'friendsOf' ? tree.friendsOf || null : null) };
            },
          };
        },
      };
    },
  };
}

// A fake Firestore holding friendships/{id}.
function fakeDb(friendships) {
  const docs = Object.entries(friendships).map(([id, data]) => ({ id, data: () => data, exists: true }));
  return {
    collection(name) {
      assert.equal(name, 'friendships');
      let filtered = docs;
      let after = null;
      const query = {
        doc(id) {
          return { async get() { return docs.find(d => d.id === id) || { exists: false, data: () => undefined }; } };
        },
        where(field, op, value) {
          filtered = filtered.filter(d => d.data()[field] === value);
          return query;
        },
        orderBy() { return query; },
        limit() { return query; },
        startAfter(doc) { after = doc; return query; },
        async get() {
          const start = after ? filtered.indexOf(after) + 1 : 0;
          const page = filtered.slice(start);
          return { empty: page.length === 0, size: page.length, docs: page, forEach: (f) => page.forEach(f) };
        },
      };
      return query;
    },
  };
}

function writeEvent(friendshipId, before, after) {
  const snap = (data) => ({ exists: !!data, data: () => data });
  return { params: { friendshipId }, data: { before: snap(before), after: snap(after) } };
}

test('mirrorFriendsOf listens to every friendship write', () => {
  const { mirrorFriendsOf, adminBackfillFriendsOf } = presence({ admin: {}, db: {} });
  assert.match(mirrorFriendsOf.__endpoint.eventTrigger.eventType, /document\.v1\.written/);
  assert.equal(mirrorFriendsOf.__endpoint.eventTrigger.eventFilterPathPatterns.document, 'friendships/{friendshipId}');
  assert.equal(mirrorFriendsOf.__endpoint.eventTrigger.retry, true);
  assert.ok(adminBackfillFriendsOf.__endpoint.httpsTrigger, 'the backfill is an HTTPS admin function');
  assert.deepEqual(adminBackfillFriendsOf.__endpoint.httpsTrigger.invoker, ['private']);
});

test('only an accepted friendship without a deleted account counts', () => {
  assert.equal(areFriends({ status: 'accepted' }), true);
  for (const status of ['pending', 'blocked', 'rejected', undefined]) {
    assert.equal(areFriends({ status }), false, `${status} shouldn't count`);
  }
  assert.equal(areFriends({ status: 'accepted', containsDeletedUser: true }), false);
  assert.equal(areFriends(null), false);
});

test('the pair comes from the fields, or the ID when they are missing', () => {
  assert.deepEqual(friendshipPair('a_b', { user1Id: 'bob', user2Id: 'alice' }), ['alice', 'bob']);
  assert.deepEqual(friendshipPair('alice_bob', {}), ['alice', 'bob']);
  assert.deepEqual(friendshipPair('alice_bob', null), ['alice', 'bob']);
  assert.equal(friendshipPair('group_a_b', {}), null);
  assert.equal(friendshipPair('alice_alice', {}), null);
  assert.equal(friendshipPair('al.ice_bob', {}), null);
  // A newline pasted into a field falls back to the friendship's ID.
  assert.deepEqual(friendshipPair('alice_bob', { user1Id: 'alice', user2Id: 'bob\n' }), ['alice', 'bob']);
  assert.equal(isValidUid('bob\n'), false);
  assert.equal(isValidUid('bo\u007Fb'), false);
});

test('a key Realtime Database would reject is not a user ID', () => {
  for (const bad of ['', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'x'.repeat(129), 42, null]) {
    assert.equal(isValidUid(bad), false, `${bad} should be rejected`);
  }
  assert.equal(isValidUid('Xk2p9LmQ7rT4vW1yZ3aB5cD8eF0g'), true);
});

test('the mirror writes or clears both directions', () => {
  assert.deepEqual(mirrorUpdate(['alice', 'bob'], true), {
    'friendsOf/alice/bob': true,
    'friendsOf/bob/alice': true,
  });
  assert.deepEqual(mirrorUpdate(['alice', 'bob'], false), {
    'friendsOf/alice/bob': null,
    'friendsOf/bob/alice': null,
  });
});

test('accepting a request adds both directions', async () => {
  const rtdb = fakeRtdb();
  const db = fakeDb({ alice_bob: { user1Id: 'alice', user2Id: 'bob', status: 'accepted' } });
  const { mirrorFriendsOf } = presence({ admin: rtdb, db });
  await mirrorFriendsOf.run(writeEvent('alice_bob', { status: 'pending' }, { status: 'accepted' }));
  assert.deepEqual(rtdb.tree.friendsOf, { alice: { bob: true }, bob: { alice: true } });
});

test('a block removes both directions', async () => {
  const rtdb = fakeRtdb({ friendsOf: { alice: { bob: true, carol: true }, bob: { alice: true } } });
  const db = fakeDb({ alice_bob: { user1Id: 'alice', user2Id: 'bob', status: 'blocked', blockedBy: 'alice' } });
  const { mirrorFriendsOf } = presence({ admin: rtdb, db });
  await mirrorFriendsOf.run(writeEvent('alice_bob', { status: 'accepted' }, { status: 'blocked' }));
  assert.deepEqual(rtdb.tree.friendsOf, { alice: { carol: true }, bob: {} });
});

test('an unfriend (the document is deleted) removes both directions', async () => {
  const rtdb = fakeRtdb({ friendsOf: { alice: { bob: true }, bob: { alice: true } } });
  const db = fakeDb({});
  const { mirrorFriendsOf } = presence({ admin: rtdb, db });
  await mirrorFriendsOf.run(writeEvent('alice_bob', { user1Id: 'alice', user2Id: 'bob', status: 'accepted' }, null));
  assert.deepEqual(rtdb.updates, [{ 'friendsOf/alice/bob': null, 'friendsOf/bob/alice': null }]);
});

test('a deleted account removes both directions', async () => {
  const rtdb = fakeRtdb({ friendsOf: { alice: { bob: true }, bob: { alice: true } } });
  const db = fakeDb({ alice_bob: { user1Id: 'alice', user2Id: 'bob', status: 'accepted', containsDeletedUser: true } });
  const { mirrorFriendsOf } = presence({ admin: rtdb, db });
  await mirrorFriendsOf.run(writeEvent('alice_bob', { status: 'accepted' }, { status: 'accepted', containsDeletedUser: true }));
  assert.deepEqual(rtdb.updates, [{ 'friendsOf/alice/bob': null, 'friendsOf/bob/alice': null }]);
});

test('a late event follows the friendship as it is now, not the event', async () => {
  // The accept event runs after the block already happened: stay cleared.
  const rtdb = fakeRtdb();
  const db = fakeDb({ alice_bob: { user1Id: 'alice', user2Id: 'bob', status: 'blocked' } });
  const { mirrorFriendsOf } = presence({ admin: rtdb, db });
  await mirrorFriendsOf.run(writeEvent('alice_bob', { status: 'pending' }, { status: 'accepted' }));
  assert.deepEqual(rtdb.updates, [{ 'friendsOf/alice/bob': null, 'friendsOf/bob/alice': null }]);
});

test("a friendship it can't place is skipped", async () => {
  const rtdb = fakeRtdb();
  const { mirrorFriendsOf } = presence({ admin: rtdb, db: fakeDb({}) });
  await mirrorFriendsOf.run(writeEvent('group_x_y', null, { status: 'accepted' }));
  assert.equal(rtdb.updates.length, 0);
});

test('reconciling adds what is missing and removes the rest', () => {
  const existing = {
    alice: { bob: true, mallory: true, junk: 'yes' },
    bob: { alice: 'true' },
    mallory: { alice: true },
  };
  const { update, added, removed } = reconcileUpdate([['alice', 'bob'], ['carol', 'dave']], existing);
  assert.deepEqual(update, {
    'friendsOf/bob/alice': true,
    'friendsOf/carol/dave': true,
    'friendsOf/dave/carol': true,
    'friendsOf/alice/mallory': null,
    'friendsOf/alice/junk': null,
    'friendsOf/mallory/alice': null,
  });
  assert.equal(added, 3);
  assert.equal(removed, 3);
});

test('reconciling a mirror that already matches changes nothing', () => {
  const { update } = reconcileUpdate([['alice', 'bob']], { alice: { bob: true }, bob: { alice: true } });
  assert.deepEqual(update, {});
});

test('updates split into chunks', () => {
  const update = Object.fromEntries(Array.from({ length: 1201 }, (_, i) => [`friendsOf/u${i}/x`, true]));
  const chunks = chunkUpdate(update);
  assert.deepEqual(chunks.map(c => Object.keys(c).length), [500, 500, 201]);
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('the backfill dry run reports without writing, and the real run makes the mirror match', async () => {
  const friendships = {
    alice_bob: { user1Id: 'alice', user2Id: 'bob', status: 'accepted' },
    alice_carol: { user1Id: 'alice', user2Id: 'carol', status: 'pending' },
    bob_dave: { user1Id: 'bob', user2Id: 'dave', status: 'blocked' },
    carol_erin: { user1Id: 'carol', user2Id: 'erin', status: 'accepted', containsDeletedUser: true },
  };
  const rtdb = fakeRtdb({ friendsOf: { bob: { dave: true }, dave: { bob: true } } });
  const { adminBackfillFriendsOf } = presence({ admin: rtdb, db: fakeDb(friendships) });
  const request = (body) => ({ method: 'POST', body, get: () => '', headers: {} });

  const dry = fakeResponse();
  await adminBackfillFriendsOf(request({ dryRun: true }), dry);
  assert.deepEqual(dry.body, { success: true, dryRun: true, scanned: 2, pairs: 1, added: 2, removed: 2, skipped: 1 });
  assert.equal(rtdb.updates.length, 0);

  const real = fakeResponse();
  await adminBackfillFriendsOf(request({}), real);
  assert.equal(real.body.dryRun, false);
  assert.deepEqual(rtdb.tree.friendsOf, { alice: { bob: true }, bob: { alice: true }, dave: {} });
});
