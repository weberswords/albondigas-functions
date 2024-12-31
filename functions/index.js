/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const {onDocumentCreated} = require("firebase-functions/v2/firestore"); // Import Firestore triggers from v2
const {getFirestore} = require("firebase-admin/firestore"); // Import Firestore admin
const {getMessaging} = require("firebase-admin/messaging"); // Import FCM admin
const admin = require("firebase-admin");

var serviceAccount = require("firebase_admin.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = getFirestore(); // Use Firestore admin instance

const messaging = admin.messaging()

const sendNotification = async (fcmToken, payload) => {
  try {
      console.log("[DEBUG] Sending notification to FCM Token:", fcmToken);
      console.log("[DEBUG] Notification Payload:", payload);

      const response = await messaging.sendToDevice(fcmToken, payload, { priority: "high" });
      console.log("[DEBUG] Notification sent successfully. Response:", response);
      return response;
  } catch (error) {
      console.error("[ERROR] Failed to send notification:", error);
      throw new functions.https.HttpsError("internal", "Failed to send notification", error.message);
  }
};

exports.sendChatMessageNotification = functions.firestore
    .document("chats/{chatId}/messages/{messageId}")
    .onCreate(async (snap, context) => {
        const { senderId, text } = snap.data();
        const chatId = context.params.chatId;

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
                },
            };

            await sendNotification(tokens, payload);
        } catch (error) {
            console.error("Error sending chat message notification:", error);
        }
    });

    exports.notifyFriendRequest = functions.firestore
    .document("users/{userId}/friendRequests/{requestId}")
    .onCreate(async (snap, context) => {
        const { senderUsername, senderEmail } = snap.data();
        const userId = context.params.userId;

        try {
            const userDoc = await db.collection("users").doc(userId).get();
            if (!userDoc.exists) {
                console.log(`User document ${userId} not found.`);
                return;
            }

            const fcmToken = userDoc.data().fcmToken;
            if (!fcmToken) {
                console.log("[DEBUG] No FCM token for user:", userId);
                return;
            }

            const payload = {
                notification: {
                    title: "New Friend Request",
                    body: `${senderUsername} (${senderEmail}) sent you a friend request.`,
                },
            };

            await sendNotification([fcmToken], payload); // Reuse shared helper
        } catch (error) {
            console.error("Error sending friend request notification:", error);
        }
    });
    