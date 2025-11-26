const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

  async function deleteUserData(uid) {
    console.log(`🗑️ Deleting data for user ${uid}`);

    try {
      // Step 1: Get user's data for reference before deletion
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        console.log(`❓ User document not found for ${uid}`);
        return; // Nothing to delete
      }

      const userData = userDoc.data();
      const userDisplayName = userData.displayName || "Unknown User";

      // Step 2: Create a "deleted user" placeholder document
      console.log(`👤 Creating deleted user placeholder for ${uid}`);
      const deletedUserData = {
        isDeletedAccount: true,
        originalDisplayName: userDisplayName,
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('deletedUsers').doc(uid).set(deletedUserData);

      // Step 3: Update, not delete, friendships
      console.log(`🔗 Updating friendships for user ${uid}`);
      const friendshipQuery = await db.collection('friendships')
        .where('participants', 'array-contains', uid)
        .get();

      const friendshipBatch = db.batch();
      friendshipQuery.docs.forEach(doc => {
        // Mark as containing a deleted user rather than deleting
        friendshipBatch.update(doc.ref, {
          containsDeletedUser: true,
          deletedUserIds: admin.firestore.FieldValue.arrayUnion(uid)
        });
      });
      await friendshipBatch.commit();

      // Step 4: Update chats and handle messages
      console.log(`💬 Updating chats for user ${uid}`);
      const chatsQuery = await db.collection('chats')
        .where('participants', 'array-contains', uid)
        .get();

      for (const chatDoc of chatsQuery.docs) {
        const chatId = chatDoc.id;

        // Mark the chat as containing a deleted user
        await chatDoc.ref.update({
          containsDeletedUser: true,
          deletedUserIds: admin.firestore.FieldValue.arrayUnion(uid)
        });

        // Update messages sent by this user
        const messagesQuery = await db.collection('chats')
          .doc(chatId)
          .collection('messages')
          .where('senderId', '==', uid)
          .get();

        if (!messagesQuery.empty) {
          const messageBatch = db.batch();
          messagesQuery.docs.forEach(doc => {
            // Mark message as from deleted user and remove sensitive content
            messageBatch.update(doc.ref, {
              senderDeleted: true,
              // Maintain caption and timestamp but remove content links
              videoUrl: null,
              thumbnailUrl: null,
              contentRemoved: true
            });
          });
          await messageBatch.commit();
        }
      }

      // Step 5: Delete user's videos from Storage
      try {
        console.log(`🎬 Deleting videos for user ${uid}`);
        const storage = admin.storage();
        const bucket = storage.bucket();

        // Delete videos folder
        await bucket.deleteFiles({
          prefix: `videos/${uid}/`
        });

        // Delete thumbnails folder
        await bucket.deleteFiles({
          prefix: `thumbnails/${uid}/`
        });
      } catch (storageErr) {
        console.log(`⚠️ Storage deletion error: ${storageErr}`);
        // Continue even if storage deletion has issues
      }

      // Step 6: Delete notification settings and other user-specific data
      console.log(`🔔 Deleting user settings for ${uid}`);
      const notificationSettingsRef = db.collection('notificationSettings').doc(uid);
      await notificationSettingsRef.delete();

      // Step 7: Finally, delete the user document
      console.log(`👤 Deleting user document for ${uid}`);
      await db.collection('users').doc(uid).delete();

      console.log(`✅ Successfully processed deletion for user ${uid}`);
    } catch (error) {
      console.error(`❌ Error in deleteUserData: ${error}`);
      throw error;
    }
  }

  return {
    deleteAccountImmediately: onCall({
      region: 'us-central1',
      maxInstances: 10,
      timeoutSeconds: 300
    }, async (request) => {
      // Security check
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const uid = request.data.uid;

      // Verify user is deleting their own account
      if (uid !== request.auth.uid) {
        throw new HttpsError('permission-denied', 'You can only delete your own account');
      }

      console.log(`🗑️ Starting immediate account deletion for user ${uid}`);

      try {
        // Run all deletion processes
        await deleteUserData(uid);

        return { success: true };
      } catch (error) {
        console.error(`❌ Error during account deletion: ${error}`);

        // Return a more specific error message to the client
        let errorMessage = "Account deletion failed";

        if (error.message && error.message.includes("Bucket name not specified")) {
          errorMessage = "Storage configuration error - please contact support";
        } else if (error.code) {
          errorMessage = `${error.code}: ${error.message}`;
        } else {
          errorMessage = error.toString();
        }

        throw new HttpsError('internal', errorMessage);
      }
    }),

    scheduleAccountDeletion: onCall({
      region: 'us-central1',
      maxInstances: 10
    }, async (request) => {
      // Similar security checks as above

      const uid = request.data.uid;
      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 7); // 7 days from now

      try {
        // Mark account for deletion
        await db.collection('users').doc(uid).update({
          scheduledForDeletion: true,
          deletionDate: admin.firestore.Timestamp.fromDate(deletionDate)
        });

        return { success: true, deletionDate };
      } catch (error) {
        console.error(`❌ Error scheduling account deletion: ${error}`);
        throw new HttpsError('internal', error.message);
      }
    })
  };
};