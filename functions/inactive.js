const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const mailgun = require('mailgun-js');

const mailgunApiKey = defineSecret('MAILGUN_API_KEY');
const mailgunDomain = "mail.vlrb.app";

// Account is considered inactive after this many days
const INACTIVE_THRESHOLD_DAYS = 365;
// Days between warning email and actual deletion
const DELETION_GRACE_PERIOD_DAYS = 30;

module.exports = (firebaseHelper, accountFunctions = null) => {
    const { admin, db } = firebaseHelper;

    // Get deleteUserData from account functions if provided
    const deleteUserData = accountFunctions?.deleteUserData;

    /**
     * Core logic for finding and notifying inactive accounts
     */
    async function performInactiveAccountCheck(options = {}) {
        const {
            batchSize = 100,
            dryRun = false,
            triggeredBy = 'system'
        } = options;

        console.log(`🔍 Starting inactive account check (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

        const now = new Date();
        const inactiveThreshold = new Date(now.getTime() - (INACTIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000));
        const inactiveTimestamp = admin.firestore.Timestamp.fromDate(inactiveThreshold);

        let totalNotified = 0;
        let totalErrors = 0;
        let totalSkipped = 0;
        const startTime = Date.now();

        // Configure Mailgun (only if not dry run)
        let mg = null;
        if (!dryRun) {
            mg = mailgun({
                apiKey: mailgunApiKey.value(),
                domain: mailgunDomain
            });
        }

        try {
            // Query users who:
            // 1. Have a lastActive timestamp older than the threshold
            // 2. Have NOT already been sent an inactive warning email
            // 3. Are NOT already scheduled for deletion
            // 4. Are NOT already deleted
            const inactiveUsersQuery = db.collection('users')
                .where('lastActive', '<=', inactiveTimestamp)
                .where('scheduledForDeletion', '==', false)
                .limit(batchSize);

            const snapshot = await inactiveUsersQuery.get();

            if (snapshot.empty) {
                console.log('✅ No inactive accounts found.');
                return {
                    success: true,
                    usersNotified: 0,
                    errors: 0,
                    skipped: 0,
                    dryRun: dryRun,
                    triggeredBy: triggeredBy,
                    duration: Date.now() - startTime
                };
            }

            console.log(`📦 Found ${snapshot.size} potentially inactive accounts to process...`);

            for (const doc of snapshot.docs) {
                const userData = doc.data();
                const userId = doc.id;

                // Skip if already deleted or no email
                if (userData.isDeletedAccount || !userData.email) {
                    totalSkipped++;
                    continue;
                }

                // Skip if we've already sent a warning email recently (within grace period)
                if (userData.inactiveWarningEmailSentAt) {
                    const warningSentDate = userData.inactiveWarningEmailSentAt.toDate();
                    const daysSinceWarning = (now - warningSentDate) / (1000 * 60 * 60 * 24);

                    if (daysSinceWarning < DELETION_GRACE_PERIOD_DAYS) {
                        totalSkipped++;
                        continue;
                    }
                }

                if (dryRun) {
                    console.log(`[DRY RUN] Would notify: ${userData.email} (last active: ${userData.lastActive?.toDate()})`);
                    totalNotified++;
                    continue;
                }

                try {
                    // Calculate deletion date (grace period from now)
                    const deletionDate = new Date(now.getTime() + (DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000));

                    // Send warning email
                    await sendInactiveAccountEmail(mg, userData.email, userData.displayName, deletionDate);

                    // Update user document
                    await db.collection('users').doc(userId).update({
                        inactiveWarningEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
                        scheduledForDeletion: true,
                        deletionDate: admin.firestore.Timestamp.fromDate(deletionDate)
                    });

                    console.log(`✅ Notified ${userData.email} - scheduled for deletion on ${deletionDate.toISOString()}`);
                    totalNotified++;

                } catch (error) {
                    console.error(`❌ Failed to notify ${userData.email}:`, error);
                    totalErrors++;
                }
            }

            const duration = Date.now() - startTime;

            const results = {
                success: true,
                usersNotified: totalNotified,
                errors: totalErrors,
                skipped: totalSkipped,
                dryRun: dryRun,
                triggeredBy: triggeredBy,
                duration: duration,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            // Log results (unless dry run)
            if (!dryRun) {
                await db.collection('systemLogs')
                    .doc('inactiveAccountNotifications')
                    .collection('runs')
                    .add(results);
            }

            console.log(`🎉 Inactive account check complete!`);
            console.log(`📊 Results: ${totalNotified} users ${dryRun ? 'would be' : ''} notified, ${totalErrors} errors, ${totalSkipped} skipped`);
            console.log(`⏱️ Duration: ${duration}ms`);

            return results;

        } catch (error) {
            console.error('❌ Inactive account check failed:', error);

            // Log error
            await db.collection('systemLogs')
                .doc('inactiveAccountNotifications')
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
     * Send the inactive account warning email
     */
    async function sendInactiveAccountEmail(mg, email, displayName, deletionDate) {
        const formattedDate = deletionDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        const name = displayName || 'there';

        const emailBody = `Hi ${name},

We noticed you haven't used VLRB in over a year. We miss you!

To keep our platform running smoothly, we periodically remove inactive accounts. Your account is scheduled for deletion on ${formattedDate}.

If you'd like to keep your account, simply log in before that date and your account will be saved.

If you have any questions, feel free to reach out to us.

Thanks,
VLRB Team`;

        const mailData = {
            from: 'VLRB <noreply@vlrb.app>',
            to: email,
            subject: 'Your VLRB account will be deleted soon',
            text: emailBody,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>We Miss You!</h2>
          <p>Hi ${name},</p>
          <p>We noticed you haven't used VLRB in over a year.</p>
          <p>To keep our platform running smoothly, we periodically remove inactive accounts. Your account is scheduled for deletion on:</p>
          <div style="font-size: 18px; font-weight: bold; color: #FF3B30; text-align: center; margin: 20px 0; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
            ${formattedDate}
          </div>
          <p><strong>Want to keep your account?</strong> Simply log in before that date and your account will be saved.</p>
          <p>If you have any questions, feel free to reach out to us.</p>
          <p>Thanks,<br>VLRB Team</p>
        </div>
      `
        };

        return new Promise((resolve, reject) => {
            mg.messages().send(mailData, (error, body) => {
                if (error) reject(error);
                else resolve(body);
            });
        });
    }

    /**
     * Core logic for executing scheduled account deletions
     * Finds accounts where deletionDate has passed and deletes them
     */
    async function performScheduledDeletions(options = {}) {
        const {
            batchSize = 10,
            dryRun = false,
            triggeredBy = 'system'
        } = options;

        console.log(`🗑️ Starting scheduled deletions (triggered by: ${triggeredBy}, dryRun: ${dryRun})...`);

        if (!deleteUserData) {
            throw new Error('deleteUserData function not available - check module initialization');
        }

        const now = admin.firestore.Timestamp.now();
        let totalDeleted = 0;
        let totalErrors = 0;
        let totalSkipped = 0;
        const startTime = Date.now();
        const deletionResults = [];

        try {
            // Query users where:
            // 1. scheduledForDeletion is true
            // 2. deletionDate has passed
            const scheduledUsersQuery = db.collection('users')
                .where('scheduledForDeletion', '==', true)
                .where('deletionDate', '<=', now)
                .limit(batchSize);

            const snapshot = await scheduledUsersQuery.get();

            if (snapshot.empty) {
                console.log('✅ No accounts scheduled for deletion at this time.');
                return {
                    success: true,
                    accountsDeleted: 0,
                    errors: 0,
                    skipped: 0,
                    dryRun: dryRun,
                    triggeredBy: triggeredBy,
                    duration: Date.now() - startTime
                };
            }

            console.log(`📦 Found ${snapshot.size} accounts to delete...`);

            for (const doc of snapshot.docs) {
                const userData = doc.data();
                const userId = doc.id;

                // Skip if already marked as deleted
                if (userData.isDeletedAccount) {
                    totalSkipped++;
                    continue;
                }

                if (dryRun) {
                    console.log(`[DRY RUN] Would delete: ${userId} (${userData.email || 'no email'})`);
                    deletionResults.push({
                        userId,
                        email: userData.email,
                        status: 'would_delete',
                        scheduledByUser: userData.scheduledByUser || false,
                        deletionDate: userData.deletionDate?.toDate?.() || null
                    });
                    totalDeleted++;
                    continue;
                }

                try {
                    console.log(`🗑️ Deleting account: ${userId}`);
                    const result = await deleteUserData(userId);

                    deletionResults.push({
                        userId,
                        email: userData.email,
                        status: 'deleted',
                        details: result
                    });

                    totalDeleted++;
                    console.log(`✅ Deleted account: ${userId}`);

                } catch (error) {
                    console.error(`❌ Failed to delete account ${userId}:`, error);
                    deletionResults.push({
                        userId,
                        email: userData.email,
                        status: 'error',
                        error: error.message
                    });
                    totalErrors++;
                }
            }

            const duration = Date.now() - startTime;

            const results = {
                success: true,
                accountsDeleted: totalDeleted,
                errors: totalErrors,
                skipped: totalSkipped,
                dryRun: dryRun,
                triggeredBy: triggeredBy,
                duration: duration,
                deletionResults: deletionResults,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            // Log results (unless dry run)
            if (!dryRun) {
                await db.collection('systemLogs')
                    .doc('scheduledDeletions')
                    .collection('runs')
                    .add(results);
            }

            console.log(`🎉 Scheduled deletions complete!`);
            console.log(`📊 Results: ${totalDeleted} accounts ${dryRun ? 'would be' : ''} deleted, ${totalErrors} errors, ${totalSkipped} skipped`);
            console.log(`⏱️ Duration: ${duration}ms`);

            return results;

        } catch (error) {
            console.error('❌ Scheduled deletions failed:', error);

            await db.collection('systemLogs')
                .doc('scheduledDeletions')
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

    return {
        /**
         * Scheduled function - runs daily at 3 AM to check for inactive accounts
         */
        checkInactiveAccounts: onSchedule({
            schedule: '0 3 * * *', // Daily at 3 AM
            timeZone: 'America/Los_Angeles',
            region: 'us-central1',
            maxInstances: 1,
            memory: '512MB',
            timeoutSeconds: 540,
            secrets: [mailgunApiKey]
        }, async (event) => {
            return performInactiveAccountCheck({
                triggeredBy: 'scheduled',
                batchSize: 100
            });
        }),

        /**
         * Manual trigger for admins to run the inactive account check
         */
        manualInactiveAccountCheck: onCall({
            region: 'us-central1',
            maxInstances: 1,
            timeoutSeconds: 540,
            secrets: [mailgunApiKey]
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            // Verify admin status
            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            const { dryRun = true, batchSize = 50 } = request.data || {};

            console.log(`🔧 Manual inactive account check triggered by ${request.auth.uid}`);

            try {
                const results = await performInactiveAccountCheck({
                    triggeredBy: `user:${request.auth.uid}`,
                    dryRun: dryRun,
                    batchSize: batchSize
                });

                return results;
            } catch (error) {
                console.error('Manual inactive account check error:', error);
                throw new HttpsError('internal', error.message);
            }
        }),

        /**
         * Called by the client app to update the user's last active timestamp.
         * This should be called when the app launches or becomes active.
         */
        updateLastActive: onCall({
            region: 'us-central1',
            maxInstances: 100,
            timeoutSeconds: 30
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            const userId = request.auth.uid;

            try {
                const userRef = db.collection('users').doc(userId);
                const userDoc = await userRef.get();

                if (!userDoc.exists) {
                    throw new HttpsError('not-found', 'User not found');
                }

                const userData = userDoc.data();
                const updateData = {
                    lastActive: admin.firestore.FieldValue.serverTimestamp()
                };

                // If user was scheduled for deletion due to inactivity, cancel it
                if (userData.scheduledForDeletion && userData.inactiveWarningEmailSentAt) {
                    updateData.scheduledForDeletion = false;
                    updateData.deletionDate = null;
                    console.log(`✅ User ${userId} returned - cancelling scheduled deletion`);
                }

                await userRef.update(updateData);

                return {
                    success: true,
                    message: 'Last active timestamp updated',
                    deletionCancelled: !!userData.scheduledForDeletion
                };

            } catch (error) {
                console.error('Error updating last active:', error);
                throw new HttpsError('internal', 'Failed to update last active timestamp');
            }
        }),

        /**
         * Get inactive account notification stats
         */
        getInactiveAccountStats: onCall({
            region: 'us-central1',
            maxInstances: 10
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            // Verify admin status
            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            try {
                const now = new Date();
                const inactiveThreshold = new Date(now.getTime() - (INACTIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000));
                const inactiveTimestamp = admin.firestore.Timestamp.fromDate(inactiveThreshold);

                // Count potentially inactive users
                const inactiveQuery = await db.collection('users')
                    .where('lastActive', '<=', inactiveTimestamp)
                    .where('scheduledForDeletion', '==', false)
                    .count()
                    .get();

                // Count users scheduled for deletion
                const scheduledQuery = await db.collection('users')
                    .where('scheduledForDeletion', '==', true)
                    .count()
                    .get();

                // Count users ready for deletion (past deletion date)
                const now_ts = admin.firestore.Timestamp.now();
                const readyForDeletionQuery = await db.collection('users')
                    .where('scheduledForDeletion', '==', true)
                    .where('deletionDate', '<=', now_ts)
                    .count()
                    .get();

                // Get last inactive check run info
                const lastInactiveRunQuery = await db.collection('systemLogs')
                    .doc('inactiveAccountNotifications')
                    .collection('runs')
                    .orderBy('timestamp', 'desc')
                    .limit(1)
                    .get();

                // Get last deletion run info
                const lastDeletionRunQuery = await db.collection('systemLogs')
                    .doc('scheduledDeletions')
                    .collection('runs')
                    .orderBy('timestamp', 'desc')
                    .limit(1)
                    .get();

                return {
                    pendingNotification: inactiveQuery.data().count,
                    scheduledForDeletion: scheduledQuery.data().count,
                    readyForDeletion: readyForDeletionQuery.data().count,
                    inactiveThresholdDays: INACTIVE_THRESHOLD_DAYS,
                    gracePeriodDays: DELETION_GRACE_PERIOD_DAYS,
                    lastInactiveCheckRun: lastInactiveRunQuery.empty ? null : lastInactiveRunQuery.docs[0].data(),
                    lastDeletionRun: lastDeletionRunQuery.empty ? null : lastDeletionRunQuery.docs[0].data()
                };
            } catch (error) {
                console.error('Error getting inactive account stats:', error);
                throw new HttpsError('internal', error.message);
            }
        }),

        /**
         * Scheduled function - runs daily at 4 AM to execute scheduled deletions
         * Runs after checkInactiveAccounts (3 AM) to process any newly scheduled accounts
         */
        executeScheduledDeletions: onSchedule({
            schedule: '0 4 * * *', // Daily at 4 AM
            timeZone: 'America/Los_Angeles',
            region: 'us-central1',
            maxInstances: 1,
            memory: '1GB',
            timeoutSeconds: 540
        }, async (event) => {
            return performScheduledDeletions({
                triggeredBy: 'scheduled',
                batchSize: 10 // Process 10 accounts per run to avoid timeout
            });
        }),

        /**
         * Manual trigger for admins to execute scheduled deletions
         */
        manualExecuteScheduledDeletions: onCall({
            region: 'us-central1',
            maxInstances: 1,
            timeoutSeconds: 540
        }, async (request) => {
            if (!request.auth) {
                throw new HttpsError('unauthenticated', 'You must be logged in');
            }

            // Verify admin status
            const userDoc = await db.collection('users').doc(request.auth.uid).get();
            if (!userDoc.exists || !userDoc.data().isAdmin) {
                throw new HttpsError('permission-denied', 'Admin access required');
            }

            const { dryRun = true, batchSize = 5 } = request.data || {};

            console.log(`🔧 Manual scheduled deletion triggered by ${request.auth.uid}`);

            try {
                const results = await performScheduledDeletions({
                    triggeredBy: `user:${request.auth.uid}`,
                    dryRun: dryRun,
                    batchSize: batchSize
                });

                return results;
            } catch (error) {
                console.error('Manual scheduled deletion error:', error);
                throw new HttpsError('internal', error.message);
            }
        })
    };
};
