const admin = require('firebase-admin');

// Import service account
const serviceAccount = require('./firebase_admin.json');

// Initialize admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "gs://albondigas-8cfd9.appspot.com"
});

// Initialize Firestore ONCE
const db = admin.firestore();

// Create a helper object
const firebaseHelper = { admin, db };

// Import function modules with the helper
// Account functions initialized first as other modules may depend on them
const accountFunctions = require('./account.js')(firebaseHelper);
const friendFunctions = require('./friends.js')(firebaseHelper);
const notificationFunctions = require('./notifications.js')(firebaseHelper);
const videoFunctions = require('./videos.js')(firebaseHelper);
const verificationFunctions = require('./verification.js')(firebaseHelper);
// Pass accountFunctions to inactive so it can use deleteUserData
const inactiveFunctions = require('./inactive.js')(firebaseHelper, accountFunctions);
const loggingFunctions = require('./logging.js')(firebaseHelper);
const groupFunctions = require('./groups.js')(firebaseHelper);
const storageFunctions = require('./storage.js')(firebaseHelper);



// Export all functions
// Friend functions
exports.sendFriendRequest = friendFunctions.sendFriendRequest;
exports.acceptFriendRequest = friendFunctions.acceptFriendRequest;
exports.rejectFriendRequest = friendFunctions.rejectFriendRequest;
exports.unfriend = friendFunctions.unfriend;
exports.blockUser = friendFunctions.blockUser;
exports.checkFriendshipStatus = friendFunctions.checkFriendshipStatus;
exports.repairFriendshipState = friendFunctions.repairFriendshipState;
exports.unblockUser = friendFunctions.unblockUser;
exports.archiveVideosForChat = friendFunctions.archiveVideosForChat;
exports.cleanupStaleUserFriendships = friendFunctions.cleanupStaleUserFriendships;
exports.manualStaleUserFriendshipsCleanup = friendFunctions.manualStaleUserFriendshipsCleanup;

// Notification functions
exports.sendChatMessageNotification = notificationFunctions.sendChatMessageNotification;
exports.sendFriendRequestNotification = notificationFunctions.sendFriendRequestNotification;

// Account functions
exports.deleteAccountImmediately = accountFunctions.deleteAccountImmediately;
exports.scheduleAccountDeletion = accountFunctions.scheduleAccountDeletion;

// Video cleanup functions
exports.cleanupExpiredVideos = videoFunctions.cleanupExpiredVideos;
exports.cleanupExpiredArchivedVideos = videoFunctions.cleanupExpiredArchivedVideos;
exports.manualVideoCleanup = videoFunctions.manualVideoCleanup;
exports.manualArchivedVideoCleanup = videoFunctions.manualArchivedVideoCleanup;
exports.getCleanupStats = videoFunctions.getCleanupStats;
exports.deleteVideo = videoFunctions.deleteVideo;
exports.cleanupOrphanedChats = videoFunctions.cleanupOrphanedChats;
exports.manualOrphanedChatCleanup = videoFunctions.manualOrphanedChatCleanup;

// Verification functions
exports.sendVerificationCode = verificationFunctions.sendVerificationCode;
exports.verifyCode = verificationFunctions.verifyCode;
exports.sendPasswordResetCode = verificationFunctions.sendPasswordResetCode;
exports.verifyPasswordResetCode = verificationFunctions.verifyPasswordResetCode;
exports.resetPasswordWithCode = verificationFunctions.resetPasswordWithCode;
exports.cleanupExpiredVerificationCodes = verificationFunctions.cleanupExpiredVerificationCodes;
exports.manualVerificationCodeCleanup = verificationFunctions.manualVerificationCodeCleanup;

// Inactive account functions
exports.checkInactiveAccounts = inactiveFunctions.checkInactiveAccounts;
exports.manualInactiveAccountCheck = inactiveFunctions.manualInactiveAccountCheck;
exports.updateLastActive = inactiveFunctions.updateLastActive;
exports.getInactiveAccountStats = inactiveFunctions.getInactiveAccountStats;
exports.executeScheduledDeletions = inactiveFunctions.executeScheduledDeletions;
exports.manualExecuteScheduledDeletions = inactiveFunctions.manualExecuteScheduledDeletions;

// Group cleanup functions
exports.cleanupExpiredInviteCodes = groupFunctions.cleanupExpiredInviteCodes;
exports.manualInviteCodeCleanup = groupFunctions.manualInviteCodeCleanup;
exports.cleanupOrphanedGroups = groupFunctions.cleanupOrphanedGroups;
exports.manualOrphanedGroupCleanup = groupFunctions.manualOrphanedGroupCleanup;

// Storage audit functions
exports.auditOrphanedStorageFiles = storageFunctions.auditOrphanedStorageFiles;
exports.getStorageAuditStats = storageFunctions.getStorageAuditStats;

// Logging functions
exports.ingestLogs = loggingFunctions.ingestLogs;