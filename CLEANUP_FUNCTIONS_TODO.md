# Data Cleanup Functions - Future Implementation Guide

This document describes the remaining cleanup functions that need to be built for vlrb.
Each function is prioritized and includes specifications for implementation.

---

## MEDIUM Priority

### 1. `cleanupExpiredInviteCodes`

**Purpose:** Remove expired group invite codes to keep the database clean.

**Type:** Scheduled Pub/Sub Function

**Schedule:** Daily at 5:00 AM PT (after other cleanup jobs)

**Location:** New file `functions/inviteCodes.js` or add to existing `functions/groups.js`

**Logic:**
```
1. Query `groupInviteCodes` where `expiresAt <= now`
2. For each expired code:
   - Delete the document
   - Increment counter
3. Log results to `systemLogs/inviteCodeCleanup/runs`
```

**Firestore Query:**
```javascript
db.collection('groupInviteCodes')
  .where('expiresAt', '<=', admin.firestore.Timestamp.now())
  .limit(500)
```

**Return:** `{ success, codesDeleted, errors, duration }`

---

### 2. `cleanupOrphanedGroups`

**Purpose:** Handle groups where the creator has deleted their account.

**Type:** Scheduled Pub/Sub Function + Manual Callable

**Schedule:** Weekly (Sunday at 2:00 AM PT)

**Location:** New file `functions/groups.js`

**Logic:**
```
1. Query `groups` collection
2. For each group, check if `creatorId` exists in `users` OR `deletedUsers`
3. If creator is in `deletedUsers`:
   a. Check if group has other members
   b. If yes: Transfer ownership to longest-tenured member, notify them
   c. If no: Delete group and cascade:
      - Delete all `groupInviteCodes` where `groupId` matches
      - Delete group storage files (if any)
      - Delete group document
4. Log results
```

**Considerations:**
- Need to define group membership model (is there a `groupMembers` subcollection?)
- Ownership transfer notification via FCM
- May want admin approval before auto-transfer

**Return:** `{ success, groupsTransferred, groupsDeleted, errors }`

---

### 3. `cleanupExpiredVerificationCodes`

**Purpose:** Remove expired email verification and password reset codes.

**Type:** Scheduled Pub/Sub Function

**Schedule:** Daily at 5:30 AM PT

**Location:** Add to `functions/verification.js`

**Logic:**
```
1. Query `verificationCodes` where `expiresAt <= now`
2. Batch delete expired codes
3. Query `passwordResetCodes` where `expiresAt <= now`
4. Batch delete expired codes
5. Log results to `systemLogs/verificationCodeCleanup/runs`
```

**Firestore Queries:**
```javascript
// Verification codes
db.collection('verificationCodes')
  .where('expiresAt', '<=', now)
  .limit(500)

// Password reset codes
db.collection('passwordResetCodes')
  .where('expiresAt', '<=', now)
  .limit(500)
```

**Return:** `{ success, verificationCodesDeleted, resetCodesDeleted, duration }`

---

### 4. `cleanupOrphanedChats`

**Purpose:** Clean up chat documents and messages where both participants have deleted their accounts.

**Type:** Scheduled Pub/Sub Function

**Schedule:** Weekly (Sunday at 3:00 AM PT)

**Location:** Add to `functions/videos.js` or new `functions/chats.js`

**Logic:**
```
1. Query `chats` where `containsDeletedUser == true`
2. For each chat:
   a. Check both participants against `deletedUsers` collection
   b. If BOTH users are deleted:
      - Delete all messages in chat (with storage cleanup)
      - Delete chat settings subcollection
      - Delete chat document
3. Log results
```

**Firestore Query:**
```javascript
db.collection('chats')
  .where('containsDeletedUser', '==', true)
  .limit(100)
```

**Storage Cleanup:**
- For each message with `videoUrl` or `thumbnailUrl`, extract path and delete from Storage
- Use the existing `extractStoragePath` helper from videos.js

**Return:** `{ success, chatsDeleted, messagesDeleted, storageFilesDeleted, errors }`

---

## LOW Priority

### 5. `auditOrphanedStorageFiles`

**Purpose:** Find and optionally delete storage files that have no corresponding Firestore document.

**Type:** Callable Function (Admin only) - NOT scheduled due to cost/time

**Location:** New file `functions/storage.js`

**Logic:**
```
1. List all files in Storage bucket (paginated)
2. For each file path, determine the expected Firestore location:
   - `videos/{uid}/{videoId}` -> Check messages collection
   - `thumbnails/{uid}/{thumbnailId}` -> Check messages collection
   - `users/{uid}/avatars/{filename}` -> Check users collection
3. Query Firestore to verify document exists
4. If no document found, mark as orphaned
5. In non-dry-run mode, delete orphaned files
6. Generate report
```

**Parameters:**
- `dryRun: boolean` (default: true)
- `prefix: string` (optional - limit to specific folder like "videos/")
- `maxFiles: number` (default: 1000 - prevent runaway)

**Considerations:**
- This is expensive (Storage list operations + many Firestore reads)
- Should have strong rate limiting
- Consider running monthly at most
- Log extensively for audit trail

**Return:**
```javascript
{
  success,
  filesScanned,
  orphansFound,
  orphansDeleted, // 0 if dryRun
  totalSizeFreed,
  orphanedFiles: [{ path, size, lastModified }],
  duration
}
```

---

### 6. `updateChatPreviewsAfterCleanup`

**Purpose:** Fix `lastMessage` references in chats after video cleanup removes the referenced message.

**Type:** Enhancement to existing `cleanupExpiredVideos` function

**Location:** Modify `functions/videos.js`

**Logic:**
After marking a message as `contentRemoved`:
```
1. Check if this message is the `lastMessage` on the parent chat
2. If yes:
   a. Query for the next most recent non-removed message
   b. Update chat's `lastMessage` field
   c. If no valid messages remain, set `lastMessage` to null
```

**Implementation Notes:**
- Could be done inline during cleanup (adds latency)
- Or as a separate batch job after cleanup completes
- Need to track which chats were affected during cleanup

**Alternative Approach:**
Instead of fixing after cleanup, modify client to:
- Query for latest message where `contentRemoved != true`
- Handle null/missing lastMessage gracefully

---

### 7. `cleanupStaleUserFriendships`

**Purpose:** Clean up `userFriendships` entries that point to deleted users.

**Type:** Scheduled Pub/Sub Function

**Schedule:** Weekly (Sunday at 4:00 AM PT)

**Location:** Add to `functions/friends.js`

**Logic:**
```
1. Query `deletedUsers` collection (get list of deleted user IDs)
2. For each deleted user ID:
   a. Query all userFriendships docs where a friend entry references this ID
   b. Delete those friend entries
3. Log results
```

**Note:** This is partially handled by `deleteAccountImmediately` now, but this catches any missed entries.

**Return:** `{ success, entriesDeleted, errors }`

---

## Implementation Order Recommendation

1. **cleanupExpiredVerificationCodes** - Quick win, simple implementation
2. **cleanupExpiredInviteCodes** - Simple, similar pattern
3. **cleanupOrphanedChats** - Important for storage costs
4. **cleanupOrphanedGroups** - Needed before groups feature expands
5. **cleanupStaleUserFriendships** - Nice to have, catches edge cases
6. **updateChatPreviewsAfterCleanup** - UX improvement
7. **auditOrphanedStorageFiles** - Complex, run manually when needed

---

## Shared Patterns

All cleanup functions should follow these patterns:

### Logging
```javascript
await db.collection('systemLogs')
  .doc('functionName')
  .collection('runs')
  .add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    triggeredBy: triggeredBy,
    ...results
  });
```

### Error Handling
```javascript
await db.collection('systemLogs')
  .doc('functionName')
  .collection('errors')
  .add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    error: error.message,
    stack: error.stack,
    triggeredBy: triggeredBy
  });
```

### Batch Sizing
- Firestore batch limit: 500 operations
- Process in batches of 100-500 depending on complexity
- Include pagination for large datasets

### Dry Run Mode
- All cleanup functions should support `dryRun` parameter
- Dry run should log what WOULD be deleted without deleting
- Manual triggers should default to `dryRun: true`

### Admin-Only Callable Functions
```javascript
const userDoc = await db.collection('users').doc(request.auth.uid).get();
if (!userDoc.exists || !userDoc.data().isAdmin) {
  throw new HttpsError('permission-denied', 'Admin access required');
}
```

---

## Daily Cleanup Schedule Summary

| Time (PT) | Function | Purpose |
|-----------|----------|---------|
| 2:00 AM | cleanupExpiredVideos | Soft-delete expired video messages |
| 3:00 AM | checkInactiveAccounts | Notify inactive users |
| 3:00 AM | cleanupExpiredArchivedVideos | Hard-delete archived videos |
| 4:00 AM | executeScheduledDeletions | Delete accounts past deletion date |
| 5:00 AM | cleanupExpiredInviteCodes | Delete expired invite codes |
| 5:30 AM | cleanupExpiredVerificationCodes | Delete expired verification codes |

## Weekly Cleanup Schedule Summary

| Day | Time (PT) | Function | Purpose |
|-----|-----------|----------|---------|
| Sunday | 2:00 AM | cleanupOrphanedGroups | Handle creator-deleted groups |
| Sunday | 3:00 AM | cleanupOrphanedChats | Delete chats where both users gone |
| Sunday | 4:00 AM | cleanupStaleUserFriendships | Clean up friend references |
