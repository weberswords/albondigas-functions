const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
  const { admin, db } = firebaseHelper;
  const storage = admin.storage();
  
  // Shared cleanup logic extracted into its own function
  async function performVideoCleanup(options = {}) {
    // Default options
    const {
      batchSize = 500,
      dryRun = false,
      triggeredBy = 'system'
    } = options;
    
    console.log(`🧹 Starting video cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);
    
    const now = admin.firestore.Timestamp.now();
    let totalDeleted = 0;
    let totalErrors = 0;
    let totalSize = 0;
    const startTime = Date.now();
    
    try {
      // Query all messages with expired videos
      const expiredMessagesQuery = db.collectionGroup('messages')
        .where('expiresAt', '<=', now)
        .where('contentRemoved', '!=', true)
        .limit(batchSize);
      
      let hasMore = true;
      let batchCount = 0;
      
      while (hasMore) {
        const snapshot = await expiredMessagesQuery.get();
        
        if (snapshot.empty) {
          hasMore = false;
          break;
        }
        
        batchCount++;
        console.log(`📦 Processing batch ${batchCount} of ${snapshot.size} expired videos...`);
        
        // Process each expired message
        const batch = db.batch();
        const storageDeletePromises = [];
        
        for (const doc of snapshot.docs) {
          const messageData = doc.data();
          const messageRef = doc.ref;
          
          // If dry run, just count without actually deleting
          if (dryRun) {
            totalDeleted++;
            continue;
          }
          
          // Mark as content removed in batch
          batch.update(messageRef, {
            contentRemoved: true,
            contentRemovedAt: admin.firestore.FieldValue.serverTimestamp(),
            videoUrl: null,
            thumbnailUrl: null,
            cleanupTriggeredBy: triggeredBy
          });
          
          // Delete from storage (if paths exist)
          if (messageData.storagePath) {
            storageDeletePromises.push(
              deleteFromStorage(messageData.storagePath)
                .then(size => {
                  totalDeleted++;
                  totalSize += size || 0;
                })
                .catch(error => {
                  console.error(`❌ Failed to delete video: ${messageData.storagePath}`, error);
                  totalErrors++;
                })
            );
          }
          
          // Delete thumbnail
          if (messageData.thumbnailUrl) {
            const thumbnailPath = extractStoragePath(messageData.thumbnailUrl);
            if (thumbnailPath) {
              storageDeletePromises.push(
                deleteFromStorage(thumbnailPath)
                  .catch(error => {
                    console.error(`❌ Failed to delete thumbnail: ${thumbnailPath}`, error);
                  })
              );
            }
          }
        }
        
        // Only commit if not a dry run
        if (!dryRun) {
          await batch.commit();
          await Promise.all(storageDeletePromises);
        }
        
        console.log(`✅ Batch ${batchCount} complete. Deleted: ${totalDeleted}, Errors: ${totalErrors}`);
        
        // Check if we need to continue
        if (snapshot.size < batchSize) {
          hasMore = false;
        }
      }
      
      const duration = Date.now() - startTime;
      
      // Prepare results
      const results = {
        success: true,
        videosDeleted: totalDeleted,
        errors: totalErrors,
        totalSizeFreed: totalSize,
        totalSizeFreedMB: Math.round(totalSize / 1024 / 1024),
        duration: duration,
        dryRun: dryRun,
        triggeredBy: triggeredBy,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Log cleanup results (unless dry run)
      if (!dryRun) {
        await db.collection('systemLogs')
          .doc('videoCleanup')
          .collection('runs')
          .add(results);
      }
      
      console.log(`🎉 Video cleanup complete!`);
      console.log(`📊 Results: ${totalDeleted} videos ${dryRun ? 'would be' : ''} deleted, ${totalErrors} errors`);
      console.log(`💾 ${dryRun ? 'Would free' : 'Freed'} up ${Math.round(totalSize / 1024 / 1024)} MB`);
      console.log(`⏱️ Duration: ${duration}ms`);
      
      return results;
      
    } catch (error) {
      console.error('❌ Video cleanup failed:', error);
      
      // Log error
      await db.collection('systemLogs')
        .doc('videoCleanup')
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
        console.log(`⚠️ File already deleted: ${path}`);
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
  
  // Cleanup expired archived videos (from unfriend flow)
  // Archives videos are kept until their expiresAt date, then fully deleted
  async function performArchivedVideoCleanup(options = {}) {
    const {
      batchSize = 500,
      dryRun = false,
      triggeredBy = 'system'
    } = options;

    console.log(`🧹 Starting archived video cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

    const now = admin.firestore.Timestamp.now();
    let totalDeleted = 0;
    let totalErrors = 0;
    let totalSize = 0;
    const startTime = Date.now();

    try {
      // Query all archived videos where expiresAt <= now
      const expiredArchivedQuery = db.collectionGroup('messages')
        .where('isArchived', '==', true)
        .where('expiresAt', '<=', now)
        .limit(batchSize);

      let hasMore = true;
      let batchCount = 0;

      while (hasMore) {
        const snapshot = await expiredArchivedQuery.get();

        if (snapshot.empty) {
          hasMore = false;
          break;
        }

        batchCount++;
        console.log(`📦 Processing batch ${batchCount} of ${snapshot.size} expired archived videos...`);

        const batch = db.batch();
        const storageDeletePromises = [];

        for (const doc of snapshot.docs) {
          const messageData = doc.data();

          if (dryRun) {
            totalDeleted++;
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
                    console.error(`❌ Failed to delete: ${path}`, error);
                    totalErrors++;
                  })
              );
            }
          }

          // Delete the Firestore document completely (not soft delete)
          batch.delete(doc.ref);
          totalDeleted++;
        }

        if (!dryRun) {
          // Delete from storage first
          await Promise.all(storageDeletePromises);
          // Then delete Firestore docs
          await batch.commit();
        }

        console.log(`✅ Batch ${batchCount} complete. Deleted: ${totalDeleted}, Errors: ${totalErrors}`);

        if (snapshot.size < batchSize) {
          hasMore = false;
        }
      }

      const duration = Date.now() - startTime;

      const results = {
        success: true,
        archivedVideosDeleted: totalDeleted,
        errors: totalErrors,
        totalSizeFreed: totalSize,
        totalSizeFreedMB: Math.round(totalSize / 1024 / 1024),
        duration: duration,
        dryRun: dryRun,
        triggeredBy: triggeredBy,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      if (!dryRun) {
        await db.collection('systemLogs')
          .doc('archivedVideoCleanup')
          .collection('runs')
          .add(results);
      }

      console.log(`🎉 Archived video cleanup complete!`);
      console.log(`📊 Results: ${totalDeleted} archived videos ${dryRun ? 'would be' : ''} deleted, ${totalErrors} errors`);
      console.log(`💾 ${dryRun ? 'Would free' : 'Freed'} up ${Math.round(totalSize / 1024 / 1024)} MB`);

      return results;

    } catch (error) {
      console.error('❌ Archived video cleanup failed:', error);

      await db.collection('systemLogs')
        .doc('archivedVideoCleanup')
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

  /**
   * Core logic for cleaning up orphaned chats (where both participants deleted accounts)
   */
  async function performOrphanedChatCleanup(options = {}) {
    const {
      batchSize = 50,
      dryRun = false,
      triggeredBy = 'system'
    } = options;

    console.log(`🧹 Starting orphaned chat cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

    let chatsDeleted = 0;
    let messagesDeleted = 0;
    let storageFilesDeleted = 0;
    let totalErrors = 0;
    const startTime = Date.now();
    const chatDetails = [];

    try {
      // Query chats that contain at least one deleted user
      const chatsQuery = await db.collection('chats')
        .where('containsDeletedUser', '==', true)
        .limit(batchSize)
        .get();

      if (chatsQuery.empty) {
        console.log('✅ No chats with deleted users to check.');
        return {
          success: true,
          chatsDeleted: 0,
          messagesDeleted: 0,
          storageFilesDeleted: 0,
          errors: 0,
          dryRun,
          triggeredBy,
          duration: Date.now() - startTime
        };
      }

      console.log(`📦 Checking ${chatsQuery.size} chats with deleted users...`);

      for (const chatDoc of chatsQuery.docs) {
        const chatData = chatDoc.data();
        const chatId = chatDoc.id;
        const participants = chatData.participants || [];

        // Check if ALL participants are deleted
        let allDeleted = true;
        for (const participantId of participants) {
          const userDoc = await db.collection('users').doc(participantId).get();
          if (userDoc.exists) {
            allDeleted = false;
            break;
          }
        }

        if (!allDeleted) {
          // At least one participant still exists, skip this chat
          continue;
        }

        // Both participants are deleted - clean up this chat
        console.log(`🔍 Found fully orphaned chat: ${chatId}`);

        if (dryRun) {
          // Count messages for dry run
          const messagesCount = await db.collection('chats')
            .doc(chatId)
            .collection('messages')
            .count()
            .get();

          chatDetails.push({
            chatId,
            action: 'would_delete',
            messageCount: messagesCount.data().count
          });
          chatsDeleted++;
          messagesDeleted += messagesCount.data().count;
        } else {
          // Delete all messages and their storage files
          let hasMoreMessages = true;
          let chatMessagesDeleted = 0;

          while (hasMoreMessages) {
            const messagesQuery = await db.collection('chats')
              .doc(chatId)
              .collection('messages')
              .limit(100)
              .get();

            if (messagesQuery.empty) {
              hasMoreMessages = false;
              break;
            }

            const messageBatch = db.batch();

            for (const msgDoc of messagesQuery.docs) {
              const msgData = msgDoc.data();

              // Delete storage files for this message
              const urlsToDelete = [
                msgData.videoUrl,
                msgData.thumbnailUrl,
                msgData.encryptedVideoUrl,
                msgData.encryptedThumbnailUrl,
                msgData.storagePath
              ].filter(Boolean);

              for (const url of urlsToDelete) {
                try {
                  const path = url.startsWith('http') ? extractStoragePath(url) : url;
                  if (path) {
                    await deleteFromStorage(path);
                    storageFilesDeleted++;
                  }
                } catch (err) {
                  console.log(`⚠️ Could not delete storage file: ${err.message}`);
                }
              }

              // Delete the message document
              messageBatch.delete(msgDoc.ref);
              chatMessagesDeleted++;
            }

            await messageBatch.commit();

            if (messagesQuery.size < 100) {
              hasMoreMessages = false;
            }
          }

          // Delete chat settings subcollection if it exists
          const settingsQuery = await db.collection('chats')
            .doc(chatId)
            .collection('settings')
            .limit(100)
            .get();

          if (!settingsQuery.empty) {
            const settingsBatch = db.batch();
            settingsQuery.docs.forEach(doc => settingsBatch.delete(doc.ref));
            await settingsBatch.commit();
          }

          // Delete the chat document
          await chatDoc.ref.delete();
          console.log(`🗑️ Deleted orphaned chat ${chatId} with ${chatMessagesDeleted} messages`);

          chatDetails.push({
            chatId,
            action: 'deleted',
            messagesDeleted: chatMessagesDeleted
          });
          chatsDeleted++;
          messagesDeleted += chatMessagesDeleted;
        }
      }

      const duration = Date.now() - startTime;

      const results = {
        success: true,
        chatsDeleted,
        messagesDeleted,
        storageFilesDeleted,
        errors: totalErrors,
        details: chatDetails,
        dryRun,
        triggeredBy,
        duration,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      if (!dryRun && chatsDeleted > 0) {
        await db.collection('systemLogs')
          .doc('orphanedChatCleanup')
          .collection('runs')
          .add(results);
      }

      console.log(`🎉 Orphaned chat cleanup complete!`);
      console.log(`📊 Results: ${chatsDeleted} chats, ${messagesDeleted} messages, ${storageFilesDeleted} files ${dryRun ? 'would be' : ''} deleted`);

      return results;

    } catch (error) {
      console.error('❌ Orphaned chat cleanup failed:', error);

      await db.collection('systemLogs')
        .doc('orphanedChatCleanup')
        .collection('errors')
        .add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          error: error.message,
          stack: error.stack,
          triggeredBy
        });

      throw error;
    }
  }

  // Return the public functions
  return {
    // Scheduled function for regular expired videos
    cleanupExpiredVideos: onSchedule({
      schedule: '0 2 * * *',
      timeZone: 'America/Los_Angeles',
      region: 'us-central1',
      maxInstances: 1,
      memory: '512MB',
      timeoutSeconds: 540
    }, async (event) => {
      return performVideoCleanup({
        triggeredBy: 'scheduled',
        batchSize: 500
      });
    }),

    // Scheduled function for expired archived videos (from unfriend)
    cleanupExpiredArchivedVideos: onSchedule({
      schedule: '0 3 * * *',  // Run at 3am, after regular cleanup
      timeZone: 'America/Los_Angeles',
      region: 'us-central1',
      maxInstances: 1,
      memory: '512MB',
      timeoutSeconds: 540
    }, async (event) => {
      return performArchivedVideoCleanup({
        triggeredBy: 'scheduled',
        batchSize: 500
      });
    }),
    
    // Manual trigger function for regular video cleanup
    manualVideoCleanup: onCall({
      region: 'us-central1',
      maxInstances: 1,
      timeoutSeconds: 540
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { dryRun = false, batchSize = 100 } = request.data || {};

      console.log(`🔧 Manual cleanup triggered by ${request.auth.uid}`);

      // Add admin check
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      try {
        const results = await performVideoCleanup({
          triggeredBy: `user:${request.auth.uid}`,
          dryRun: dryRun,
          batchSize: batchSize
        });

        return results;
      } catch (error) {
        console.error('Manual cleanup error:', error);
        throw new HttpsError('internal', error.message);
      }
    }),

    // Manual trigger function for archived video cleanup
    manualArchivedVideoCleanup: onCall({
      region: 'us-central1',
      maxInstances: 1,
      timeoutSeconds: 540
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const { dryRun = false, batchSize = 100 } = request.data || {};

      console.log(`🔧 Manual archived cleanup triggered by ${request.auth.uid}`);

      // Add admin check
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      try {
        const results = await performArchivedVideoCleanup({
          triggeredBy: `user:${request.auth.uid}`,
          dryRun: dryRun,
          batchSize: batchSize
        });

        return results;
      } catch (error) {
        console.error('Manual archived cleanup error:', error);
        throw new HttpsError('internal', error.message);
      }
    }),
    
    // Optional: Get cleanup stats
    getCleanupStats: onCall({
      region: 'us-central1',
      maxInstances: 10
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      try {
        const now = admin.firestore.Timestamp.now();

        // Get count of regular expired videos
        const expiredQuery = await db.collectionGroup('messages')
          .where('expiresAt', '<=', now)
          .where('contentRemoved', '!=', true)
          .count()
          .get();

        // Get count of expired archived videos
        const expiredArchivedQuery = await db.collectionGroup('messages')
          .where('isArchived', '==', true)
          .where('expiresAt', '<=', now)
          .count()
          .get();

        // Get total archived videos (not yet expired)
        const totalArchivedQuery = await db.collectionGroup('messages')
          .where('isArchived', '==', true)
          .count()
          .get();

        // Get last regular cleanup run info
        const lastRunQuery = await db.collection('systemLogs')
          .doc('videoCleanup')
          .collection('runs')
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();

        // Get last archived cleanup run info
        const lastArchivedRunQuery = await db.collection('systemLogs')
          .doc('archivedVideoCleanup')
          .collection('runs')
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();

        const lastRun = lastRunQuery.empty ? null : lastRunQuery.docs[0].data();
        const lastArchivedRun = lastArchivedRunQuery.empty ? null : lastArchivedRunQuery.docs[0].data();

        return {
          pendingCleanup: expiredQuery.data().count,
          pendingArchivedCleanup: expiredArchivedQuery.data().count,
          totalArchivedVideos: totalArchivedQuery.data().count,
          lastRun: lastRun,
          lastArchivedRun: lastArchivedRun,
          nextScheduledRun: getNextScheduledRun(),
          nextArchivedScheduledRun: getNextArchivedScheduledRun()
        };
      } catch (error) {
        console.error('Error getting cleanup stats:', error);
        throw new HttpsError('internal', error.message);
      }
    }),

    // Delete individual video message
    deleteVideo: onCall({
      region: 'us-central1',
      maxInstances: 10
    }, async (request) => {
      // 1. Verify authentication
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
      }

      const userId = request.auth.uid;
      const { messageId, chatId } = request.data || {};

      if (!messageId || !chatId) {
        throw new HttpsError('invalid-argument', 'messageId and chatId are required');
      }

      try {
        // 2. Fetch the message
        const messageRef = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
        const messageDoc = await messageRef.get();

        if (!messageDoc.exists) {
          throw new HttpsError('not-found', 'Message not found');
        }

        const messageData = messageDoc.data();

        // 3. Verify caller is the sender
        if (messageData.senderId !== userId) {
          throw new HttpsError('permission-denied', 'You can only delete your own videos');
        }

        // 4-6. Delete from Firebase Storage
        const urlsToDelete = [
          messageData.videoUrl,
          messageData.thumbnailUrl,
          messageData.encryptedVideoUrl,
          messageData.encryptedThumbnailUrl,
        ].filter(Boolean);

        const bucket = storage.bucket();

        for (const url of urlsToDelete) {
          try {
            const path = extractStoragePath(url);
            if (path) {
              await bucket.file(path).delete();
              console.log(`Deleted: ${path}`);
            }
          } catch (err) {
            // Log but don't fail - file may already be deleted
            if (err.code === 404) {
              console.log(`File already deleted: ${url}`);
            } else {
              console.warn(`Could not delete file: ${url}`, err);
            }
          }
        }

        // 7. Soft delete in Firestore
        await messageRef.update({
          isDeleted: true,
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedBy: userId,
          videoUrl: null,
          thumbnailUrl: null,
          encryptedVideoUrl: null,
          encryptedThumbnailUrl: null,
        });

        // 8. Return success
        return { success: true };

      } catch (error) {
        if (error instanceof HttpsError) {
          throw error;
        }
        console.error('Error deleting video:', error);
        throw new HttpsError('internal', 'Failed to delete video');
      }
    }),

    /**
     * Scheduled function - runs weekly on Sunday at 3:00 AM to clean up orphaned chats
     */
    cleanupOrphanedChats: onSchedule({
      schedule: '0 3 * * 0', // Sunday at 3:00 AM
      timeZone: 'America/Los_Angeles',
      region: 'us-central1',
      maxInstances: 1,
      memory: '1GB',
      timeoutSeconds: 540
    }, async (event) => {
      return performOrphanedChatCleanup({
        triggeredBy: 'scheduled',
        batchSize: 50
      });
    }),

    /**
     * Manual trigger for admins to clean up orphaned chats
     */
    manualOrphanedChatCleanup: onCall({
      region: 'us-central1',
      maxInstances: 1,
      timeoutSeconds: 540
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }

      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      const { dryRun = true, batchSize = 20 } = request.data || {};

      console.log(`🔧 Manual orphaned chat cleanup triggered by ${request.auth.uid}`);

      try {
        return await performOrphanedChatCleanup({
          triggeredBy: `user:${request.auth.uid}`,
          dryRun,
          batchSize
        });
      } catch (error) {
        console.error('Manual orphaned chat cleanup error:', error);
        throw new HttpsError('internal', error.message);
      }
    })
  };
  
  // Helper to calculate next scheduled run (regular cleanup at 2am)
  function getNextScheduledRun() {
    const now = new Date();
    const next = new Date(now);

    // Set to 2 AM
    next.setHours(2, 0, 0, 0);

    // If it's already past 2 AM today, move to tomorrow
    if (now.getHours() >= 2) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  // Helper to calculate next archived cleanup run (at 3am)
  function getNextArchivedScheduledRun() {
    const now = new Date();
    const next = new Date(now);

    // Set to 3 AM
    next.setHours(3, 0, 0, 0);

    // If it's already past 3 AM today, move to tomorrow
    if (now.getHours() >= 3) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }
};