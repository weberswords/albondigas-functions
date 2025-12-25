# Data Cleanup Functions - Implementation Complete

All data cleanup functions have been implemented. This document serves as reference documentation for the cleanup system.

---

## Complete Cleanup Schedule

### Daily Schedule (PT Timezone)

| Time | Function | File | Purpose |
|------|----------|------|---------|
| 2:00 AM | `cleanupExpiredVideos` | videos.js | Soft-delete expired video messages |
| 3:00 AM | `checkInactiveAccounts` | inactive.js | Notify inactive users (365 days) |
| 3:00 AM | `cleanupExpiredArchivedVideos` | videos.js | Hard-delete archived videos |
| 4:00 AM | `executeScheduledDeletions` | inactive.js | Delete accounts past deletion date |
| 5:00 AM | `cleanupExpiredInviteCodes` | groups.js | Delete expired group invite codes |
| 5:30 AM | `cleanupExpiredVerificationCodes` | verification.js | Delete expired verification codes |

### Weekly Schedule (Sunday, PT Timezone)

| Time | Function | File | Purpose |
|------|----------|------|---------|
| 2:00 AM | `cleanupOrphanedGroups` | groups.js | Handle groups where creator deleted account |
| 3:00 AM | `cleanupOrphanedChats` | videos.js | Delete chats where both users are gone |
| 4:00 AM | `cleanupStaleUserFriendships` | friends.js | Clean up friend refs to deleted users |

### Manual Only (Admin Callable)

| Function | File | Purpose |
|----------|------|---------|
| `auditOrphanedStorageFiles` | storage.js | Find storage files with no Firestore doc |
| `getStorageAuditStats` | storage.js | View recent storage audit results |

---

## Function Details

### 1. Video Cleanup Functions (videos.js)

#### `cleanupExpiredVideos`
- **Schedule:** Daily at 2:00 AM
- **Action:** Soft-deletes messages where `expiresAt <= now`
- **Sets:** `contentRemoved: true`, nullifies URLs
- **Logs to:** `systemLogs/videoCleanup/runs`

#### `cleanupExpiredArchivedVideos`
- **Schedule:** Daily at 3:00 AM
- **Action:** Hard-deletes archived videos (from unfriend)
- **Deletes:** Storage files and Firestore documents
- **Logs to:** `systemLogs/archivedVideoCleanup/runs`

#### `cleanupOrphanedChats`
- **Schedule:** Weekly Sunday at 3:00 AM
- **Action:** Deletes chats where ALL participants have deleted accounts
- **Deletes:** Messages, storage files, settings, chat document
- **Logs to:** `systemLogs/orphanedChatCleanup/runs`

### 2. Account Cleanup Functions

#### `deleteAccountImmediately` (account.js)
- **Trigger:** User-initiated callable
- **Cascade:**
  - Creates placeholder in `deletedUsers`
  - Marks friendships with `containsDeletedUser`
  - Soft-deletes messages (nullifies URLs)
  - Deletes `userFriendships/{uid}/friends/*`
  - Deletes user subcollections (`security`, `pendingDeviceVerifications`)
  - Deletes `verificationCodes/{uid}`, `passwordResetCodes/{uid}`
  - Deletes storage: `videos/{uid}/`, `thumbnails/{uid}/`, `users/{uid}/avatars/`
  - Deletes `notificationSettings/{uid}`
  - Deletes Firebase Auth user
  - Deletes user document

#### `executeScheduledDeletions` (inactive.js)
- **Schedule:** Daily at 4:00 AM
- **Action:** Deletes accounts where `scheduledForDeletion == true` AND `deletionDate <= now`
- **Uses:** `deleteUserData` from account.js
- **Logs to:** `systemLogs/scheduledDeletions/runs`

#### `checkInactiveAccounts` (inactive.js)
- **Schedule:** Daily at 3:00 AM
- **Action:** Notifies users inactive for 365+ days
- **Sets:** `scheduledForDeletion: true`, `deletionDate: now + 30 days`
- **Logs to:** `systemLogs/inactiveAccountNotifications/runs`

### 3. Verification Code Cleanup (verification.js)

#### `cleanupExpiredVerificationCodes`
- **Schedule:** Daily at 5:30 AM
- **Action:** Deletes expired `verificationCodes` and `passwordResetCodes`
- **Logs to:** `systemLogs/verificationCodeCleanup/runs`

### 4. Group Functions (groups.js)

#### `cleanupExpiredInviteCodes`
- **Schedule:** Daily at 5:00 AM
- **Action:** Deletes `groupInviteCodes` where `expiresAt <= now`
- **Logs to:** `systemLogs/inviteCodeCleanup/runs`

#### `cleanupOrphanedGroups`
- **Schedule:** Weekly Sunday at 2:00 AM
- **Action:** Handles groups where creator deleted account
- **Logic:**
  - If group has other members: Transfer ownership
  - If no members: Delete group and invite codes
- **Logs to:** `systemLogs/orphanedGroupCleanup/runs`

### 5. Friendship Cleanup (friends.js)

#### `cleanupStaleUserFriendships`
- **Schedule:** Weekly Sunday at 4:00 AM
- **Action:** Removes friend entries pointing to deleted users
- **Logs to:** `systemLogs/staleUserFriendshipsCleanup/runs`

### 6. Storage Audit (storage.js)

#### `auditOrphanedStorageFiles`
- **Type:** Manual admin callable only (not scheduled due to cost)
- **Action:** Lists storage files and checks for Firestore references
- **Options:**
  - `dryRun: true` (default) - Report only
  - `maxFiles: 500` - Limit files to scan
  - `prefix: 'videos/'` - Limit to specific folder
- **Logs to:** `systemLogs/storageAudit/runs`

---

## Admin Manual Triggers

All scheduled functions have manual admin triggers with dry-run support:

| Scheduled Function | Manual Trigger | Default Dry Run |
|--------------------|----------------|-----------------|
| `cleanupExpiredVideos` | `manualVideoCleanup` | true |
| `cleanupExpiredArchivedVideos` | `manualArchivedVideoCleanup` | true |
| `cleanupOrphanedChats` | `manualOrphanedChatCleanup` | true |
| `checkInactiveAccounts` | `manualInactiveAccountCheck` | true |
| `executeScheduledDeletions` | `manualExecuteScheduledDeletions` | true |
| `cleanupExpiredInviteCodes` | `manualInviteCodeCleanup` | true |
| `cleanupExpiredVerificationCodes` | `manualVerificationCodeCleanup` | true |
| `cleanupOrphanedGroups` | `manualOrphanedGroupCleanup` | true |
| `cleanupStaleUserFriendships` | `manualStaleUserFriendshipsCleanup` | true |
| N/A | `auditOrphanedStorageFiles` | true |

---

## Logging Pattern

All cleanup functions log to `systemLogs/{functionName}/runs` with:
```javascript
{
  success: true,
  // Function-specific counts
  dryRun: boolean,
  triggeredBy: 'scheduled' | 'user:{uid}',
  duration: number,
  timestamp: FieldValue.serverTimestamp()
}
```

Errors log to `systemLogs/{functionName}/errors` with:
```javascript
{
  timestamp: FieldValue.serverTimestamp(),
  error: string,
  stack: string,
  triggeredBy: string
}
```

---

## Firestore Indexes Required

The following indexes may need to be created for optimal performance:

1. `users` collection:
   - `scheduledForDeletion` + `deletionDate`
   - `lastActive` + `scheduledForDeletion`

2. `chats` collection:
   - `containsDeletedUser`

3. `groupInviteCodes` collection:
   - `expiresAt`

4. `verificationCodes` / `passwordResetCodes` collections:
   - `expiresAt`

5. `friendships` collection:
   - `userIds` (array-contains)

---

## Notes

- All scheduled functions run in `America/Los_Angeles` timezone
- All manual triggers require admin privileges (`isAdmin: true` on user doc)
- All manual triggers default to `dryRun: true` for safety
- Batch sizes are configurable but have sensible defaults
- Functions are designed to be idempotent and safe to retry
