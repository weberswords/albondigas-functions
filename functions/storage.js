const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
    const { admin, db } = firebaseHelper;
    const storage = admin.storage();

    /**
     * Helper to extract storage path from URL
     */
    function extractStoragePath(url) {
        if (!url) return null;
        try {
            const urlObj = new URL(url);
            const pathMatch = urlObj.pathname.match(/\/o\/(.+?)(\?|$)/);
            if (pathMatch && pathMatch[1]) {
                return decodeURIComponent(pathMatch[1]);
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    /**
     * Core logic for auditing and cleaning orphaned storage files
     * This is an expensive operation and should be run manually with care
     */
    async function performStorageAudit(options = {}) {
        const {
            maxFiles = 1000,
            prefix = '',
            dryRun = true, // Default to dry run for safety
            triggeredBy = 'system'
        } = options;

        console.log(`🔍 Starting storage audit (triggered by: ${triggeredBy}, dryRun: ${dryRun}, prefix: ${prefix || 'all'})...`);

        const bucket = storage.bucket();
        let filesScanned = 0;
        let orphansFound = 0;
        let orphansDeleted = 0;
        let totalSizeBytes = 0;
        const orphanedFiles = [];
        const errors = [];
        const startTime = Date.now();

        try {
            // Get files from storage with optional prefix filter
            const [files] = await bucket.getFiles({
                prefix: prefix || undefined,
                maxResults: maxFiles
            });

            console.log(`📦 Found ${files.length} files to audit...`);

            for (const file of files) {
                filesScanned++;
                const filePath = file.name;

                // Skip directories (paths ending with /)
                if (filePath.endsWith('/')) {
                    continue;
                }

                // Determine what type of file this is and where to check for it
                let isOrphaned = false;
                let fileType = 'unknown';

                try {
                    if (filePath.startsWith('videos/')) {
                        // Format: videos/{userId}/{videoId}
                        fileType = 'video';
                        isOrphaned = await checkVideoOrphaned(filePath);
                    } else if (filePath.startsWith('thumbnails/')) {
                        // Format: thumbnails/{userId}/{thumbnailId}
                        fileType = 'thumbnail';
                        isOrphaned = await checkThumbnailOrphaned(filePath);
                    } else if (filePath.startsWith('users/') && filePath.includes('/avatars/')) {
                        // Format: users/{userId}/avatars/{filename}
                        fileType = 'avatar';
                        isOrphaned = await checkAvatarOrphaned(filePath);
                    } else {
                        // Unknown file type - flag for review
                        fileType = 'unknown';
                        console.log(`⚠️ Unknown file type: ${filePath}`);
                    }

                    if (isOrphaned) {
                        // Get file metadata for size
                        const [metadata] = await file.getMetadata();
                        const fileSize = parseInt(metadata.size) || 0;

                        orphanedFiles.push({
                            path: filePath,
                            type: fileType,
                            size: fileSize,
                            sizeMB: Math.round(fileSize / 1024 / 1024 * 100) / 100,
                            created: metadata.timeCreated,
                            updated: metadata.updated
                        });

                        orphansFound++;
                        totalSizeBytes += fileSize;

                        if (!dryRun) {
                            try {
                                await file.delete();
                                orphansDeleted++;
                                console.log(`🗑️ Deleted orphaned file: ${filePath}`);
                            } catch (deleteErr) {
                                console.error(`❌ Failed to delete ${filePath}:`, deleteErr);
                                errors.push({ path: filePath, error: deleteErr.message });
                            }
                        } else {
                            console.log(`[DRY RUN] Would delete: ${filePath} (${Math.round(fileSize / 1024)} KB)`);
                        }
                    }
                } catch (checkErr) {
                    console.error(`❌ Error checking file ${filePath}:`, checkErr);
                    errors.push({ path: filePath, error: checkErr.message });
                }

                // Progress logging every 100 files
                if (filesScanned % 100 === 0) {
                    console.log(`📊 Progress: ${filesScanned}/${files.length} files scanned, ${orphansFound} orphans found`);
                }
            }

            const duration = Date.now() - startTime;

            const results = {
                success: true,
                filesScanned,
                orphansFound,
                orphansDeleted,
                totalSizeBytes,
                totalSizeMB: Math.round(totalSizeBytes / 1024 / 1024 * 100) / 100,
                errors: errors.length,
                errorDetails: errors.slice(0, 10), // Only include first 10 errors
                orphanedFiles: orphanedFiles.slice(0, 100), // Only include first 100 for response size
                dryRun,
                prefix: prefix || 'all',
                triggeredBy,
                duration,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            // Log results
            await db.collection('systemLogs')
                .doc('storageAudit')
                .collection('runs')
                .add(results);

            console.log(`🎉 Storage audit complete!`);
            console.log(`📊 Results: ${filesScanned} scanned, ${orphansFound} orphans found, ${orphansDeleted} deleted`);
            console.log(`💾 Potential space to free: ${Math.round(totalSizeBytes / 1024 / 1024)} MB`);
            console.log(`⏱️ Duration: ${duration}ms`);

            return results;

        } catch (error) {
            console.error('❌ Storage audit failed:', error);

            await db.collection('systemLogs')
                .doc('storageAudit')
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

    /**
     * Check if a video file is orphaned (no matching message document)
     */
    async function checkVideoOrphaned(filePath) {
        // Format: videos/{userId}/{videoId}
        const parts = filePath.split('/');
        if (parts.length < 3) return true; // Invalid path format

        const userId = parts[1];

        // Check if user exists
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            // User deleted - check if in deletedUsers (expected cleanup)
            const deletedUserDoc = await db.collection('deletedUsers').doc(userId).get();
            if (deletedUserDoc.exists) {
                // User was deleted, file should have been cleaned up
                return true;
            }
        }

        // Search for any message referencing this path
        const storageUrl = `videos/${userId}`;

        // Query messages across all chats using collectionGroup
        // Check if any message has this video path
        const messagesQuery = await db.collectionGroup('messages')
            .where('storagePath', '==', filePath)
            .limit(1)
            .get();

        if (!messagesQuery.empty) {
            return false; // Found a reference, not orphaned
        }

        // Also check by URL pattern (videoUrl contains the path)
        // This is more expensive but catches edge cases
        return true; // No reference found, likely orphaned
    }

    /**
     * Check if a thumbnail file is orphaned
     */
    async function checkThumbnailOrphaned(filePath) {
        // Format: thumbnails/{userId}/{thumbnailId}
        const parts = filePath.split('/');
        if (parts.length < 3) return true;

        const userId = parts[1];

        // Check if user exists
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            const deletedUserDoc = await db.collection('deletedUsers').doc(userId).get();
            if (deletedUserDoc.exists) {
                return true; // User deleted, thumbnail should be gone
            }
        }

        // Similar logic to video - would need to search messages
        // For thumbnails, we typically don't store the path directly
        // so we can't easily verify without scanning all messages
        // Return false to be conservative (don't delete without certainty)
        return false;
    }

    /**
     * Check if an avatar file is orphaned
     */
    async function checkAvatarOrphaned(filePath) {
        // Format: users/{userId}/avatars/{filename}
        const parts = filePath.split('/');
        if (parts.length < 4) return true;

        const userId = parts[1];

        // Check if user exists
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            // User doesn't exist - avatar is orphaned
            return true;
        }

        // User exists - check if this is their current avatar
        const userData = userDoc.data();
        const currentAvatarUrl = userData.avatarUrl || userData.photoURL;

        if (!currentAvatarUrl) {
            // User has no avatar set, this file is orphaned
            return true;
        }

        // Check if the current avatar URL matches this file
        const currentPath = extractStoragePath(currentAvatarUrl);
        if (currentPath === filePath) {
            return false; // This is the current avatar
        }

        // This is an old avatar - user has a different one now
        return true;
    }

    return {
        /**
         * Manual trigger for admins to audit orphaned storage files
         * This is intentionally not scheduled due to cost/complexity
         */
        auditOrphanedStorageFiles: onCall({
            region: 'us-central1',
            maxInstances: 1,
            memory: '1GB',
            timeoutSeconds: 540
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            const {
                dryRun = true,
                maxFiles = 500,
                prefix = ''
            } = request.data || {};

            console.log(`🔧 Storage audit triggered by ${request.auth.uid}`);
            console.log(`   Options: dryRun=${dryRun}, maxFiles=${maxFiles}, prefix=${prefix || 'all'}`);

            try {
                return await performStorageAudit({
                    triggeredBy: `user:${request.auth.uid}`,
                    dryRun,
                    maxFiles: Math.min(maxFiles, 2000), // Cap at 2000 for safety
                    prefix
                });
            } catch (error) {
                console.error('Storage audit error:', error);
                throw new HttpsError('internal', error.message);
            }
        }),

        /**
         * Get storage audit stats from recent runs
         */
        getStorageAuditStats: onCall({
            region: 'us-central1',
            maxInstances: 10
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            try {
                // Get last 5 audit runs
                const runsQuery = await db.collection('systemLogs')
                    .doc('storageAudit')
                    .collection('runs')
                    .orderBy('timestamp', 'desc')
                    .limit(5)
                    .get();

                const runs = runsQuery.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data(),
                    // Remove large arrays from response
                    orphanedFiles: undefined,
                    errorDetails: undefined
                }));

                return {
                    success: true,
                    recentRuns: runs,
                    totalRuns: runsQuery.size
                };
            } catch (error) {
                console.error('Error getting storage audit stats:', error);
                throw new HttpsError('internal', error.message);
            }
        })
    };
};
