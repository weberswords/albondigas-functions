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
  
  // Return the public functions
  return {
    // Scheduled function
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
    
    // Manual trigger function
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
    
    // Optional: Get cleanup stats
    getCleanupStats: onCall({
      region: 'us-central1',
      maxInstances: 10
    }, async (request) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in');
      }
      
      try {
        // Get count of videos that would be cleaned up
        const now = admin.firestore.Timestamp.now();
        const expiredQuery = await db.collectionGroup('messages')
          .where('expiresAt', '<=', now)
          .where('contentRemoved', '!=', true)
          .count()
          .get();
        
        // Get last cleanup run info
        const lastRunQuery = await db.collection('systemLogs')
          .doc('videoCleanup')
          .collection('runs')
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();
        
        const lastRun = lastRunQuery.empty ? null : lastRunQuery.docs[0].data();
        
        return {
          pendingCleanup: expiredQuery.data().count,
          lastRun: lastRun,
          nextScheduledRun: getNextScheduledRun()
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
    })
  };
  
  // Helper to calculate next scheduled run
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
};