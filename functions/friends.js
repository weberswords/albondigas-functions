const { onCall, HttpsError } = require('firebase-functions/v2/https');


module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;
  const storage = admin.storage();

  // Helper to extract storage path from URL
  function extractStoragePath(url) {
    if (!url) return null;

    try {
      const urlObj = new URL(url);
      const pathMatch = urlObj.pathname.match(/\/o\/(.+?)(\?|$)/);
      if (pathMatch && pathMatch[1]) {
        return decodeURIComponent(pathMatch[1]);
      }
    } catch (error) {
      console.error('Failed to parse URL:', url);
    }

    return null;
  }

  // Helper to delete file from storage
  async function deleteFromStorage(path) {
    try {
      const bucket = storage.bucket();
      await bucket.file(path).delete();
      console.log(`🗑️ Deleted from storage: ${path}`);
    } catch (error) {
      if (error.code === 404) {
        console.log(`⚠️ File already deleted: ${path}`);
      } else {
        console.error(`❌ Failed to delete from storage: ${path}`, error);
      }
    }
  }

  // Helper to archive a user's videos in a chat
  // Archives videos instead of deleting - users retain ownership of content they created
  async function archiveUserVideos(chatId, senderId, reason = 'unfriended') {
    const messagesRef = db.collection('chats').doc(chatId).collection('messages');

    // Query for this user's non-deleted, non-archived videos
    const snapshot = await messagesRef
      .where('senderId', '==', senderId)
      .where('isDeleted', '!=', true)
      .get();

    if (snapshot.empty) {
      console.log(`📦 No videos to archive for user ${senderId} in chat ${chatId}`);
      return 0;
    }

    // Firestore batches have a limit of 500 operations
    const BATCH_SIZE = 500;
    let archivedCount = 0;
    let batch = db.batch();
    let operationCount = 0;

    for (const doc of snapshot.docs) {
      const messageData = doc.data();

      // Skip if already archived
      if (messageData.isArchived) {
        continue;
      }

      batch.update(doc.ref, {
        isArchived: true,
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
        archivedReason: reason,
        originalChatId: chatId
      });

      operationCount++;
      archivedCount++;

      // Commit batch if we hit the limit
      if (operationCount >= BATCH_SIZE) {
        await batch.commit();
        console.log(`📦 Committed batch of ${operationCount} archives`);
        batch = db.batch();
        operationCount = 0;
      }
    }

    // Commit any remaining operations
    if (operationCount > 0) {
      await batch.commit();
      console.log(`📦 Committed final batch of ${operationCount} archives`);
    }

    console.log(`📦 Archived ${archivedCount} videos for user ${senderId} in chat ${chatId}`);
    return archivedCount;
  }

  // Accept a friend request
  return {
    acceptFriendRequest: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (request) => {
      // Security check remains the same
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { friendshipId } = request.data;
      const acceptingUserId = request.auth.uid;

      if (!friendshipId) {
        throw new HttpsError('invalid-argument', 'Friendship ID is required');
      }

      console.log(`🔔 FRIEND ACCEPT: User ${acceptingUserId} accepting friendship ${friendshipId}`);

      try {
        return await db.runTransaction(async (transaction) => {
          // STEP 1: GATHER ALL DOCUMENT REFERENCES WE'LL NEED
          console.log(`📚 Getting document references for friendship ${friendshipId}`);
          const friendshipRef = db.collection('friendships').doc(friendshipId);

          // STEP 2: READ ALL DOCUMENTS FIRST
          console.log(`📖 Reading friendship document ${friendshipId}`);
          const friendshipDoc = await transaction.get(friendshipRef);



          // In acceptFriendRequest, before accessing friendship data:
          if (!friendshipDoc.exists || !friendshipDoc.data()) {
            console.error(`❌ Friendship ${friendshipId} not found or has no data`);
            return { success: false, error: 'Friend request not found' };
          }

          const friendshipData = friendshipDoc.data();
          if (!friendshipData.user1Id || !friendshipData.user2Id) {
            console.error(`❌ Friendship ${friendshipId} missing user IDs`);
            return { success: false, error: 'Invalid friendship data' };
          }

          console.log(`ℹ️ Friendship data: ${JSON.stringify(friendshipData)}`);

          if (friendshipData.status !== 'pending') {
            console.log(`⚠️ Friendship status is ${friendshipData.status}, not pending`);
            return { success: false, error: 'This request is no longer pending' };
          }

          if (
            friendshipData.user1Id !== acceptingUserId &&
            friendshipData.user2Id !== acceptingUserId
          ) {
            console.error(`🚫 User ${acceptingUserId} not authorized for friendship ${friendshipId}`);
            return { success: false, error: 'You do not have permission to accept this request' };
          }

          // Get the other user ID
          const otherUserId = friendshipData.user1Id === acceptingUserId
            ? friendshipData.user2Id
            : friendshipData.user1Id;

          console.log(`🤝 Accepting friendship between ${acceptingUserId} and ${otherUserId}`);

          // Set up all references
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

          const chatId = [acceptingUserId, otherUserId].sort().join('_');
          const chatRef = db.collection('chats').doc(chatId);

          console.log(`📖 Reading user friendship documents and chat document`);
          // Read all documents before any writes
          const user1Doc = await transaction.get(user1FriendshipRef);
          const user2Doc = await transaction.get(user2FriendshipRef);
          const chatDoc = await transaction.get(chatRef);

          console.log(`✏️ Starting write operations in transaction`);
          // STEP 4: NOW PERFORM ALL WRITES, AFTER ALL READS ARE COMPLETE

          // 1. Update friendship document
          console.log(`✏️ Updating friendship document to 'accepted'`);
          transaction.update(friendshipRef, {
            status: 'accepted',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          // 2. Update user1 friendship record
          if (user1Doc.exists) {
            console.log(`✏️ Updating existing friendship record for ${acceptingUserId}`);
            transaction.update(user1FriendshipRef, {
              status: 'accepted',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            console.log(`✏️ Creating new friendship record for ${acceptingUserId}`);
            transaction.set(user1FriendshipRef, {
              friendshipId: friendshipId,
              status: 'accepted',
              role: friendshipData.user1Id === acceptingUserId ? 'recipient' : 'initiator',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          // 3. Update user2 friendship record
          if (user2Doc.exists) {
            console.log(`✏️ Updating existing friendship record for ${otherUserId}`);
            transaction.update(user2FriendshipRef, {
              status: 'accepted',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            console.log(`✏️ Creating new friendship record for ${otherUserId}`);
            transaction.set(user2FriendshipRef, {
              friendshipId: friendshipId,
              status: 'accepted',
              role: friendshipData.user2Id === acceptingUserId ? 'recipient' : 'initiator',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          // 4. Create chat if it doesn't exist
          if (!chatDoc.exists) {
            console.log(`✏️ Creating new chat room with ID ${chatId}`);
            transaction.set(chatRef, {
              id: chatId,
              participants: [acceptingUserId, otherUserId],
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
              expirationDays: null // No expiration by default
            });
          } else {
            console.log(`ℹ️ Chat room ${chatId} already exists, skipping creation`);
          }

          console.log(`✅ Friendship accepted successfully`);
          return { success: true };
        });
      } catch (error) {
        console.error(`❌ Error accepting friend request: ${error}`);
        return { success: false, error: error.message };
      }
    }),

// Add this function to friends.js, inside the returned object

sendFriendRequest: onCall(async (request) => {
    console.log('📨 sendFriendRequest started');
    
    // Validate authentication
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }
    
    const senderId = request.auth.uid;
    const { email } = request.data;
    
    if (!email) {
        throw new HttpsError('invalid-argument', 'Email is required');
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`📨 Sender: ${senderId}, Target email: ${normalizedEmail}`);
    
    try {
        // Find target user by email
        const usersSnapshot = await db.collection('users')
            .where('email', '==', normalizedEmail)
            .limit(1)
            .get();
        
        if (usersSnapshot.empty) {
            console.log('❌ User not found for email:', normalizedEmail);
            throw new HttpsError('not-found', 'User not found');
        }
        
        const targetUser = usersSnapshot.docs[0];
        const targetUserId = targetUser.id;
        const targetUserData = targetUser.data();
        
        // Prevent self-friending
        if (targetUserId === senderId) {
            throw new HttpsError('invalid-argument', 'Cannot send friend request to yourself');
        }
        
        // Create friendship ID (sorted for consistency)
        const friendshipId = [senderId, targetUserId].sort().join('_');
        console.log(`📨 Friendship ID: ${friendshipId}`);
        
        // Check existing friendship status
        const existingFriendship = await db.collection('friendships').doc(friendshipId).get();
        
        if (existingFriendship.exists) {
            const data = existingFriendship.data();
            const status = data.status;
            const blockedBy = data.blockedBy;
            
            if (status === 'blocked') {
                    throw new HttpsError('not-found', 'User not found');
            }
            
            if (status === 'accepted') {
                throw new HttpsError('already-exists', 'Already friends with this user');
            }
            
            if (status === 'pending') {
                throw new HttpsError('already-exists', 'Friend request already pending');
            }
        }
        
        // Get sender info for the request
        const senderDoc = await db.collection('users').doc(senderId).get();
        const senderData = senderDoc.data() || {};
        
        const now = admin.firestore.Timestamp.now();
        
        // Use a batch to write all documents atomically
        const batch = db.batch();
        
        // 1. Create/update main friendship document
        const friendshipRef = db.collection('friendships').doc(friendshipId);
        batch.set(friendshipRef, {
            id: friendshipId,
            user1Id: [senderId, targetUserId].sort()[0],
            user2Id: [senderId, targetUserId].sort()[1],
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            initiatorId: senderId
        });
        
        // 2. Create sender's userFriendships entry
        const senderFriendRef = db.collection('userFriendships')
            .doc(senderId)
            .collection('friends')
            .doc(targetUserId);
        batch.set(senderFriendRef, {
            friendshipId: friendshipId,
            status: 'pending',
            role: 'initiator',
            createdAt: now
        });
        
        // 3. Create recipient's userFriendships entry
        const recipientFriendRef = db.collection('userFriendships')
            .doc(targetUserId)
            .collection('friends')
            .doc(senderId);
        batch.set(recipientFriendRef, {
            friendshipId: friendshipId,
            status: 'pending',
            role: 'recipient',
            createdAt: now
        });
        
        await batch.commit();
        
        console.log('✅ Friend request sent successfully');
        
        return {
            success: true,
            friendshipId: friendshipId,
            targetUserId: targetUserId,
            targetDisplayName: targetUserData.displayName || 'Unknown'
        };
        
    } catch (error) {
        console.error('❌ Error sending friend request:', error);
        
        if (error instanceof HttpsError) {
            throw error;
        }
        
        throw new HttpsError('internal', error.message || 'Failed to send friend request');
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
      timeoutSeconds: 120
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to unfriend someone.');
      }

      const { friendId } = request.data;
      const userId = request.auth.uid;

      if (!friendId) {
        throw new HttpsError('invalid-argument', 'Friend ID is required');
      }

      const friendshipId = [userId, friendId].sort().join('_');
      const chatId = [userId, friendId].sort().join('_');

      console.log(`👋 UNFRIEND: User ${userId} unfriending ${friendId}`);

      try {
        // First, run the transaction to update friendship/chat status
        const result = await db.runTransaction(async (transaction) => {
          // Get the friendship document
          const friendshipRef = db.collection('friendships').doc(friendshipId);
          const friendshipDoc = await transaction.get(friendshipRef);

          if (!friendshipDoc.exists) {
            throw new HttpsError('not-found', 'Friendship not found');
          }

          const friendshipData = friendshipDoc.data();

          // Only accepted friendships can be unfriended
          if (friendshipData.status !== 'accepted') {
            throw new HttpsError('failed-precondition', 'You are not currently friends with this user');
          }

          // Verify user is party to this friendship
          if (friendshipData.user1Id !== userId && friendshipData.user2Id !== userId) {
            throw new HttpsError('permission-denied', 'You do not have permission to unfriend this user');
          }

          // Get the other user ID
          const otherUserId = friendshipData.user1Id === userId
            ? friendshipData.user2Id
            : friendshipData.user1Id;

          // Get chat document (must read before any writes in transaction)
          const chatRef = db.collection('chats').doc(chatId);
          const chatDoc = await transaction.get(chatRef);

          // 1. Record the unfriend event
          const eventRef = db.collection('friendshipEvents').doc();
          transaction.set(eventRef, {
            friendshipId: friendshipId,
            action: 'unfriend',
            initiatorId: userId,
            targetId: otherUserId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });

          // 2. Delete friendship document
          transaction.delete(friendshipRef);

          // 3. Delete user friendship records
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

          // 4. Mark chat as inactive (don't delete it)
          if (chatDoc.exists) {
            transaction.update(chatRef, {
              isActive: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          return { success: true, otherUserId, chatExists: chatDoc.exists };
        });

        // 5. Archive videos for both users (outside transaction due to potential batch size)
        if (result.chatExists) {
          console.log(`📦 Archiving videos for chat ${chatId}`);
          await archiveUserVideos(chatId, userId);
          await archiveUserVideos(chatId, result.otherUserId);
        }

        console.log(`✅ Unfriended successfully, videos archived`);
        return { success: true };
      } catch (error) {
        console.error('Error unfriending user:', error);
        throw new HttpsError('internal', error.message);
      }
    }),

    // Helper function exposed for potential direct calls
    archiveVideosForChat: onCall({
      region: 'us-central1',
      maxInstances: 5,
      timeoutSeconds: 120
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      // Admin only or system call
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      const { chatId, senderId, reason = 'manual' } = request.data;
      if (!chatId || !senderId) {
        throw new HttpsError('invalid-argument', 'chatId and senderId are required');
      }

      const archived = await archiveUserVideos(chatId, senderId, reason);
      return { success: true, archivedCount: archived };
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
    }),
    // check friendship status
    checkFriendshipStatus: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { friendId } = request.data;
      const userId = request.auth.uid;

      if (!friendId) {
        throw new HttpsError('invalid-argument', 'Friend ID is required');
      }

      console.log(`🔍 CHECKING: Friendship status between ${userId} and ${friendId}`);

      try {
        // Get all relevant documents
        const friendshipId = [userId, friendId].sort().join('_');
        const friendshipRef = db.collection('friendships').doc(friendshipId);

        const user1FriendshipRef = db
          .collection('userFriendships')
          .doc(userId)
          .collection('friends')
          .doc(friendId);

        const user2FriendshipRef = db
          .collection('userFriendships')
          .doc(friendId)
          .collection('friends')
          .doc(userId);

        const chatId = [userId, friendId].sort().join('_');
        const chatRef = db.collection('chats').doc(chatId);

        // Get all documents
        const [friendshipDoc, user1Doc, user2Doc, chatDoc] = await Promise.all([
          friendshipRef.get(),
          user1FriendshipRef.get(),
          user2FriendshipRef.get(),
          chatRef.get()
        ]);

        // Build status report
        const status = {
          friendshipExists: friendshipDoc.exists,
          friendshipStatus: friendshipDoc.exists ? friendshipDoc.data().status : null,
          user1RecordExists: user1Doc.exists,
          user1Status: user1Doc.exists ? user1Doc.data().status : null,
          user2RecordExists: user2Doc.exists,
          user2Status: user2Doc.exists ? user2Doc.data().status : null,
          chatExists: chatDoc.exists,
          isConsistent: false
        };

        // Check consistency
        if (friendshipDoc.exists) {
          const mainStatus = friendshipDoc.data().status;

          if (mainStatus === 'accepted') {
            // For accepted friendships, both user records and chat should exist
            status.isConsistent =
              user1Doc.exists &&
              user1Doc.data().status === 'accepted' &&
              user2Doc.exists &&
              user2Doc.data().status === 'accepted' &&
              chatDoc.exists;
          } else if (mainStatus === 'pending') {
            // For pending friendships, both user records should exist with correct roles
            status.isConsistent =
              user1Doc.exists &&
              user2Doc.exists;

            // Add role information
            if (user1Doc.exists) {
              status.user1Role = user1Doc.data().role;
            }

            if (user2Doc.exists) {
              status.user2Role = user2Doc.data().role;
            }
          }
        }

        console.log(`✅ Friendship status check completed: ${JSON.stringify(status)}`);
        return status;
      } catch (error) {
        console.error(`❌ Error checking friendship status: ${error}`);
        return { error: error.message };
      }
    }),

    // Unblock someone
    unblockUser: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to unblock someone.');
      }

      const { userId: userToUnblockId } = request.data;
      const unblockingUserId = request.auth.uid;

      if (!userToUnblockId) {
        throw new HttpsError('invalid-argument', 'User ID to unblock is required');
      }

      const friendshipId = [unblockingUserId, userToUnblockId].sort().join('_');

      console.log(`🔓 UNBLOCK: User ${unblockingUserId} unblocking ${userToUnblockId}`);

      try {
        return await db.runTransaction(async (transaction) => {
          // Get the friendship document
          const friendshipRef = db.collection('friendships').doc(friendshipId);
          const friendshipDoc = await transaction.get(friendshipRef);

          if (!friendshipDoc.exists) {
            console.log(`❌ No friendship/block record found with ID ${friendshipId}`);
            return { success: false, error: 'No block record found' };
          }

          const friendshipData = friendshipDoc.data();

          // Verify this is a blocked relationship
          if (friendshipData.status !== 'blocked') {
            console.log(`⚠️ Friendship status is ${friendshipData.status}, not blocked`);
            return { success: false, error: 'This user is not blocked' };
          }

          // Verify the current user is the one who blocked
          if (friendshipData.blockedBy !== unblockingUserId) {
            console.log(`🚫 User ${unblockingUserId} did not block this user`);
            return { success: false, error: 'You did not block this user' };
          }

          console.log(`🔓 Removing block between ${unblockingUserId} and ${userToUnblockId}`);

          // Delete the friendship document (clean slate - they can re-friend if desired)
          transaction.delete(friendshipRef);

          // Delete user friendship records
          const user1FriendshipRef = db
            .collection('userFriendships')
            .doc(unblockingUserId)
            .collection('friends')
            .doc(userToUnblockId);

          const user2FriendshipRef = db
            .collection('userFriendships')
            .doc(userToUnblockId)
            .collection('friends')
            .doc(unblockingUserId);

          transaction.delete(user1FriendshipRef);
          transaction.delete(user2FriendshipRef);

          // Record the unblock event
          const eventRef = db.collection('friendshipEvents').doc();
          transaction.set(eventRef, {
            friendshipId: friendshipId,
            action: 'unblock',
            initiatorId: unblockingUserId,
            targetId: userToUnblockId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log(`✅ User ${userToUnblockId} unblocked successfully`);
          return { success: true };
        });
      } catch (error) {
        console.error(`❌ Error unblocking user: ${error}`);
        throw new HttpsError('internal', error.message);
      }
    }),


    // Repair friendship
    repairFriendshipState: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 60
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { friendId } = request.data;
      const userId = request.auth.uid;

      if (!friendId) {
        throw new HttpsError('invalid-argument', 'Friend ID is required');
      }

      console.log(`🔧 REPAIR: Repairing friendship between ${userId} and ${friendId}`);

      try {
        // Check if the friendship exists in the main collection
        const friendshipId = [userId, friendId].sort().join('_');
        const friendshipRef = db.collection('friendships').doc(friendshipId);

        const friendshipDoc = await friendshipRef.get();
        if (!friendshipDoc.exists) {
          console.log(`❌ No friendship found with ID ${friendshipId}`);
          return { success: false, error: 'No friendship found' };
        }

        const friendshipData = friendshipDoc.data();
        console.log(`ℹ️ Friendship data: ${JSON.stringify(friendshipData)}`);

        // Run a transaction to repair all related documents
        return await db.runTransaction(async (transaction) => {
          // Read all documents first
          const user1FriendshipRef = db
            .collection('userFriendships')
            .doc(userId)
            .collection('friends')
            .doc(friendId);

          const user2FriendshipRef = db
            .collection('userFriendships')
            .doc(friendId)
            .collection('friends')
            .doc(userId);

          const chatId = [userId, friendId].sort().join('_');
          const chatRef = db.collection('chats').doc(chatId);

          // Get all documents
          const user1Doc = await transaction.get(user1FriendshipRef);
          const user2Doc = await transaction.get(user2FriendshipRef);
          const chatDoc = await transaction.get(chatRef);

          console.log(`ℹ️ User1 friendship exists: ${user1Doc.exists}`);
          console.log(`ℹ️ User2 friendship exists: ${user2Doc.exists}`);
          console.log(`ℹ️ Chat exists: ${chatDoc.exists}`);

          // Determine what needs to be repaired based on friendship status
          if (friendshipData.status === 'accepted') {
            console.log(`🔧 Repairing accepted friendship ${friendshipId}`);

            // Ensure user friendship records exist and are marked as accepted
            if (!user1Doc.exists) {
              console.log(`✏️ Creating missing friendship record for ${userId}`);
              transaction.set(user1FriendshipRef, {
                friendshipId: friendshipId,
                status: 'accepted',
                role: friendshipData.user1Id === userId ? 'recipient' : 'initiator',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: friendshipData.createdAt || admin.firestore.FieldValue.serverTimestamp()
              });
            } else if (user1Doc.data().status !== 'accepted') {
              console.log(`✏️ Updating friendship record for ${userId} to accepted`);
              transaction.update(user1FriendshipRef, {
                status: 'accepted',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }

            if (!user2Doc.exists) {
              console.log(`✏️ Creating missing friendship record for ${friendId}`);
              transaction.set(user2FriendshipRef, {
                friendshipId: friendshipId,
                status: 'accepted',
                role: friendshipData.user2Id === friendId ? 'recipient' : 'initiator',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: friendshipData.createdAt || admin.firestore.FieldValue.serverTimestamp()
              });
            } else if (user2Doc.data().status !== 'accepted') {
              console.log(`✏️ Updating friendship record for ${friendId} to accepted`);
              transaction.update(user2FriendshipRef, {
                status: 'accepted',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }

            // Ensure chat exists
            if (!chatDoc.exists) {
              console.log(`✏️ Creating missing chat room with ID ${chatId}`);
              transaction.set(chatRef, {
                id: chatId,
                participants: [userId, friendId],
                createdAt: friendshipData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
                lastMessageAt: friendshipData.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
                expirationDays: null
              });
            }
          } else if (friendshipData.status === 'pending') {
            // Pending friendship doesn't need a chat but should have proper records
            console.log(`🔧 Repairing pending friendship ${friendshipId}`);

            const initiatorId = friendshipData.initiatorId || friendshipData.user1Id;
            const recipientId = initiatorId === userId ? friendId : userId;

            // Update initiator's record
            const initiatorRef = db
              .collection('userFriendships')
              .doc(initiatorId)
              .collection('friends')
              .doc(recipientId);

            const initiatorDoc = initiatorId === userId ? user1Doc : user2Doc;

            if (!initiatorDoc.exists) {
              console.log(`✏️ Creating missing initiator record for ${initiatorId}`);
              transaction.set(initiatorRef, {
                friendshipId: friendshipId,
                status: 'pending',
                role: 'initiator',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: friendshipData.createdAt || admin.firestore.FieldValue.serverTimestamp()
              });
            }

            // Update recipient's record
            const recipientRef = db
              .collection('userFriendships')
              .doc(recipientId)
              .collection('friends')
              .doc(initiatorId);

            const recipientDoc = recipientId === userId ? user1Doc : user2Doc;

            if (!recipientDoc.exists) {
              console.log(`✏️ Creating missing recipient record for ${recipientId}`);
              transaction.set(recipientRef, {
                friendshipId: friendshipId,
                status: 'pending',
                role: 'recipient',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: friendshipData.createdAt || admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }

          console.log(`✅ Friendship repair completed successfully`);
          return { success: true, status: friendshipData.status };
        });
      } catch (error) {
        console.error(`❌ Error repairing friendship: ${error}`);
        return { success: false, error: error.message };
      }
    })


  };
};
