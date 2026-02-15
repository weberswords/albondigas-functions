#!/usr/bin/env node

/**
 * Admin Account Deletion Script
 *
 * Run this from Google Cloud Shell to delete user accounts.
 * Uses Application Default Credentials (automatic in Cloud Shell).
 *
 * Usage:
 *   node scripts/admin-delete-accounts.js <uid1> [uid2] [uid3] ...
 *   node scripts/admin-delete-accounts.js --dry-run <uid1> [uid2] ...
 *   node scripts/admin-delete-accounts.js --file uids.txt
 *
 * Options:
 *   --dry-run   Show what would be deleted without actually deleting
 *   --file      Read UIDs from a text file (one UID per line)
 *   --yes       Skip confirmation prompt
 */

const admin = require('firebase-admin');
const readline = require('readline');

const PROJECT_ID = 'albondigas-8cfd9';
const STORAGE_BUCKET = `${PROJECT_ID}.appspot.com`;

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = { dryRun: false, skipConfirm: false, file: null, uids: [] };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--yes') {
      options.skipConfirm = true;
    } else if (args[i] === '--file') {
      options.file = args[++i];
    } else if (!args[i].startsWith('--')) {
      options.uids.push(args[i]);
    }
  }

  return options;
}

async function loadUidsFromFile(filePath) {
  const fs = require('fs');
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const options = parseArgs();

  // Load UIDs from file if specified
  if (options.file) {
    const fileUids = await loadUidsFromFile(options.file);
    options.uids.push(...fileUids);
  }

  if (options.uids.length === 0) {
    console.log('Usage: node scripts/admin-delete-accounts.js [--dry-run] [--yes] [--file uids.txt] <uid1> [uid2] ...');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run   Preview what would be deleted without deleting');
    console.log('  --file      Read UIDs from a text file (one per line, # for comments)');
    console.log('  --yes       Skip confirmation prompt');
    process.exit(1);
  }

  // Initialize Firebase Admin SDK
  admin.initializeApp({
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
  });

  const db = admin.firestore();

  // Import the account module with our initialized admin/db
  const accountModule = require('../functions/account.js')({ admin, db });

  if (options.dryRun) {
    console.log('\n=== DRY RUN MODE - No data will be deleted ===\n');
  }

  // Look up each UID and show what we found
  console.log(`Found ${options.uids.length} UID(s) to process:\n`);
  const usersToDelete = [];

  for (const uid of options.uids) {
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      console.log(`  ${uid} - ${data.displayName || 'No display name'} (${data.email || 'no email'})`);
      usersToDelete.push({ uid, displayName: data.displayName, email: data.email });
    } else {
      // Check if already deleted
      const deletedDoc = await db.collection('deletedUsers').doc(uid).get();
      if (deletedDoc.exists) {
        console.log(`  ${uid} - ALREADY DELETED (skipping)`);
      } else {
        // Check if Auth user exists even without Firestore doc
        try {
          const authUser = await admin.auth().getUser(uid);
          console.log(`  ${uid} - Auth-only user: ${authUser.email || 'no email'} (no Firestore doc)`);
          usersToDelete.push({ uid, displayName: 'Auth-only', email: authUser.email });
        } catch {
          console.log(`  ${uid} - NOT FOUND anywhere (skipping)`);
        }
      }
    }
  }

  if (usersToDelete.length === 0) {
    console.log('\nNo valid accounts to delete.');
    process.exit(0);
  }

  if (options.dryRun) {
    console.log(`\n=== DRY RUN COMPLETE ===`);
    console.log(`Would delete ${usersToDelete.length} account(s).`);
    console.log('Run again without --dry-run to perform the deletion.');
    process.exit(0);
  }

  // Confirm before deleting
  if (!options.skipConfirm) {
    const answer = await prompt(`\nDelete ${usersToDelete.length} account(s)? This cannot be undone. (yes/no): `);
    if (answer !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Perform deletions
  console.log(`\nDeleting ${usersToDelete.length} account(s)...\n`);
  const allResults = [];

  for (const user of usersToDelete) {
    console.log(`--- Deleting ${user.uid} (${user.displayName || user.email || 'unknown'}) ---`);
    try {
      const results = await accountModule.deleteUserData(user.uid, { deleteAuthUser: true });
      allResults.push({ ...results, success: true });
      console.log(`  Friendships updated: ${results.friendshipsUpdated}`);
      console.log(`  Chats updated: ${results.chatsUpdated}`);
      console.log(`  Messages updated: ${results.messagesUpdated}`);
      console.log(`  Storage paths deleted: ${results.storageDeleted.join(', ') || 'none'}`);
      if (results.errors.length > 0) {
        console.log(`  Warnings: ${results.errors.join(', ')}`);
      }
      console.log(`  DONE\n`);
    } catch (error) {
      console.error(`  FAILED: ${error.message}\n`);
      allResults.push({ uid: user.uid, success: false, error: error.message });
    }
  }

  // Summary
  const succeeded = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;
  console.log('=== SUMMARY ===');
  console.log(`  Deleted: ${succeeded}`);
  console.log(`  Failed:  ${failed}`);

  if (failed > 0) {
    console.log('\nFailed UIDs:');
    allResults.filter(r => !r.success).forEach(r => {
      console.log(`  ${r.uid}: ${r.error}`);
    });
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
