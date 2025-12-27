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
const signupFunctions = require('./signup.js')(firebaseHelper);
// Pass accountFunctions to inactive so it can use deleteUserData
const inactiveFunctions = require('./inactive.js')(firebaseHelper, accountFunctions);
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

// Signup functions (email-first verification flow)
exports.initiateSignup = signupFunctions.initiateSignup;
exports.verifySignupToken = signupFunctions.verifySignupToken;
exports.verifySignupTokenHttp = signupFunctions.verifySignupTokenHttp;
exports.completeSignup = signupFunctions.completeSignup;
exports.resendSignupLink = signupFunctions.resendSignupLink;
exports.checkSignupVerification = signupFunctions.checkSignupVerification;
exports.cleanupPendingRegistrations = signupFunctions.cleanupPendingRegistrations;

exports.checkInactiveAccounts = inactiveFunctions.checkInactiveAccounts;
exports.manualInactiveAccountCheck = inactiveFunctions.manualInactiveAccountCheck;
exports.updateLastActive = inactiveFunctions.updateLastActive;
exports.getInactiveAccountStats = inactiveFunctions.getInactiveAccountStats;
exports.executeScheduledDeletions = inactiveFunctions.executeScheduledDeletions;
exports.manualExecuteScheduledDeletions = inactiveFunctions.manualExecuteScheduledDeletions;

exports.ingestLogs = loggingFunctions.ingestLogs;