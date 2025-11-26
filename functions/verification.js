const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const mailgun = require('mailgun-js');

const mailgunApiKey = defineSecret('MAILGUN_API_KEY');
const mailgunDomain = "mail.vlrb.app"

module.exports = (firebaseHelper) => {
    const { admin, db } = firebaseHelper;
    return {
        sendVerificationCode: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [mailgunApiKey]
        }, async (request) => {
            // Configure Mailgun
            const mg = mailgun({
                apiKey: mailgunApiKey.value(),
                domain: mailgunDomain
            });

            try {
                if (!request.auth) {
                    throw new HttpsError('unauthenticated', 'User must be authenticated');
                }

                const { email } = request.data;
                const userId = request.auth.uid;

                if (!email) {
                    throw new HttpsError('invalid-argument', 'Email is required');
                }

                // Generate 6-digit code
                const code = Math.floor(100000 + Math.random() * 900000).toString();

                // Store code in Firestore
                await db.collection('verificationCodes').doc(userId).set({
                    code: code,
                    email: email,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 15 * 60 * 1000)),
                    attempts: 0,
                    verified: false
                });

                // iOS Smart Detection Format
                const emailBody = `Your VLRB verification code is: ${code}

This code expires in 15 minutes.

If you didn't request this code, please ignore this email.

VLRB Team`;

                // Send via Mailgun
                const mailData = {
                    from: 'VLRB <noreply@vlrb.app>',
                    to: email,
                    subject: `${code} is your VLRB verification code`,
                    text: emailBody,
                    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Verify Your Email</h2>
              <p>Your VLRB verification code is:</p>
              <div style="font-size: 32px; font-weight: bold; color: #007AFF; letter-spacing: 4px; text-align: center; margin: 20px 0; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
                ${code}
              </div>
              <p>This code expires in 15 minutes.</p>
              <p>If you didn't request this code, please ignore this email.</p>
              <p>Thanks,<br>VLRB Team</p>
            </div>
          `
                };

                await new Promise((resolve, reject) => {
                    mg.messages().send(mailData, (error, body) => {
                        if (error) reject(error);
                        else resolve(body);
                    });
                });

                console.log(`✅ Verification code sent to ${email} via Mailgun`);
                return { success: true, message: 'Verification code sent' };

            } catch (error) {
                console.error('Error sending verification code:', error);
                throw new HttpsError('internal', 'Failed to send verification code');
            }
        }),
        verifyCode: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60
        }, async (request) => {
            try {
                if (!request.auth) {
                    throw new HttpsError('unauthenticated', 'User must be authenticated');
                }

                const { code } = request.data;
                const userId = request.auth.uid;

                if (!code || code.length !== 6) {
                    throw new HttpsError('invalid-argument', 'Valid 6-digit code is required');
                }

                // Get stored code
                const codeDoc = await db.collection('verificationCodes').doc(userId).get();

                if (!codeDoc.exists) {
                    throw new HttpsError('not-found', 'No verification code found. Please request a new one.');
                }

                const codeData = codeDoc.data();

                // Check if already verified
                if (codeData.verified) {
                    throw new HttpsError('already-exists', 'This code has already been used');
                }

                // Check if code is expired
                if (new Date() > codeData.expiresAt.toDate()) {
                    throw new HttpsError('deadline-exceeded', 'Verification code has expired. Please request a new one.');
                }

                // Check attempts limit
                if (codeData.attempts >= 3) {
                    throw new HttpsError('resource-exhausted', 'Too many failed attempts. Please request a new code.');
                }

                // Verify code
                if (code !== codeData.code) {
                    // Increment attempts
                    await db.collection('verificationCodes').doc(userId).update({
                        attempts: admin.firestore.FieldValue.increment(1)
                    });

                    const attemptsLeft = 3 - (codeData.attempts + 1);
                    throw new HttpsError('invalid-argument', `Invalid verification code. ${attemptsLeft} attempts remaining.`);
                }

                // Code is correct - mark user as verified
                await db.collection('users').doc(userId).update({
                    isEmailVerified: true,
                    emailVerifiedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Mark code as used
                await db.collection('verificationCodes').doc(userId).update({
                    verified: true,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`✅ User ${userId} successfully verified email`);
                return { success: true, message: 'Email verified successfully' };

            } catch (error) {
                console.error('Error verifying code:', error);
                throw error;
            }
        }),
        // Add these to the return object in verification.js

        sendPasswordResetCode: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [mailgunApiKey]
        }, async (request) => {
            try {
                const { email } = request.data;

                if (!email) {
                    throw new HttpsError('invalid-argument', 'Email is required');
                }

                // Check if user exists with this email
                let userRecord;
                try {
                    userRecord = await admin.auth().getUserByEmail(email);
                } catch (error) {
                    // Don't reveal if email exists or not for security
                    console.log(`Password reset requested for non-existent email: ${email}`);
                    return { success: true, message: 'If an account exists with this email, a reset code has been sent' };
                }

                // Generate 6-digit code
                const code = Math.floor(100000 + Math.random() * 900000).toString();

                // Store code in Firestore with expiration
                await db.collection('passwordResetCodes').doc(userRecord.uid).set({
                    code: code,
                    email: email,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 15 * 60 * 1000)), // 15 minutes
                    attempts: 0,
                    used: false
                });

                // Configure Mailgun
                const mg = mailgun({
                    apiKey: mailgunApiKey.value(),
                    domain: mailgunDomain
                });

                // iOS Smart Detection Format for password reset
                const emailBody = `Your VLRB password reset code is: ${code}

This code expires in 15 minutes.

If you didn't request a password reset, please ignore this email.

VLRB Team`;

                // Send via Mailgun
                const mailData = {
                    from: 'VLRB <noreply@vlrb.app>',
                    to: email,
                    subject: `${code} is your VLRB password reset code`,
                    text: emailBody,
                    html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Reset Your Password</h2>
          <p>Your VLRB password reset code is:</p>
          <div style="font-size: 32px; font-weight: bold; color: #007AFF; letter-spacing: 4px; text-align: center; margin: 20px 0; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
            ${code}
          </div>
          <p>This code expires in 15 minutes.</p>
          <p>If you didn't request a password reset, please ignore this email.</p>
          <p>Thanks,<br>VLRB Team</p>
        </div>
      `
                };

                await new Promise((resolve, reject) => {
                    mg.messages().send(mailData, (error, body) => {
                        if (error) reject(error);
                        else resolve(body);
                    });
                });

                console.log(`✅ Password reset code sent to ${email}`);
                return { success: true, message: 'If an account exists with this email, a reset code has been sent' };

            } catch (error) {
                console.error('Error sending password reset code:', error);
                throw new HttpsError('internal', 'Failed to send password reset code');
            }
        }),

        verifyPasswordResetCode: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60
        }, async (request) => {
            try {
                const { email, code } = request.data;

                if (!email || !code || code.length !== 6) {
                    throw new HttpsError('invalid-argument', 'Email and valid 6-digit code are required');
                }

                // Get user by email
                let userRecord;
                try {
                    userRecord = await admin.auth().getUserByEmail(email);
                } catch (error) {
                    throw new HttpsError('not-found', 'Invalid email or code');
                }

                // Get stored code
                const codeDoc = await db.collection('passwordResetCodes').doc(userRecord.uid).get();

                if (!codeDoc.exists) {
                    throw new HttpsError('not-found', 'No password reset code found. Please request a new one.');
                }

                const codeData = codeDoc.data();

                // Check if already used
                if (codeData.used) {
                    throw new HttpsError('already-exists', 'This reset code has already been used');
                }

                // Check if code is expired
                if (new Date() > codeData.expiresAt.toDate()) {
                    throw new HttpsError('deadline-exceeded', 'Reset code has expired. Please request a new one.');
                }

                // Check attempts limit
                if (codeData.attempts >= 3) {
                    throw new HttpsError('resource-exhausted', 'Too many failed attempts. Please request a new code.');
                }

                // Verify code and email match
                if (code !== codeData.code || email !== codeData.email) {
                    // Increment attempts
                    await db.collection('passwordResetCodes').doc(userRecord.uid).update({
                        attempts: admin.firestore.FieldValue.increment(1)
                    });

                    const attemptsLeft = 3 - (codeData.attempts + 1);
                    throw new HttpsError('invalid-argument', `Invalid code or email. ${attemptsLeft} attempts remaining.`);
                }

                // Mark code as used
                await db.collection('passwordResetCodes').doc(userRecord.uid).update({
                    used: true,
                    usedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`✅ Password reset code verified for ${email}`);
                return { success: true, message: 'Reset code verified successfully', uid: userRecord.uid };

            } catch (error) {
                console.error('Error verifying password reset code:', error);
                throw error;
            }
        }),

        resetPasswordWithCode: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60
        }, async (request) => {
            try {
                const { email, code, newPassword } = request.data;

                if (!email || !code || !newPassword) {
                    throw new HttpsError('invalid-argument', 'Email, code, and new password are required');
                }

                if (newPassword.length < 6) {
                    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters');
                }

                // Get user by email first
                let userRecord;
                try {
                    userRecord = await admin.auth().getUserByEmail(email);
                } catch (error) {
                    throw new HttpsError('not-found', 'Invalid email or code');
                }

                // Use transaction to prevent race conditions
                return await db.runTransaction(async (transaction) => {
                    const codeRef = db.collection('passwordResetCodes').doc(userRecord.uid);
                    const codeDoc = await transaction.get(codeRef);

                    if (!codeDoc.exists) {
                        throw new HttpsError('not-found', 'No password reset code found. Please request a new one.');
                    }

                    const codeData = codeDoc.data();

                    // Check if already used
                    if (codeData.used) {
                        throw new HttpsError('already-exists', 'This reset code has already been used');
                    }

                    // Check if code is expired
                    if (new Date() > codeData.expiresAt.toDate()) {
                        throw new HttpsError('deadline-exceeded', 'Reset code has expired. Please request a new one.');
                    }

                    // Check attempts limit
                    if (codeData.attempts >= 3) {
                        throw new HttpsError('resource-exhausted', 'Too many failed attempts. Please request a new code.');
                    }

                    // Verify code and email match
                    if (code !== codeData.code || email !== codeData.email) {
                        // Increment attempts in transaction
                        transaction.update(codeRef, {
                            attempts: admin.firestore.FieldValue.increment(1)
                        });

                        const attemptsLeft = 3 - (codeData.attempts + 1);
                        throw new HttpsError('invalid-argument', `Invalid code or email. ${attemptsLeft} attempts remaining.`);
                    }

                    // Mark as used BEFORE updating password
                    transaction.update(codeRef, {
                        used: true,
                        usedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    return codeData; // Return for password update outside transaction
                }).then(async (codeData) => {
                    // Update password outside transaction
                    await admin.auth().updateUser(userRecord.uid, {
                        password: newPassword
                    });

                    // Clean up the code completely after successful password update
                    await db.collection('passwordResetCodes').doc(userRecord.uid).delete();

                    console.log(`✅ Password successfully reset for ${email}`);
                    return { success: true, message: 'Password reset successfully' };
                });

            } catch (error) {
                console.error('Error resetting password:', error);
                throw error;
            }
        })
    };
};