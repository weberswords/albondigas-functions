/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const {onDocumentCreated} = require("firebase-functions/v2/firestore"); // Import Firestore triggers from v2
const {getFirestore} = require("firebase-admin/firestore"); // Import Firestore admin
const {getMessaging} = require("firebase-admin/messaging"); // Import FCM admin
const admin = require("firebase-admin");

admin.initializeApp(); // Initialize Admin SDK once at the top
const db = getFirestore(); // Use Firestore admin instance

// Utility to send notifications
async function sendNotification(tokens, payload) {
  if (tokens.length > 0) {
    try {
      const response = await getMessaging().sendMulticast({
        tokens: tokens,
        notification: payload.notification,
        data: payload.data || {},
      });
      console.log(`Notifications sent successfully: ${response.successCount}`);
    } catch (error) {
      console.error("Error sending notifications:", error);
    }
  } else {
    console.log("No valid tokens found for sending notifications.");
  }
}

// Chat Message Notification
exports.sendChatMessageNotification = onDocumentCreated("chats/{chatId}/messages/{messageId}", async (event) => {
  const {senderId, text} = event.data;
  const chatId = event.params.chatId;

  try {
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists) {
      console.log(`Chat document ${chatId} not found.`);
      return;
    }

    const participants = chatDoc.data().participants || [];
    const tokens = [];

    for (const userId of participants) {
      if (userId !== senderId) {
        const userDoc = await db.collection("users").doc(userId).get();
        const userData = userDoc.data();
        if (userData && userData.notifyImmediately && userData.fcmToken) {
          tokens.push(userData.fcmToken);
      }
      
      }
    }

    const payload = {
      notification: {
        title: "New Message",
        body: text || "You have a new message",
      },
      data: {
        chatId: chatId,
        senderId: senderId
      }
    };
    await sendNotification(tokens, payload);
  } catch (error) {
    console.error("Error sending chat message notification:", error);
  }
});

// Friend Request Notification
exports.notifyFriendRequest = onDocumentCreated("users/{userId}/friendRequests/{requestId}", async (event) => {
  const {senderUsername, senderEmail} = event.data;
  const userId = event.params.userId;

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      console.log(`User document ${userId} not found.`);
      return;
    }

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      console.log("No FCM token for user:", userId);
      return;
    }

    const payload = {
      notification: {
        title: "New Friend Request",
        body: `${senderUsername} (${senderEmail}) sent you a friend request.`,
      },
    };

    await getMessaging().sendToDevice(fcmToken, payload);
    console.log("Friend request notification sent to:", userId);
  } catch (error) {
    console.error("Error sending friend request notification:", error);
  }
});
