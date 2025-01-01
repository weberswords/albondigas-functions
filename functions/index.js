const admin = require('firebase-admin');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const serviceAccount = require('./firebase_admin.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

exports.sendChatMessageNotification = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const chatId = event.params.chatId;

    try {
      // Retrieve triggered document directly
      const triggeredDoc = await db
        .collection("chats")
        .doc(chatId)
        .collection("messages")
        .doc(event.params.messageId)
        .get();

      const triggeredData = triggeredDoc.data();
      console.log("[DEBUG] Triggered document data:", triggeredData);

      const senderId = triggeredData?.senderId; // Extract senderId explicitly
      const text = triggeredData?.text;

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
          
          const friendDoc = await db
          .collection("users")
          .doc(userId)
          .collection("friends")
          .doc(senderId)
          .get();

          const lastViewedTimestamp = friendDoc.data()?.lastViewedTimestamp;

          if (!lastViewedTimestamp) {
            console.log(`[DEBUG] No lastViewedTimestamp found for user ${userId}`)
            unreadCounts[userId] = 0
            continue;
          }

          const unreadMessages = await db
          .collection("chats")
          .doc(chatId)
          .collection("messages")
          .where("timestamp", ">", lastViewedTimestamp)
          .get();

          unreadCounts[userId] = unreadMessages.size;
        }
      }

      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.data();

      console.log("Total badge count: ", totalBadgeCount.toString())
      
      if (userData && userData.notifyImmediately && userData.fcmToken) {
        tokens.push(userData.fcmToken);
      }

      if (tokens.length === 0) {
        console.log("[DEBUG] No valid FCM tokens found for chat message notification.");
        return;
      }

      const totalBadgeCount = Object.values(unreadCounts)
      .filter((count) => typeof count === "number")
      .reduce((a, b) => a + b, 0);
    
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
