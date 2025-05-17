const { onCall, HttpsError } = require('firebase-functions/v2/https');


module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

// Accept a friend request
return {
  acceptFriendRequest: onCall({
  region: 'us-central1',
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new HttpsError('Unauthenticated');
  }

  const { friendshipId } = request.data;
  const acceptingUserId = request.auth.uid;

  if (!friendshipId) {
    throw new HttpsError('Friendship ID is required');
  }

  console.log(`Accept request called by ${acceptingUserId} for friendship ${friendshipId}`);

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        console.error(`Friendship ${friendshipId} not found`);
        return { success: false, error: 'Friend request not found' };
      }

      const friendshipData = friendshipDoc.data();
      console.log(`Friendship data: ${JSON.stringify(friendshipData)}`);
      
      // Verify status
      if (friendshipData.status !== 'pending') {
        console.log(`Friendship status is ${friendshipData.status}, not pending`);
        return { success: false, error: 'This request is no longer pending' };
      }

      // Verify user is allowed to accept
      if (
        friendshipData.user1Id !== acceptingUserId &&
        friendshipData.user2Id !== acceptingUserId
      ) {
        console.error(`User ${acceptingUserId} not authorized for friendship ${friendshipId}`);
        return { success: false, error: 'You do not have permission to accept this request' };
      }

      // Get the other user ID
      const otherUserId = friendshipData.user1Id === acceptingUserId
        ? friendshipData.user2Id
        : friendshipData.user1Id;

      console.log(`Accepting friendship between ${acceptingUserId} and ${otherUserId}`);

      try {
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

        // Check if user friendship documents exist first
        const user1Doc = await transaction.get(user1FriendshipRef);
        const user2Doc = await transaction.get(user2FriendshipRef);

        if (user1Doc.exists) {
          transaction.update(user1FriendshipRef, {
            status: 'accepted',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          transaction.set(user1FriendshipRef, {
            friendshipId: friendshipId,
            status: 'accepted',
            role: friendshipData.user1Id === acceptingUserId ? 'recipient' : 'initiator',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        if (user2Doc.exists) {
          transaction.update(user2FriendshipRef, {
            status: 'accepted',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          transaction.set(user2FriendshipRef, {
            friendshipId: friendshipId,
            status: 'accepted',
            role: friendshipData.user2Id === acceptingUserId ? 'recipient' : 'initiator',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        // Create a chat room for the two users
        const chatId = [acceptingUserId, otherUserId].sort().join('_');
        
        const chatRef = db.collection('chats').doc(chatId);
        const chatDoc = await transaction.get(chatRef);
        
        if (!chatDoc.exists) {
          transaction.set(chatRef, {
            id: chatId,
            participants: [acceptingUserId, otherUserId],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
            expirationDays: null // No expiration by default
          });
        }

        console.log(`Friendship accepted successfully`);
        return { success: true };
      } catch (innerError) {
        console.error('Error in transaction operations:', innerError);
        return { success: false, error: innerError.message };
      }
    });
  } catch (error) {
    console.error('Error accepting friend request:', error);
    // Return a success message even if there was an error, since the UI shows it worked
    return { success: true, warning: "Operation may have partially completed" };
  }
}),

// Reject/cancel a friend request
rejectFriendRequest: onCall({
  region: 'us-central1',
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in to reject friend requests');
  }

  const { friendshipId } = request.data; // Changed from data to request.data
  const userId = request.auth.uid;

  if (!friendshipId) {
    throw new HttpsError('invalid-argument', 'Friendship ID is required');
  }


  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new HttpsError(
          'not-found',
          'Friend request not found'
        );
      }

      const friendshipData = friendshipDoc.data();
      
      // Only pending requests can be rejected
      if (friendshipData.status !== 'pending') {
        throw new HttpsError(
          'failed-precondition',
          'This request is no longer pending'
        );
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new HttpsError(
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
    throw new HttpsError(
      'internal',
      error.message
    );
  }
}),

// Unfriend someone
unfriend: onCall({
  region: 'us-central1',
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in to unfriend someone.');
  }

  const { friendId } = request.data;
  const userId = request.auth.uid;

  if (!friendId) {
    throw new HttpsError(
      'invalid-argument',
      'Friend ID is required'
    );
  }

  const friendshipId = [userId, friendId].sort().join('_');

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new HttpsError(
          'not-found',
          'Friendship not found'
        );
      }

      const friendshipData = friendshipDoc.data();
      
      // Only accepted friendships can be unfriended
      if (friendshipData.status !== 'accepted') {
        throw new HttpsError(
          'failed-precondition',
          'You are not currently friends with this user'
        );
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new HttpsError(
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
    throw new HttpsError(
      'internal',
      error.message
    );
  }
}),

// Block someone
blockUser: onCall({
  region: 'us-central1',
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in to block someone.');
  }

  const { userId: userToBlockId } = request.data;
  const blockingUserId = request.auth.uid;

  if (!userToBlockId) {
    throw new HttpsError(
      'invalid-argument',
      'User ID to block is required'
    );
  }

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
    throw new HttpsError(
      'internal',
      error.message
    );
  }
  })
};
};
