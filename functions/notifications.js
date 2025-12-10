// functions/src/notifications.js
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

  return {
    sendChatMessageNotification: onDocumentCreated({
      region: 'us-central1',
      document: 'chats/{chatId}/messages/{messageId}'
    }, async (event) => {
      const messageData = event.data.data();
      const chatId = event.params.chatId;
      const messageId = event.params.messageId;

      // Get the sender and chat info
      const senderId = messageData.senderId;

      try {
        // Get chat participants
        const chatDoc = await db.collection('chats').doc(chatId).get();
        if (!chatDoc.exists) {
          console.log('Chat not found:', chatId);
          return;
        }

        const participants = chatDoc.data().participants || [];

        // Get sender's name
        const senderDoc = await db.collection('users').doc(senderId).get();
        const senderName = senderDoc.exists ? senderDoc.data().displayName : 'Someone';

        // For each participant (except sender)
        for (const userId of participants) {
          if (userId === senderId) continue;

          // Check if user wants notifications
          const userDoc = await db.collection('users').doc(userId).get();
          if (!userDoc.exists) continue;

          const userData = userDoc.data();
          if (!userData.notifyImmediately || !userData.notifyForNewMessages || !userData.fcmToken) continue;

          // Prepare notification
          const message = {
            token: userData.fcmToken,
            notification: {
              title: `New message from ${senderName}`,
              body: messageData.caption || "Sent you a message"
            },
            data: {
              chatId: chatId,
              messageId: messageId,
              senderId: senderId,
              type: "newMessage"
            },
            apns: {
              payload: {
                aps: {
                  alert: {
                    title: `New message from ${senderName}`,
                    body: messageData.caption || "Sent you a message"
                  },
                  badge: 1,
                  sound: userData.soundEnabled !== false ? "default" : "none"
                }
              }
            }
          };

          // Send notification
          await admin.messaging().send(message);
          console.log('Notification sent to:', userId);
        }
      } catch (error) {
        console.error('Error sending notification:', error);
      }
    }),

    // Send notification for friend requests
    sendFriendRequestNotification: onDocumentCreated({
      region: 'us-central1',
      document: 'userFriendships/{userId}/friends/{friendId}'
    },
      async (event) => {
        const userId = event.params.userId;
        const friendId = event.params.friendId;
        const data = event.data.data();

        // Only send for pending requests where user is recipient
        if (data.status !== 'pending' || data.role !== 'recipient') {
          return;
        }

        try {

          // Get recipient user
          const userDoc = await db.collection('users').doc(userId).get();
          if (!userDoc.exists) return;

          const userData = userDoc.data();
          if (!userData.fcmToken || userData.notifyImmediately === false || userData.notifyForFriendRequests === false) return;

          // Get sender name
          const senderDoc = await db.collection('users').doc(friendId).get();
          const senderName = senderDoc.exists ? senderDoc.data().displayName : 'Someone';

          // Prepare notification
          const message = {
            token: userData.fcmToken,
            notification: {
              title: 'New Friend Request',
              body: `${senderName} wants to connect with you`
            },
            data: {
              type: 'friendRequest', // Changed to match Swift
              senderId: friendId
            },
            apns: {
              payload: {
                aps: {
                  badge: 1,
                  sound: userData.soundEnabled !== false ? 'default' : 'none'
                }
              }
            }
          };

          // Send notification
          await admin.messaging().send(message);
          console.log('Friend request notification sent to:', userId);
        } catch (error) {
          console.error('Error sending friend request notification:', error);
        }
      }),

    // Send notification for encryption nudges (remind friend to open chat)
    sendEncryptionNudgeNotification: onDocumentCreated({
      region: 'us-central1',
      document: 'nudges/{nudgeId}'
    }, async (event) => {
      const nudgeId = event.params.nudgeId;
      const nudge = event.data.data();

      console.log('📨 Processing nudge:', nudgeId, 'type:', nudge.type);

      // Only process encryption nudges
      if (nudge.type !== 'encryptionNudge') {
        console.log('⏭️ Skipping non-encryptionNudge type:', nudge.type);
        return;
      }

      const { fromUserId, fromUserName, toUserId, chatId } = nudge;

      // Validate required fields
      if (!fromUserId || !toUserId || !chatId) {
        console.error('❌ Missing required fields in nudge:', { fromUserId, toUserId, chatId });
        // Delete invalid nudge
        await db.collection('nudges').doc(nudgeId).delete();
        return;
      }

      try {
        // Rate limiting: Check if a nudge was sent for this chat in the last hour
        const rateLimitDoc = await db.collection('nudgeRateLimits').doc(chatId).get();

        if (rateLimitDoc.exists) {
          const lastNudgeAt = rateLimitDoc.data().lastNudgeAt;
          if (lastNudgeAt) {
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            const lastNudgeTime = lastNudgeAt.toMillis ? lastNudgeAt.toMillis() : lastNudgeAt;

            if (lastNudgeTime > oneHourAgo) {
              console.log('⏱️ Rate limited: nudge already sent for chat', chatId, 'within the last hour');
              // Delete the nudge document without sending
              await db.collection('nudges').doc(nudgeId).delete();
              return;
            }
          }
        }

        // Get recipient's FCM token and notification preferences
        const recipientDoc = await db.collection('users').doc(toUserId).get();

        if (!recipientDoc.exists) {
          console.log('❌ Recipient user not found:', toUserId);
          await db.collection('nudges').doc(nudgeId).delete();
          return;
        }

        const recipientData = recipientDoc.data();

        // Check if user has notifications enabled and has FCM token
        if (!recipientData.fcmToken) {
          console.log('⏭️ Recipient has no FCM token:', toUserId);
          await db.collection('nudges').doc(nudgeId).delete();
          return;
        }

        if (recipientData.notifyImmediately === false) {
          console.log('⏭️ Recipient has notifications disabled:', toUserId);
          await db.collection('nudges').doc(nudgeId).delete();
          return;
        }

        // Get sender's display name if not provided
        const senderName = fromUserName || 'Your friend';

        // Prepare notification payload
        const message = {
          token: recipientData.fcmToken,
          notification: {
            title: `${senderName} needs you!`,
            body: 'Open your chat to fix video issues'
          },
          data: {
            type: 'encryptionNudge',
            chatId: chatId,
            fromUserId: fromUserId,
            fromUserName: senderName
          },
          apns: {
            payload: {
              aps: {
                alert: {
                  title: `${senderName} needs you!`,
                  body: 'Open your chat to fix video issues'
                },
                badge: 1,
                sound: recipientData.soundEnabled !== false ? 'default' : 'none'
              }
            }
          }
        };

        // Send notification
        await admin.messaging().send(message);
        console.log('✅ Encryption nudge notification sent to:', toUserId);

        // Update rate limit timestamp
        await db.collection('nudgeRateLimits').doc(chatId).set({
          lastNudgeAt: admin.firestore.FieldValue.serverTimestamp(),
          lastFromUserId: fromUserId,
          lastToUserId: toUserId
        }, { merge: true });

        // Delete the processed nudge document
        await db.collection('nudges').doc(nudgeId).delete();
        console.log('🗑️ Nudge document deleted:', nudgeId);

      } catch (error) {
        console.error('❌ Error processing encryption nudge:', error);

        // If it's an FCM token error, still delete the nudge
        if (error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token') {
          console.log('🗑️ Deleting nudge due to invalid FCM token');
          await db.collection('nudges').doc(nudgeId).delete();
        }
        // For other errors, leave the nudge for potential retry or manual cleanup
      }
    })
  }
}