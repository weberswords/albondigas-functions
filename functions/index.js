const admin = require('firebase-admin');

// Import service account
const serviceAccount = require('./firebase_admin.json');

// Initialize admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Initialize Firestore ONCE
const db = admin.firestore(); // This line was missing

// Create a helper object
const firebaseHelper = { admin, db };

// Import function modules with the helper
const friendFunctions = require('./friends.js')(firebaseHelper);
const notificationFunctions = require('./notifications.js')(firebaseHelper);

// Export all functions
exports.acceptFriendRequest = friendFunctions.acceptFriendRequest;
exports.rejectFriendRequest = friendFunctions.rejectFriendRequest;
exports.unfriend = friendFunctions.unfriend;
exports.blockUser = friendFunctions.blockUser;
exports.checkFriendshipStatus = friendFunctions.checkFriendshipStatus
exports.repairFriendshipState = friendFunctions.repairFriendshipState

exports.sendChatMessageNotification = notificationFunctions.sendChatMessageNotification;
exports.sendFriendRequestNotification = notificationFunctions.sendFriendRequestNotification;