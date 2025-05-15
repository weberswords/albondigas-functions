const admin = require('firebase-admin');
const { onCall } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

// Import service account first
const serviceAccount = require('./firebase_admin.json');

// Initialize admin with credentials
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Initialize Firestore
const db = admin.firestore();

// Friend Functions with v2 API
exports.acceptFriendRequest = onCall({
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new Error('Unauthenticated');
  }

  const { friendshipId } = request.data;
  const acceptingUserId = request.auth.uid;

  if (!friendshipId) {
    throw new Error('Friendship ID is required');
  }

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new Error('Friend request not found');
      }

      const friendshipData = friendshipDoc.data();
      
      // Verify status
      if (friendshipData.status !== 'pending') {
        throw new Error('This request is no longer pending');
      }

      // Verify user is allowed to accept
      if (
        friendshipData.user1Id !== acceptingUserId &&
        friendshipData.user2Id !== acceptingUserId
      ) {
        throw new Error('You do not have permission to accept this request');
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
    throw new Error(error.message);
  }
});

exports.rejectFriendRequest = onCall({
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new Error('Unauthenticated');
  }

  const { friendshipId } = request.data;
  const userId = request.auth.uid;

  if (!friendshipId) {
    throw new Error('Friendship ID is required');
  }

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new Error('Friend request not found');
      }

      const friendshipData = friendshipDoc.data();
      
      // Only pending requests can be rejected
      if (friendshipData.status !== 'pending') {
        throw new Error('This request is no longer pending');
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new Error('You do not have permission to reject this request');
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
    throw new Error(error.message);
  }
});

exports.unfriend = onCall({
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new Error('Unauthenticated');
  }

  const { friendId } = request.data;
  const userId = request.auth.uid;

  if (!friendId) {
    throw new Error('Friend ID is required');
  }

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get the friendship document
      const friendshipId = [userId, friendId].sort().join('_');
      const friendshipRef = db.collection('friendships').doc(friendshipId);
      const friendshipDoc = await transaction.get(friendshipRef);

      if (!friendshipDoc.exists) {
        throw new Error('Friendship not found');
      }

      const friendshipData = friendshipDoc.data();
      
      // Only accepted friendships can be unfriended
      if (friendshipData.status !== 'accepted') {
        throw new Error('You are not currently friends with this user');
      }

      // Verify user is party to this friendship
      if (
        friendshipData.user1Id !== userId &&
        friendshipData.user2Id !== userId
      ) {
        throw new Error('You do not have permission to unfriend this user');
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
    throw new Error(error.message);
  }
});

exports.blockUser = onCall({
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
  // Security: Check if user is authenticated
  if (!request.auth) {
    throw new Error('Unauthenticated');
  }

  const { userId: userToBlockId } = request.data;
  const blockingUserId = request.auth.uid;

  if (!userToBlockId) {
    throw new Error('User ID to block is required');
  }

  try {
    // Use a transaction to ensure data consistency
    return await db.runTransaction(async (transaction) => {
      // Get or create the friendship document
      const friendshipId = [blockingUserId, userToBlockId].sort().join('_');
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
        
        // Delete messages would be done in a separate operation 
        // since transactions can't perform queries

        return { success: true, deletedChat: true };
      }

      return { success: true };
    });
  } catch (error) {
    console.error('Error blocking user:', error);
    throw new Error(error.message);
  }
});

// Chat message notification function with v2 API
exports.sendChatMessageNotification = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const chatId = event.params.chatId;
    const messageId = event.params.messageId;
    const messageData = event.data.data();

    try {
      console.log("[DEBUG] Triggered document data:", messageData);

      const senderId = messageData?.senderId;
      const text = messageData?.text;

      // Retrieve chat participants
      const chatDoc = await db.collection("chats").doc(chatId).get();
      if (!chatDoc.exists) {
        console.log(`Chat document ${chatId} not found.`);
        return;
      }

      const participants = chatDoc.data().participants || [];
      const tokens = [];
      const unreadCounts = {};

      for (const userId of participants) {
        if (userId !== senderId) {
          try {
            const userDoc = await db.collection("users").doc(userId).get();
            const userData = userDoc.data();

            if (!userData || !userData.notifyImmediately || !userData.fcmToken) {
              console.log(`[DEBUG] Skipping user ${userId} due to missing FCM token or notification preference.`);
              continue;
            }
          
            const friendDoc = await db
              .collection("users")
              .doc(userId)
              .collection("friends")
              .doc(senderId)
              .get();

            const lastViewedTimestamp = friendDoc.data()?.lastViewedTimestamp;

            if (!lastViewedTimestamp) {
              console.log(`[DEBUG] No lastViewedTimestamp found for user ${userId}`);
              unreadCounts[userId] = 0;
              continue;
            }

            const unreadMessages = await db
              .collection("chats")
              .doc(chatId)
              .collection("messages")
              .where("timestamp", ">", lastViewedTimestamp)
              .get();

            unreadCounts[userId] = unreadMessages.size;

            tokens.push(userData.fcmToken);
          } catch (error) {
            console.error(`[ERROR] Failed to process user ${userId}: `, error);
          }
        }
      }

      const totalBadgeCount = Object.values(unreadCounts)
        .filter((count) => typeof count === "number")
        .reduce((a, b) => a + b, 0);

      console.log("Total badge count: ", totalBadgeCount.toString());

      if (tokens.length === 0) {
        console.log("[DEBUG] No valid FCM tokens found for chat message notification.");
        return;
      }
    
      const payload = {
        notification: {
          title: "New Message",
          body: text || "You have a new message",
        },
        data: {
          chatId: chatId,
          senderId: senderId,
          badge: totalBadgeCount.toString(),
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: "New Message!",
                body: text || "You have a new message.",
              },
              badge: totalBadgeCount,
            },
          },
        },
      };

      console.log("[DEBUG] Payload being sent:", JSON.stringify(payload));

      await admin.messaging().sendEachForMulticast({
        tokens: tokens,
        notification: payload.notification,
        data: payload.data,
      });

      console.log("[DEBUG] Chat message notifications sent successfully");
    } catch (error) {
      console.error("Error in sendChatMessageNotification:", error);
    }
  }
);

// Friend request notification function with v2 API
exports.sendFriendRequestNotification = onDocumentCreated(
  "users/{userId}/friendRequests/{requestId}",
  async (event) => {
    const userId = event.params.userId;
    const requestId = event.params.requestId;
    const requestData = event.data.data();

    try {
      console.log("[DEBUG] Triggered friend request data:", requestData);

      // Fetch recipient's FCM token and notification preferences
      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.data();

      if (!userData || !userData.fcmToken) {
        console.log(`[DEBUG] No FCM token found for user ${userId}.`);
        return;
      }

      // Construct notification payload
      const payload = {
        notification: {
          title: "New Friend Request",
          body: `${requestData.senderUsername} sent you a friend request!`,
        },
        data: {
          senderId: requestData.senderId,
          type: "friend_request",
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: "New Friend Request",
                body: `${requestData.senderUsername} sent you a friend request!`,
              },
              sound: "default",
            },
          },
        },
      };

      console.log("[DEBUG] Payload being sent:", JSON.stringify(payload));

      // Send notification via Firebase Admin
      await admin.messaging().send({
        token: userData.fcmToken,
        notification: payload.notification,
        data: payload.data,
      });

      console.log("[DEBUG] Friend request notification sent successfully to", userId);
    } catch (error) {
      console.error("Error in sendFriendRequestNotification:", error);
    }
  }
);