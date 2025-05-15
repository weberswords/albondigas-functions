const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Accept a friend request
exports.acceptFriendRequest = functions.https.onCall(async (data, context) => {
  // Security: Check if user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to accept friend requests'
    );
  }

  const { friendshipId } = data;
  const acceptingUserId = context.auth.uid;

  if (!friendshipId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Friendship ID is required'
    );
  }

  const db = admin.firestore();

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'Friend request not found'
        );
      }

      const friendshipData = friendshipDoc.data();
      
      // Verify status
      if (friendshipData.status !== 'pending') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request is no longer pending'
        );
      }

      // Verify user is allowed to accept
      if (
        friendshipData.user1Id !== acceptingUserId &&
        friendshipData.user2Id !== acceptingUserId
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You do not have permission to accept this request'
        );
      }

      // Get the other user ID
      const otherUserId = friendshipData.user1Id === acceptingUserId
        ? friendshipData.user2Id
        : friendshipData.user1Id;

      // 1. Update friendship document
      transaction.update(friendshipRef, {
        status: 'accepted',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 2. Update user friendship records
      const user1FriendshipRef = db
        .collection('userFriendships')
        .doc(acceptingUserId)
        .collection('friends')
        .doc(otherUserId);

      const user2FriendshipRef = db
        .collection('userFriendships')
        .doc(otherUserId)
        .collection('friends')
        .doc(acceptingUserId);

      transaction.update(user1FriendshipRef, {
        status: 'accepted',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(user2FriendshipRef, {
        status: 'accepted',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Create a chat room for the two users
      const chatId = [acceptingUserId, otherUserId].sort().join('_');
      
      const chatRef = db.collection('chats').doc(chatId);
      transaction.set(chatRef, {
        id: chatId,
        participants: [acceptingUserId, otherUserId],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        expirationDays: null // No expiration by default
      });

      return { success: true };
    });
  } catch (error) {
    console.error('Error accepting friend request:', error);
    throw new functions.https.HttpsError(
      'internal',
      error.message
    );
  }
});

// Reject/cancel a friend request
exports.rejectFriendRequest = functions.https.onCall(async (data, context) => {
  // Security: Check if user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to reject friend requests'
    );
  }

  const { friendshipId } = data;
  const userId = context.auth.uid;

  if (!friendshipId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Friendship ID is required'
    );
  }

  const db = admin.firestore();

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'Friend request not found'
        );
      }

      const friendshipData = friendshipDoc.data();
      
      // Only pending requests can be rejected
      if (friendshipData.status !== 'pending') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request is no longer pending'
        );
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You do not have permission to reject this request'
        );
      }

      // Get the other user ID
      const otherUserId = friendshipData.user1Id === userId
        ? friendshipData.user2Id
        : friendshipData.user1Id;

      // 1. Delete friendship document
      transaction.delete(friendshipRef);

      // 2. Delete user friendship records
      const user1FriendshipRef = db
        .collection('userFriendships')
        .doc(userId)
        .collection('friends')
        .doc(otherUserId);

      const user2FriendshipRef = db
        .collection('userFriendships')
        .doc(otherUserId)
        .collection('friends')
        .doc(userId);

      transaction.delete(user1FriendshipRef);
      transaction.delete(user2FriendshipRef);

      return { success: true };
    });
  } catch (error) {
    console.error('Error rejecting friend request:', error);
    throw new functions.https.HttpsError(
      'internal',
      error.message
    );
  }
});

// Unfriend someone
exports.unfriend = functions.https.onCall(async (data, context) => {
  // Security: Check if user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to unfriend'
    );
  }

  const { friendId } = data;
  const userId = context.auth.uid;

  if (!friendId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Friend ID is required'
    );
  }

  const db = admin.firestore();
  const friendshipId = [userId, friendId].sort().join('_');

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'Friendship not found'
        );
      }

      const friendshipData = friendshipDoc.data();
      
      // Only accepted friendships can be unfriended
      if (friendshipData.status !== 'accepted') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'You are not currently friends with this user'
        );
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You do not have permission to unfriend this user'
        );
      }

      // Get the other user ID
      const otherUserId = friendshipData.user1Id === userId
        ? friendshipData.user2Id
        : friendshipData.user1Id;

      // 1. Delete friendship document
      transaction.delete(friendshipRef);

      // 2. Delete user friendship records
      const user1FriendshipRef = db
        .collection('userFriendships')
        .doc(userId)
        .collection('friends')
        .doc(otherUserId);

      const user2FriendshipRef = db
        .collection('userFriendships')
        .doc(otherUserId)
        .collection('friends')
        .doc(userId);

      transaction.delete(user1FriendshipRef);
      transaction.delete(user2FriendshipRef);

      return { success: true };
    });
  } catch (error) {
    console.error('Error unfriending user:', error);
    throw new functions.https.HttpsError(
      'internal',
      error.message
    );
  }
});

// Block someone
exports.blockUser = functions.https.onCall(async (data, context) => {
  // Security: Check if user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to block a user'
    );
  }

  const { userId: userToBlockId } = data;
  const blockingUserId = context.auth.uid;

  if (!userToBlockId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'User ID to block is required'
    );
  }

  const db = admin.firestore();
  const friendshipId = [blockingUserId, userToBlockId].sort().join('_');

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get or create the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      // Prepare the friendship data
      const now = admin.firestore.FieldValue.serverTimestamp();
      
      if (friendshipDoc.exists) {
        // Update existing friendship
        transaction.update(friendshipRef, {
          status: 'blocked',
          blockedBy: blockingUserId,
          updatedAt: now
        });
      } else {
        // Create new blocked relationship
        transaction.set(friendshipRef, {
          id: friendshipId,
          user1Id: [blockingUserId, userToBlockId].sort()[0],
          user2Id: [blockingUserId, userToBlockId].sort()[1],
          status: 'blocked',
          blockedBy: blockingUserId,
          createdAt: now,
          updatedAt: now
        });
      }

      // Update/create user friendship records
      const user1FriendshipRef = db
        .collection('userFriendships')
        .doc(blockingUserId)
        .collection('friends')
        .doc(userToBlockId);

      const user2FriendshipRef = db
        .collection('userFriendships')
        .doc(userToBlockId)
        .collection('friends')
        .doc(blockingUserId);

      transaction.set(user1FriendshipRef, {
        friendshipId: friendshipId,
        status: 'blocked',
        role: 'blocker',
        updatedAt: now
      }, { merge: true });

      transaction.set(user2FriendshipRef, {
        friendshipId: friendshipId,
        status: 'blocked',
        role: 'blocked',
        updatedAt: now
      }, { merge: true });

      // Delete any existing chat
      const chatId = [blockingUserId, userToBlockId].sort().join('_');
      const chatRef = db.collection('chats').doc(chatId);
      const chatDoc = await transaction.get(chatRef);
      
      if (chatDoc.exists) {
        transaction.delete(chatRef);
        
        // Also delete messages in that chat
        const messagesQuery = await db
          .collection('messages')
          .where('chatId', '==', chatId)
          .get();
          
        for (const doc of messagesQuery.docs) {
          transaction.delete(doc.ref);
        }
      }

      return { success: true };
    });
  } catch (error) {
    console.error('Error blocking user:', error);
    throw new functions.https.HttpsError(
      'internal',
      error.message
    );
  }
});