const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;

  /**
   * Helper to delete all documents in a subcollection
   */
  async function deleteSubcollection(docRef, subcollectionName) {
    const subcollectionRef = docRef.collection(subcollectionName);
    const snapshot = await subcollectionRef.limit(500).get();

    if (snapshot.empty) return 0;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // If there were 500 docs, there might be more
    if (snapshot.size === 500) {
      return 500 + await deleteSubcollection(docRef, subcollectionName);
    }

    return snapshot.size;
  }

  /**
   * Comprehensive user data deletion
   * Deletes all user data across Firestore collections and Storage
   */
  async function deleteUserData(uid, options = {}) {
    const { deleteAuthUser = true } = options;

    console.log(`🗑️ Starting comprehensive data deletion for user ${uid}`);

    const results = {
      uid,
      friendshipsUpdated: 0,
      chatsUpdated: 0,
      messagesUpdated: 0,
      userFriendshipsDeleted: 0,
      subcollectionsDeleted: 0,
      storageDeleted: [],
      errors: []
    };

    try {
      // Step 1: Get user's data for reference before deletion
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        console.log(`❓ User document not found for ${uid}`);
        return results;
      }

      const userData = userDoc.data();
      const userDisplayName = userData.displayName || "Unknown User";

      // Step 2: Create a "deleted user" placeholder document
      console.log(`👤 Creating deleted user placeholder for ${uid}`);
      await db.collection('deletedUsers').doc(uid).set({
        isDeletedAccount: true,
        originalDisplayName: userDisplayName,
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Step 3: Update friendships (mark as containing deleted user)
      console.log(`🔗 Updating friendships for user ${uid}`);
      const friendshipQuery = await db.collection('friendships')
        .where('userIds', 'array-contains', uid)
        .get();

      if (!friendshipQuery.empty) {
        const friendshipBatch = db.batch();
        friendshipQuery.docs.forEach(doc => {
          friendshipBatch.update(doc.ref, {
            containsDeletedUser: true,
            deletedUserIds: admin.firestore.FieldValue.arrayUnion(uid)
          });
        });
        await friendshipBatch.commit();
        results.friendshipsUpdated = friendshipQuery.size;
      }

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
        results.chatsUpdated++;

        // Update messages sent by this user (batch in groups of 500)
        let hasMore = true;
        while (hasMore) {
          const messagesQuery = await db.collection('chats')
            .doc(chatId)
            .collection('messages')
            .where('senderId', '==', uid)
            .where('senderDeleted', '!=', true)
            .limit(500)
            .get();

          if (messagesQuery.empty) {
            hasMore = false;
            break;
          }

          const messageBatch = db.batch();
          messagesQuery.docs.forEach(doc => {
            messageBatch.update(doc.ref, {
              senderDeleted: true,
              videoUrl: null,
              thumbnailUrl: null,
              encryptedVideoUrl: null,
              encryptedThumbnailUrl: null,
              contentRemoved: true,
              contentRemovedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });
          await messageBatch.commit();
          results.messagesUpdated += messagesQuery.size;

          if (messagesQuery.size < 500) {
            hasMore = false;
          }
        }
      }

      // Step 5: Delete userFriendships subcollection for this user
      console.log(`👥 Deleting userFriendships for ${uid}`);
      const userFriendshipsRef = db.collection('userFriendships').doc(uid);
      results.userFriendshipsDeleted = await deleteSubcollection(userFriendshipsRef, 'friends');
      await userFriendshipsRef.delete();

      // Step 6: Delete user subcollections (security, pendingDeviceVerifications)
      console.log(`🔐 Deleting user subcollections for ${uid}`);
      const userRef = db.collection('users').doc(uid);
      results.subcollectionsDeleted += await deleteSubcollection(userRef, 'security');
      results.subcollectionsDeleted += await deleteSubcollection(userRef, 'pendingDeviceVerifications');

      // Step 7: Delete temporary codes
      console.log(`🔑 Deleting verification and reset codes for ${uid}`);
      await db.collection('verificationCodes').doc(uid).delete().catch(() => {});
      await db.collection('passwordResetCodes').doc(uid).delete().catch(() => {});

      // Step 8: Delete user's files from Storage
      console.log(`🎬 Deleting storage files for user ${uid}`);
      try {
        const storage = admin.storage();
        const bucket = storage.bucket();

        // Delete videos folder
        await bucket.deleteFiles({ prefix: `videos/${uid}/` });
        results.storageDeleted.push(`videos/${uid}/`);

        // Delete thumbnails folder
        await bucket.deleteFiles({ prefix: `thumbnails/${uid}/` });
        results.storageDeleted.push(`thumbnails/${uid}/`);

        // Delete avatars folder
        await bucket.deleteFiles({ prefix: `users/${uid}/avatars/` });
        results.storageDeleted.push(`users/${uid}/avatars/`);

      } catch (storageErr) {
        console.log(`⚠️ Storage deletion error: ${storageErr.message}`);
        results.errors.push(`Storage: ${storageErr.message}`);
      }

      // Step 9: Delete notification settings
      console.log(`🔔 Deleting notification settings for ${uid}`);
      await db.collection('notificationSettings').doc(uid).delete().catch(() => {});

      // Step 10: Delete the user document
      console.log(`👤 Deleting user document for ${uid}`);
      await db.collection('users').doc(uid).delete();

      // Step 11: Delete Firebase Auth user (if requested)
      if (deleteAuthUser) {
        console.log(`🔐 Deleting Firebase Auth user for ${uid}`);
        try {
          await admin.auth().deleteUser(uid);
        } catch (authErr) {
          // User might already be deleted or not exist
          if (authErr.code !== 'auth/user-not-found') {
            console.log(`⚠️ Auth deletion error: ${authErr.message}`);
            results.errors.push(`Auth: ${authErr.message}`);
          }
        }
      }

      console.log(`✅ Successfully deleted data for user ${uid}`);
      console.log(`📊 Results: ${JSON.stringify(results)}`);

      return results;

    } catch (error) {
      console.error(`❌ Error in deleteUserData: ${error}`);
      results.errors.push(error.message);
      throw error;
    }
  }

  return {
    // Export deleteUserData for use by other modules (e.g., inactive.js)
    deleteUserData,

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
        const results = await deleteUserData(uid);
        return { success: true, ...results };
      } catch (error) {
        console.error(`❌ Error during account deletion: ${error}`);

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
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const uid = request.data.uid;

      // Verify user is scheduling their own deletion
      if (uid !== request.auth.uid) {
        throw new HttpsError('permission-denied', 'You can only schedule your own account for deletion');
      }

      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 7); // 7 days from now

      try {
        await db.collection('users').doc(uid).update({
          scheduledForDeletion: true,
          deletionDate: admin.firestore.Timestamp.fromDate(deletionDate),
          scheduledByUser: true // User-initiated, not inactivity
        });

        return { success: true, deletionDate };
      } catch (error) {
        console.error(`❌ Error scheduling account deletion: ${error}`);
        throw new HttpsError('internal', error.message);
      }
    })
  };
};