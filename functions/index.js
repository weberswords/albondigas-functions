const admin = require('firebase-admin');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const serviceAccount = require('./firebase_admin.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

exports.sendChatMessageNotification = onDocumentCreated(
  'chats/{chatId}/messages/{messageId}',
  async (event) => {
    const chatId = event.params.chatId;
    const senderId = event.params.senderId
    const text = event.params.text

    try {
      const chatDoc = await db.collection('chats').doc(chatId).get();
      if (!chatDoc.exists) {
        console.log(`Chat document ${chatId} not found.`);
        return;
      }

      const participants = chatDoc.data().participants || [];
      const tokens = [];

      for (const userId of participants) {
        if (userId !== senderId) {
          const userDoc = await db.collection('users').doc(userId).get();
          const userData = userDoc.data();
          if (userData && userData.notifyImmediately && userData.fcmToken) {
            tokens.push(userData.fcmToken);
          }
        }
      }

      if (tokens.length === 0) {
        console.log('[DEBUG] No valid FCM tokens found for chat message notification.');
        return;
      }

      const payload = {
        notification: {
          title: 'New Message',
          body: text || 'You have a new message',
        },
        data: {
          chatId: chatId,
          senderId: senderId,
        },
      };

      console.log("[DEBUG] Payload being sent:", {
        notification: payload.notification,
        data: payload.data,
    });
    
      await admin.messaging().sendEachForMulticast({
        tokens: tokens,
        notification: payload.notification,
        data: payload.data,
      });

      console.log('[DEBUG] Chat message notifications sent successfully');
    } catch (error) {
      console.error('Error in sendChatMessageNotification:', error);
    }
  }
);
