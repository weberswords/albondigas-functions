const admin = require('firebase-admin');

// Import service account
const serviceAccount = require('./firebase_admin.json');
const account = require('./account.js');

// Initialize admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "gs://albondigas-8cfd9.appspot.com"
});

// Initialize Firestore ONCE
const db = admin.firestore(); // This line was missing

// Create a helper object
const firebaseHelper = { admin, db };

// Import function modules with the helper
const friendFunctions = require('./friends.js')(firebaseHelper);
const notificationFunctions = require('./notifications.js')(firebaseHelper);
const accountFunctions = require('./account.js')(firebaseHelper);
const videoFunctions = require('./videos.js')(firebaseHelper);
const verificationFunctions = require('./verification.js')(firebaseHelper);
const inactiveFunctions = require('./inactive.js')(firebaseHelper);
const loggingFunctions = require('./logging.js')(firebaseHelper);



// Export all functions
exports.sendFriendRequest = friendFunctions.sendFriendRequest;
exports.acceptFriendRequest = friendFunctions.acceptFriendRequest;
exports.rejectFriendRequest = friendFunctions.rejectFriendRequest;
exports.unfriend = friendFunctions.unfriend;
exports.blockUser = friendFunctions.blockUser;
exports.checkFriendshipStatus = friendFunctions.checkFriendshipStatus;
exports.repairFriendshipState = friendFunctions.repairFriendshipState;
exports.unblockUser = friendFunctions.unblockUser;
exports.archiveVideosForChat = friendFunctions.archiveVideosForChat;


exports.sendChatMessageNotification = notificationFunctions.sendChatMessageNotification;
exports.sendFriendRequestNotification = notificationFunctions.sendFriendRequestNotification;
exports.sendEncryptionNudgeNotification = notificationFunctions.sendEncryptionNudgeNotification;

exports.deleteAccountImmediately = accountFunctions.deleteAccountImmediately;
exports.scheduleAccountDeletion = accountFunctions.scheduleAccountDeletion;

exports.cleanupExpiredVideos = videoFunctions.cleanupExpiredVideos;
exports.cleanupExpiredArchivedVideos = videoFunctions.cleanupExpiredArchivedVideos;
exports.manualVideoCleanup = videoFunctions.manualVideoCleanup;
exports.manualArchivedVideoCleanup = videoFunctions.manualArchivedVideoCleanup;
exports.getCleanupStats = videoFunctions.getCleanupStats;
exports.deleteVideo = videoFunctions.deleteVideo;

exports.sendVerificationCode = verificationFunctions.sendVerificationCode;
exports.verifyCode = verificationFunctions.verifyCode;
exports.sendPasswordResetCode = verificationFunctions.sendPasswordResetCode;
exports.verifyPasswordResetCode = verificationFunctions.verifyPasswordResetCode;
exports.resetPasswordWithCode = verificationFunctions.resetPasswordWithCode;

exports.checkInactiveAccounts = inactiveFunctions.checkInactiveAccounts;
exports.manualInactiveAccountCheck = inactiveFunctions.manualInactiveAccountCheck;
exports.updateLastActive = inactiveFunctions.updateLastActive;
exports.getInactiveAccountStats = inactiveFunctions.getInactiveAccountStats;

exports.ingestLogs = loggingFunctions.ingestLogs;