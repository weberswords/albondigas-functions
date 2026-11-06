const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { adminFunction } = require('./admin');

// Realtime Database rules can't read Firestore, so the presence read rule
// (albondigas database.rules.json) checks a mirror of who's friends with whom:
//
//   friendsOf/{uid}/{friendId}: true
//
// Only these functions write it (the rules deny every client write). It holds
// a pair only while their friendship is accepted and neither account is
// deleted. A pending request, a block, an unfriend, or a deleted account
// removes both directions. See albondigas docs/PRESENCE.md.

// Characters Realtime Database doesn't allow in a key: . # $ [ ] / and
// ASCII control characters, such as a newline pasted into a user ID.
// eslint-disable-next-line no-control-regex
const INVALID_KEY = /[.#$[\]/\u0000-\u001F\u007F]/;

function isValidUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !INVALID_KEY.test(uid);
}

// The two people in a friendship, from its fields, or from its ID
// (sorted user IDs joined with `_`) when the fields are missing.
function friendshipPair(friendshipId, data) {
  let a = data && data.user1Id;
  let b = data && data.user2Id;
  if (!isValidUid(a) || !isValidUid(b)) {
    const parts = String(friendshipId || '').split('_');
    if (parts.length !== 2) {
      return null;
    }
    [a, b] = parts;
  }
  if (!isValidUid(a) || !isValidUid(b) || a === b) {
    return null;
  }
  return [a, b].sort();
}

// Whether a friendship document means the two can see each other's presence.
function areFriends(data) {
  return !!data && data.status === 'accepted' && data.containsDeletedUser !== true;
}

// The Realtime Database multi-path update that makes the mirror match.
function mirrorUpdate([a, b], friends) {
  const value = friends ? true : null;
  return {
    [`friendsOf/${a}/${b}`]: value,
    [`friendsOf/${b}/${a}`]: value,
  };
}

// The update that turns `existing` (the current friendsOf tree) into exactly
// the accepted pairs: adds what's missing and removes anything else.
function reconcileUpdate(acceptedPairs, existing) {
  const desired = new Set();
  for (const [a, b] of acceptedPairs) {
    desired.add(`${a}/${b}`);
    desired.add(`${b}/${a}`);
  }

  const have = new Set();
  for (const [uid, friends] of Object.entries(existing || {})) {
    for (const [friendId, value] of Object.entries(friends || {})) {
      if (value === true) {
        have.add(`${uid}/${friendId}`);
      } else {
        // Anything that isn't exactly true is junk; clear it.
        have.add(`!${uid}/${friendId}`);
      }
    }
  }

  const update = {};
  let added = 0;
  let removed = 0;
  for (const key of desired) {
    if (!have.has(key)) {
      update[`friendsOf/${key}`] = true;
      added++;
    }
  }
  for (const key of have) {
    const path = key.startsWith('!') ? key.slice(1) : key;
    // A junk value on a pair that should be there is overwritten by the add.
    if (!desired.has(path)) {
      update[`friendsOf/${path}`] = null;
      removed++;
    }
  }
  return { update, added, removed };
}

// Realtime Database accepts big multi-path updates, but keep each one modest.
function chunkUpdate(update, size = 500) {
  const entries = Object.entries(update);
  const chunks = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return chunks;
}

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;
  const rtdb = () => admin.database();

  return {
    // Every path that changes a friendship (accept, unfriend, block, unblock,
    // repair, account deletion) writes friendships/{id}, so mirroring here
    // covers them all. Events can arrive out of order, so this reads the
    // friendship as it is now instead of trusting the event's snapshot; the
    // last event to run always leaves the mirror right.
    mirrorFriendsOf: onDocumentWritten({
      document: 'friendships/{friendshipId}',
      region: 'us-central1',
      retry: true,
    }, async (event) => {
      const friendshipId = event.params.friendshipId;
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;

      const current = await db.collection('friendships').doc(friendshipId).get();
      const data = current.exists ? current.data() : null;
      const pair = friendshipPair(friendshipId, data || after || before);
      if (!pair) {
        console.warn(`friendsOf: can't tell who's in friendship ${friendshipId}; skipped`);
        return;
      }

      const friends = areFriends(data);
      await rtdb().ref().update(mirrorUpdate(pair, friends));
      console.log(`friendsOf: ${friends ? 'set' : 'cleared'} for friendship ${friendshipId}`);
    }),

    // One-time backfill, safe to run again: makes friendsOf match every
    // accepted friendship in Firestore and removes anything else. Run with
    // {"dryRun":true} first. Deploy this and mirrorFriendsOf, run this, then
    // deploy the database rules.
    adminBackfillFriendsOf: adminFunction({
      maxInstances: 1,
      timeoutSeconds: 540
    }, async (body, caller) => {
      const dryRun = body.dryRun === true;
      const pageSize = 500;
      const acceptedPairs = [];
      let scanned = 0;
      let skipped = 0;
      let last = null;

      while (true) {
        let query = db.collection('friendships')
          .where('status', '==', 'accepted')
          .orderBy('__name__')
          .limit(pageSize);
        if (last) {
          query = query.startAfter(last);
        }
        const snap = await query.get();
        if (snap.empty) {
          break;
        }
        snap.forEach(doc => {
          scanned++;
          const data = doc.data();
          const pair = friendshipPair(doc.id, data);
          if (!pair || !areFriends(data)) {
            skipped++;
            return;
          }
          acceptedPairs.push(pair);
        });
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) {
          break;
        }
      }

      const existing = (await rtdb().ref('friendsOf').get()).val();
      const { update, added, removed } = reconcileUpdate(acceptedPairs, existing);

      if (!dryRun) {
        for (const chunk of chunkUpdate(update)) {
          await rtdb().ref().update(chunk);
        }
      }

      console.log(`friendsOf backfill by ${caller}: scanned ${scanned}, pairs ${acceptedPairs.length}, added ${added}, removed ${removed}, skipped ${skipped}, dryRun ${dryRun}`);
      return { success: true, dryRun, scanned, pairs: acceptedPairs.length, added, removed, skipped };
    }),
  };
};

Object.assign(module.exports, {
  areFriends,
  chunkUpdate,
  friendshipPair,
  isValidUid,
  mirrorUpdate,
  reconcileUpdate,
});
