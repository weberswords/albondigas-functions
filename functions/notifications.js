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
  document: 'userFriendships/{userId}/friends/{friendId}'},
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
  })
}
}