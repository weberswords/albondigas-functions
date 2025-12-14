const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;
  const storage = admin.storage();

  // Grace period in days (messages kept for expirationDays + grace period)
  const GRACE_PERIOD_DAYS = 2;

  /**
   * Cleanup messages in chats that have exceeded their expiration + grace period
   * This targets chats with expirationDays set, deleting messages older than
   * (now - expirationDays - gracePeriod)
   */
  async function performChatMessagesCleanup(options = {}) {
    const {
      batchSize = 500,
      dryRun = false,
      triggeredBy = 'system'
    } = options;

    console.log(`🧹 Starting chat messages cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

    const now = admin.firestore.Timestamp.now();
    let totalMessagesDeleted = 0;
    let totalChatsProcessed = 0;
    let totalErrors = 0;
    let totalSize = 0;
    const startTime = Date.now();

    try {
      // Query all chats that have expirationDays set (greater than 0)
      const chatsWithExpiration = await db.collection('chats')
        .where('expirationDays', '>', 0)
        .get();

      if (chatsWithExpiration.empty) {
        console.log('📭 No chats with expiration settings found');
        return {
          success: true,
          messagesDeleted: 0,
          chatsProcessed: 0,
          errors: 0,
          dryRun: dryRun,
          triggeredBy: triggeredBy
        };
      }

      console.log(`📋 Found ${chatsWithExpiration.size} chats with expiration settings`);

      // Process each chat
      for (const chatDoc of chatsWithExpiration.docs) {
        const chatData = chatDoc.data();
        const chatId = chatDoc.id;
        const expirationDays = chatData.expirationDays;

        // Calculate cutoff date: now - expirationDays - grace period
        const totalDays = expirationDays + GRACE_PERIOD_DAYS;
        const cutoffDate = new Date(now.toDate().getTime() - (totalDays * 24 * 60 * 60 * 1000));
        const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoffDate);

        console.log(`📂 Processing chat ${chatId} (expiration: ${expirationDays} days, cutoff: ${cutoffDate.toISOString()})`);

        // Query messages older than the cutoff date
        let hasMore = true;
        let messagesInChat = 0;

        while (hasMore) {
          const expiredMessagesQuery = await db.collection('chats')
            .doc(chatId)
            .collection('messages')
            .where('createdAt', '<', cutoffTimestamp)
            .limit(batchSize)
            .get();

          if (expiredMessagesQuery.empty) {
            hasMore = false;
            break;
          }

          const batch = db.batch();
          const storageDeletePromises = [];

          for (const messageDoc of expiredMessagesQuery.docs) {
            const messageData = messageDoc.data();

            if (dryRun) {
              totalMessagesDeleted++;
              messagesInChat++;
              continue;
            }

            // Collect all URLs for storage deletion
            const urlsToDelete = [
              messageData.videoUrl,
              messageData.thumbnailUrl,
              messageData.encryptedVideoUrl,
              messageData.encryptedThumbnailUrl,
              messageData.storagePath
            ].filter(Boolean);

            for (const url of urlsToDelete) {
              const path = url.startsWith('http') ? extractStoragePath(url) : url;
              if (path) {
                storageDeletePromises.push(
                  deleteFromStorage(path)
                    .then(size => {
                      totalSize += size || 0;
                    })
                    .catch(error => {
                      if (error.code !== 404) {
                        console.error(`❌ Failed to delete: ${path}`, error.message);
                        totalErrors++;
                      }
                    })
                );
              }
            }

            // Hard delete the message document
            batch.delete(messageDoc.ref);
            totalMessagesDeleted++;
            messagesInChat++;
          }

          if (!dryRun) {
            // Delete from storage first
            await Promise.all(storageDeletePromises);
            // Then delete Firestore docs
            await batch.commit();
          }

          // If we got fewer than batchSize, we're done with this chat
          if (expiredMessagesQuery.size < batchSize) {
            hasMore = false;
          }
        }

        if (messagesInChat > 0) {
          console.log(`  ✅ ${dryRun ? 'Would delete' : 'Deleted'} ${messagesInChat} messages from chat ${chatId}`);
          totalChatsProcessed++;
        }
      }

      const duration = Date.now() - startTime;

      const results = {
        success: true,
        messagesDeleted: totalMessagesDeleted,
        chatsProcessed: totalChatsProcessed,
        errors: totalErrors,
        totalSizeFreed: totalSize,
        totalSizeFreedMB: Math.round(totalSize / 1024 / 1024),
        duration: duration,
        dryRun: dryRun,
        triggeredBy: triggeredBy,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      if (!dryRun && totalMessagesDeleted > 0) {
        await db.collection('systemLogs')
          .doc('chatMessagesCleanup')
          .collection('runs')
          .add(results);
      }

      console.log(`🎉 Chat messages cleanup complete!`);
      console.log(`📊 Results: ${totalMessagesDeleted} messages ${dryRun ? 'would be' : ''} deleted from ${totalChatsProcessed} chats`);
      console.log(`💾 ${dryRun ? 'Would free' : 'Freed'} ${Math.round(totalSize / 1024 / 1024)} MB`);
      console.log(`⏱️ Duration: ${duration}ms`);

      return results;

    } catch (error) {
      console.error('❌ Chat messages cleanup failed:', error);

      await db.collection('systemLogs')
        .doc('chatMessagesCleanup')
        .collection('errors')
        .add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          error: error.message,
          stack: error.stack,
          triggeredBy: triggeredBy
        });

      throw error;
    }
  }

  // Helper function to delete from storage
  async function deleteFromStorage(path) {
    try {
      const bucket = storage.bucket();
      const file = bucket.file(path);

      // Get file metadata for size tracking
      const [metadata] = await file.getMetadata();
      const size = parseInt(metadata.size) || 0;

      // Delete the file
      await file.delete();

      return size;
    } catch (error) {
      if (error.code === 404) {
        // File already deleted, not an error
        return 0;
      }
      throw error;
    }
  }

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

  // Helper to calculate next scheduled run (at 4am)
  function getNextScheduledRun() {
    const now = new Date();
    const next = new Date(now);

    // Set to 4 AM
    next.setHours(4, 0, 0, 0);

    // If it's already past 4 AM today, move to tomorrow
    if (now.getHours() >= 4) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  return {
    // Scheduled function - runs daily at 4am (after video cleanup jobs)
    cleanupExpiredChatMessages: onSchedule({
      schedule: '0 4 * * *',
      timeZone: 'America/Los_Angeles',
      region: 'us-central1',
      maxInstances: 1,
      memory: '512MB',
      timeoutSeconds: 540
    }, async (event) => {
      return performChatMessagesCleanup({
        triggeredBy: 'scheduled',
        batchSize: 500
      });
    }),

    // Manual trigger for admins
    manualChatMessagesCleanup: onCall({
      region: 'us-central1',
      maxInstances: 1,
      timeoutSeconds: 540
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { dryRun = false, batchSize = 100 } = request.data || {};

      console.log(`🔧 Manual chat messages cleanup triggered by ${request.auth.uid}`);

      // Admin check
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      try {
        const results = await performChatMessagesCleanup({
          triggeredBy: `user:${request.auth.uid}`,
          dryRun: dryRun,
          batchSize: batchSize
        });

        return results;
      } catch (error) {
        console.error('Manual chat cleanup error:', error);
        throw new HttpsError('internal', error.message);
      }
    }),

    // Get cleanup stats
    getChatCleanupStats: onCall({
      region: 'us-central1',
      maxInstances: 10
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      try {
        // Get chats with expiration settings
        const chatsWithExpiration = await db.collection('chats')
          .where('expirationDays', '>', 0)
          .get();

        let totalPendingMessages = 0;
        const now = admin.firestore.Timestamp.now();

        // Count pending messages for each chat
        for (const chatDoc of chatsWithExpiration.docs) {
          const chatData = chatDoc.data();
          const expirationDays = chatData.expirationDays;
          const totalDays = expirationDays + GRACE_PERIOD_DAYS;
          const cutoffDate = new Date(now.toDate().getTime() - (totalDays * 24 * 60 * 60 * 1000));
          const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoffDate);

          const countQuery = await db.collection('chats')
            .doc(chatDoc.id)
            .collection('messages')
            .where('createdAt', '<', cutoffTimestamp)
            .count()
            .get();

          totalPendingMessages += countQuery.data().count;
        }

        // Get last cleanup run
        const lastRunQuery = await db.collection('systemLogs')
          .doc('chatMessagesCleanup')
          .collection('runs')
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();

        const lastRun = lastRunQuery.empty ? null : lastRunQuery.docs[0].data();

        return {
          chatsWithExpiration: chatsWithExpiration.size,
          pendingMessagesCleanup: totalPendingMessages,
          gracePeriodDays: GRACE_PERIOD_DAYS,
          lastRun: lastRun,
          nextScheduledRun: getNextScheduledRun()
        };
      } catch (error) {
        console.error('Error getting chat cleanup stats:', error);
        throw new HttpsError('internal', error.message);
      }
    })
  };
};
