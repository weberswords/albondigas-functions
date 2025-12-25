const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

module.exports = (firebaseHelper) => {
    const { admin, db } = firebaseHelper;

    /**
     * Core logic for cleaning up expired invite codes
     */
    async function performInviteCodeCleanup(options = {}) {
        const {
            batchSize = 500,
            dryRun = false,
            triggeredBy = 'system'
        } = options;

        console.log(`🧹 Starting invite code cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

        const now = admin.firestore.Timestamp.now();
        let codesDeleted = 0;
        let totalErrors = 0;
        const startTime = Date.now();

        try {
            let hasMore = true;
            while (hasMore) {
                const expiredCodesQuery = await db.collection('groupInviteCodes')
                    .where('expiresAt', '<=', now)
                    .limit(batchSize)
                    .get();

                if (expiredCodesQuery.empty) {
                    hasMore = false;
                    break;
                }

                if (dryRun) {
                    codesDeleted += expiredCodesQuery.size;
                    console.log(`[DRY RUN] Would delete ${expiredCodesQuery.size} expired invite codes`);
                    hasMore = false;
                } else {
                    const batch = db.batch();
                    expiredCodesQuery.docs.forEach(doc => {
                        console.log(`🗑️ Deleting expired invite code: ${doc.id}`);
                        batch.delete(doc.ref);
                    });
                    await batch.commit();
                    codesDeleted += expiredCodesQuery.size;

                    if (expiredCodesQuery.size < batchSize) {
                        hasMore = false;
                    }
                }
            }

            const duration = Date.now() - startTime;

            const results = {
                success: true,
                codesDeleted,
                errors: totalErrors,
                dryRun,
                triggeredBy,
                duration,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            if (!dryRun) {
                await db.collection('systemLogs')
                    .doc('inviteCodeCleanup')
                    .collection('runs')
                    .add(results);
            }

            console.log(`🎉 Invite code cleanup complete!`);
            console.log(`📊 Results: ${codesDeleted} codes ${dryRun ? 'would be' : ''} deleted`);

            return results;

        } catch (error) {
            console.error('❌ Invite code cleanup failed:', error);

            await db.collection('systemLogs')
                .doc('inviteCodeCleanup')
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
     * Core logic for cleaning up orphaned groups (where creator deleted their account)
     */
    async function performOrphanedGroupCleanup(options = {}) {
        const {
            batchSize = 50,
            dryRun = false,
            triggeredBy = 'system'
        } = options;

        console.log(`🧹 Starting orphaned group cleanup (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

        let groupsTransferred = 0;
        let groupsDeleted = 0;
        let inviteCodesDeleted = 0;
        let totalErrors = 0;
        const startTime = Date.now();
        const results_details = [];

        try {
            // Get all groups
            const groupsQuery = await db.collection('groups')
                .limit(batchSize)
                .get();

            if (groupsQuery.empty) {
                console.log('✅ No groups to check.');
                return {
                    success: true,
                    groupsTransferred: 0,
                    groupsDeleted: 0,
                    inviteCodesDeleted: 0,
                    errors: 0,
                    dryRun,
                    triggeredBy,
                    duration: Date.now() - startTime
                };
            }

            console.log(`📦 Checking ${groupsQuery.size} groups...`);

            for (const groupDoc of groupsQuery.docs) {
                const groupData = groupDoc.data();
                const groupId = groupDoc.id;
                const creatorId = groupData.creatorId;

                if (!creatorId) {
                    console.log(`⚠️ Group ${groupId} has no creatorId, skipping`);
                    continue;
                }

                // Check if creator exists in users collection
                const creatorDoc = await db.collection('users').doc(creatorId).get();

                if (creatorDoc.exists) {
                    // Creator still exists, skip this group
                    continue;
                }

                // Check if creator is in deletedUsers
                const deletedCreatorDoc = await db.collection('deletedUsers').doc(creatorId).get();

                if (!deletedCreatorDoc.exists) {
                    // Creator not found anywhere, might be an edge case
                    continue;
                }

                // Creator has deleted their account - handle this group
                console.log(`🔍 Found orphaned group: ${groupId} (creator ${creatorId} deleted)`);

                // Get group members (if any)
                const members = groupData.members || [];
                const activeMembersExceptCreator = members.filter(m => m !== creatorId);

                if (activeMembersExceptCreator.length > 0) {
                    // Transfer ownership to the first member (or longest-tenured if we track that)
                    const newOwnerId = activeMembersExceptCreator[0];

                    if (dryRun) {
                        console.log(`[DRY RUN] Would transfer group ${groupId} to ${newOwnerId}`);
                        results_details.push({
                            groupId,
                            action: 'would_transfer',
                            newOwnerId,
                            previousOwnerId: creatorId
                        });
                        groupsTransferred++;
                    } else {
                        // Transfer ownership
                        await groupDoc.ref.update({
                            creatorId: newOwnerId,
                            ownershipTransferredAt: admin.firestore.FieldValue.serverTimestamp(),
                            previousCreatorId: creatorId,
                            ownershipTransferReason: 'creator_deleted_account'
                        });

                        console.log(`✅ Transferred group ${groupId} to ${newOwnerId}`);
                        results_details.push({
                            groupId,
                            action: 'transferred',
                            newOwnerId,
                            previousOwnerId: creatorId
                        });
                        groupsTransferred++;
                    }
                } else {
                    // No active members - delete the group and its invite codes
                    if (dryRun) {
                        console.log(`[DRY RUN] Would delete orphaned group ${groupId} with no members`);
                        results_details.push({
                            groupId,
                            action: 'would_delete',
                            reason: 'no_active_members'
                        });
                        groupsDeleted++;
                    } else {
                        // Delete all invite codes for this group
                        const inviteCodesQuery = await db.collection('groupInviteCodes')
                            .where('groupId', '==', groupId)
                            .get();

                        if (!inviteCodesQuery.empty) {
                            const batch = db.batch();
                            inviteCodesQuery.docs.forEach(doc => batch.delete(doc.ref));
                            await batch.commit();
                            inviteCodesDeleted += inviteCodesQuery.size;
                            console.log(`🗑️ Deleted ${inviteCodesQuery.size} invite codes for group ${groupId}`);
                        }

                        // Delete the group document
                        await groupDoc.ref.delete();
                        console.log(`🗑️ Deleted orphaned group ${groupId}`);

                        results_details.push({
                            groupId,
                            action: 'deleted',
                            inviteCodesDeleted: inviteCodesQuery.size
                        });
                        groupsDeleted++;
                    }
                }
            }

            const duration = Date.now() - startTime;

            const results = {
                success: true,
                groupsTransferred,
                groupsDeleted,
                inviteCodesDeleted,
                errors: totalErrors,
                details: results_details,
                dryRun,
                triggeredBy,
                duration,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            if (!dryRun && (groupsTransferred > 0 || groupsDeleted > 0)) {
                await db.collection('systemLogs')
                    .doc('orphanedGroupCleanup')
                    .collection('runs')
                    .add(results);
            }

            console.log(`🎉 Orphaned group cleanup complete!`);
            console.log(`📊 Results: ${groupsTransferred} transferred, ${groupsDeleted} deleted, ${inviteCodesDeleted} invite codes cleaned`);

            return results;

        } catch (error) {
            console.error('❌ Orphaned group cleanup failed:', error);

            await db.collection('systemLogs')
                .doc('orphanedGroupCleanup')
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

    return {
        /**
         * Scheduled function - runs daily at 5:00 AM to clean up expired invite codes
         */
        cleanupExpiredInviteCodes: onSchedule({
            schedule: '0 5 * * *', // Daily at 5:00 AM
            timeZone: 'America/Los_Angeles',
            region: 'us-central1',
            maxInstances: 1,
            memory: '256MB',
            timeoutSeconds: 120
        }, async (event) => {
            return performInviteCodeCleanup({
                triggeredBy: 'scheduled',
                batchSize: 500
            });
        }),

        /**
         * Manual trigger for admins to clean up expired invite codes
         */
        manualInviteCodeCleanup: onCall({
            region: 'us-central1',
            maxInstances: 1,
            timeoutSeconds: 120
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            const { dryRun = true, batchSize = 100 } = request.data || {};

            console.log(`🔧 Manual invite code cleanup triggered by ${request.auth.uid}`);

            try {
                return await performInviteCodeCleanup({
                    triggeredBy: `user:${request.auth.uid}`,
                    dryRun,
                    batchSize
                });
            } catch (error) {
                console.error('Manual invite code cleanup error:', error);
                throw new HttpsError('internal', error.message);
            }
        }),

        /**
         * Scheduled function - runs weekly on Sunday at 2:00 AM to handle orphaned groups
         */
        cleanupOrphanedGroups: onSchedule({
            schedule: '0 2 * * 0', // Sunday at 2:00 AM
            timeZone: 'America/Los_Angeles',
            region: 'us-central1',
            maxInstances: 1,
            memory: '512MB',
            timeoutSeconds: 300
        }, async (event) => {
            return performOrphanedGroupCleanup({
                triggeredBy: 'scheduled',
                batchSize: 50
            });
        }),

        /**
         * Manual trigger for admins to handle orphaned groups
         */
        manualOrphanedGroupCleanup: onCall({
            region: 'us-central1',
            maxInstances: 1,
            timeoutSeconds: 300
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            const { dryRun = true, batchSize = 20 } = request.data || {};

            console.log(`🔧 Manual orphaned group cleanup triggered by ${request.auth.uid}`);

            try {
                return await performOrphanedGroupCleanup({
                    triggeredBy: `user:${request.auth.uid}`,
                    dryRun,
                    batchSize
                });
            } catch (error) {
                console.error('Manual orphaned group cleanup error:', error);
                throw new HttpsError('internal', error.message);
            }
        })
    };
};
