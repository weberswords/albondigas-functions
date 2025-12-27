const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const mailgun = require('mailgun-js');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const mailgunApiKey = defineSecret('MAILGUN_API_KEY');
const jwtSecret = defineSecret('JWT_SIGNING_SECRET');
const mailgunDomain = "mail.vlrb.app";

// Constants
const MAGIC_LINK_EXPIRY_MINUTES = 15;
const VERIFICATION_TOKEN_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// CORS configuration
const ALLOWED_ORIGINS = [
    'https://vlrb.app',
    'http://localhost:3000',
    'http://localhost:5000'
];

/**
 * Set CORS headers on response
 */
function setCorsHeaders(res, origin) {
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
}

/**
 * Generate SHA256 hash of email (lowercase, trimmed)
 */
function generateEmailHash(email) {
    const normalizedEmail = email.toLowerCase().trim();
    return crypto.createHash('sha256').update(normalizedEmail).digest('hex');
}

/**
 * Validate email format
 */
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Generate a signed JWT token
 */
function generateToken(payload, secret, expiresInMinutes) {
    return jwt.sign(payload, secret, { expiresIn: `${expiresInMinutes}m` });
}

/**
 * Verify and decode a JWT token
 */
function verifyToken(token, secret) {
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            throw new HttpsError('deadline-exceeded', 'Token has expired');
        }
        throw new HttpsError('invalid-argument', 'Invalid token');
    }
}

module.exports = (firebaseHelper) => {
    const { admin, db } = firebaseHelper;

    return {
        /**
         * initiateSignup - Start the email-first signup flow
         *
         * Sends a magic link to the user's email for verification.
         * Does not reveal whether email already exists (enumeration protection).
         */
        initiateSignup: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [mailgunApiKey, jwtSecret]
        }, async (request) => {
            const mg = mailgun({
                apiKey: mailgunApiKey.value(),
                domain: mailgunDomain
            });

            try {
                const { email } = request.data;

                if (!email || !isValidEmail(email)) {
                    throw new HttpsError('invalid-argument', 'Valid email is required');
                }

                const normalizedEmail = email.toLowerCase().trim();
                const emailHash = generateEmailHash(normalizedEmail);

                // Check if email already exists in Firebase Auth
                // If so, return same response (enumeration protection)
                try {
                    await admin.auth().getUserByEmail(normalizedEmail);
                    // Email exists - return same success response
                    console.log(`initiateSignup: Email already registered: ${emailHash.substring(0, 8)}...`);
                    return { success: true, message: 'Check your email' };
                } catch (authError) {
                    // Email doesn't exist - continue with signup flow
                    if (authError.code !== 'auth/user-not-found') {
                        throw authError;
                    }
                }

                // Check for existing pending registration and rate limiting
                const pendingRef = db.collection('pendingRegistrations').doc(emailHash);
                const pendingDoc = await pendingRef.get();

                if (pendingDoc.exists) {
                    const data = pendingDoc.data();

                    // Check if already verified - let them resume instead of rate limiting
                    if (data.verified) {
                        // Try to use existing verification token if still valid
                        if (data.verificationToken) {
                            try {
                                jwt.verify(data.verificationToken, jwtSecret.value());
                                console.log(`initiateSignup: Resuming verified signup for ${emailHash.substring(0, 8)}...`);
                                return {
                                    success: true,
                                    alreadyVerified: true,
                                    verificationToken: data.verificationToken,
                                    email: data.email
                                };
                            } catch {
                                // Token expired, generate a new one below
                            }
                        }

                        // Generate fresh verification token
                        const verificationToken = generateToken(
                            {
                                email: data.email,
                                emailHash: emailHash,
                                purpose: 'complete_signup'
                            },
                            jwtSecret.value(),
                            VERIFICATION_TOKEN_EXPIRY_MINUTES
                        );

                        await pendingRef.update({
                            verificationToken: verificationToken
                        });

                        console.log(`initiateSignup: Refreshed verification token for ${emailHash.substring(0, 8)}...`);
                        return {
                            success: true,
                            alreadyVerified: true,
                            verificationToken: verificationToken,
                            email: data.email
                        };
                    }

                    const lastAttemptAt = data.lastAttemptAt?.toDate() || new Date(0);
                    const hourAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

                    // Check rate limiting - max 3 attempts per hour
                    if (lastAttemptAt > hourAgo && data.attempts >= MAX_ATTEMPTS_PER_HOUR) {
                        throw new HttpsError(
                            'resource-exhausted',
                            'Too many signup attempts. Please try again later.'
                        );
                    }

                    // Reset attempts if outside rate limit window
                    const currentAttempts = lastAttemptAt > hourAgo ? data.attempts : 0;

                    // Generate new magic link token
                    const magicLinkToken = generateToken(
                        {
                            email: normalizedEmail,
                            emailHash: emailHash,
                            purpose: 'signup'
                        },
                        jwtSecret.value(),
                        MAGIC_LINK_EXPIRY_MINUTES
                    );

                    // Update existing record
                    await pendingRef.update({
                        magicLinkToken: magicLinkToken,
                        expiresAt: admin.firestore.Timestamp.fromDate(
                            new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)
                        ),
                        attempts: currentAttempts + 1,
                        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
                        verified: false,
                        verifiedAt: null,
                        verificationToken: null
                    });

                    // Send email
                    await sendMagicLinkEmail(mg, normalizedEmail, magicLinkToken);

                    console.log(`initiateSignup: Updated pending registration for ${emailHash.substring(0, 8)}...`);
                    return { success: true, message: 'Check your email' };
                }

                // Create new pending registration
                const magicLinkToken = generateToken(
                    {
                        email: normalizedEmail,
                        emailHash: emailHash,
                        purpose: 'signup'
                    },
                    jwtSecret.value(),
                    MAGIC_LINK_EXPIRY_MINUTES
                );

                await pendingRef.set({
                    email: normalizedEmail,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromDate(
                        new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)
                    ),
                    magicLinkToken: magicLinkToken,
                    verified: false,
                    verifiedAt: null,
                    verificationToken: null,
                    attempts: 1,
                    lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Send magic link email
                await sendMagicLinkEmail(mg, normalizedEmail, magicLinkToken);

                console.log(`initiateSignup: Created pending registration for ${emailHash.substring(0, 8)}...`);
                return { success: true, message: 'Check your email' };

            } catch (error) {
                if (error instanceof HttpsError) {
                    throw error;
                }
                console.error('Error in initiateSignup:', error);
                throw new HttpsError('internal', 'Failed to initiate signup');
            }
        }),

        /**
         * Core verification logic - shared between onCall and HTTP endpoints
         * Returns { success, verificationToken, email } or throws an error object
         */
        _verifySignupTokenCore: async function(token, secret) {
            if (!token) {
                throw { code: 'invalid', message: 'Token is required' };
            }

            // Verify JWT signature and expiration
            let decoded;
            try {
                decoded = jwt.verify(token, secret);
            } catch (error) {
                if (error.name === 'TokenExpiredError') {
                    throw { code: 'expired', message: 'Token has expired' };
                }
                throw { code: 'invalid', message: 'Invalid token' };
            }

            if (decoded.purpose !== 'signup') {
                throw { code: 'invalid', message: 'Invalid token purpose' };
            }

            const { emailHash, email } = decoded;

            // Look up pending registration
            const pendingRef = db.collection('pendingRegistrations').doc(emailHash);
            const pendingDoc = await pendingRef.get();

            if (!pendingDoc.exists) {
                throw { code: 'invalid', message: 'Signup request not found or expired' };
            }

            const pendingData = pendingDoc.data();

            // Verify token matches stored token
            if (pendingData.magicLinkToken !== token) {
                throw { code: 'invalid', message: 'Invalid or outdated link' };
            }

            // Check if already verified
            if (pendingData.verified) {
                // Return existing verification token if still valid
                if (pendingData.verificationToken) {
                    try {
                        jwt.verify(pendingData.verificationToken, secret);
                        return {
                            success: true,
                            verificationToken: pendingData.verificationToken,
                            email: email,
                            alreadyVerified: true
                        };
                    } catch {
                        // Token expired, generate new one below
                    }
                }
            }

            // Check if registration expired
            if (new Date() > pendingData.expiresAt.toDate()) {
                throw { code: 'expired', message: 'Signup link has expired. Please request a new one.' };
            }

            // Generate verification token for completeSignup
            const verificationToken = generateToken(
                {
                    email: email,
                    emailHash: emailHash,
                    purpose: 'complete_signup'
                },
                secret,
                VERIFICATION_TOKEN_EXPIRY_MINUTES
            );

            // Update pending registration
            await pendingRef.update({
                verified: true,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                verificationToken: verificationToken
            });

            console.log(`verifySignupToken: Email verified for ${emailHash.substring(0, 8)}...`);
            return {
                success: true,
                verificationToken: verificationToken,
                email: email
            };
        },

        /**
         * verifySignupToken - Verify the magic link token from email (onCall for iOS)
         *
         * Called when user clicks the magic link. Returns a verification token
         * that can be used to complete signup.
         */
        verifySignupToken: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [jwtSecret]
        }, async function(request) {
            try {
                const { token } = request.data;
                return await this._verifySignupTokenCore(token, jwtSecret.value());
            } catch (error) {
                if (error.code && error.message) {
                    // Error from core function
                    const codeMap = {
                        'invalid': 'invalid-argument',
                        'expired': 'deadline-exceeded',
                        'already_verified': 'already-exists'
                    };
                    throw new HttpsError(codeMap[error.code] || 'internal', error.message);
                }
                console.error('Error in verifySignupToken:', error);
                throw new HttpsError('internal', 'Failed to verify signup token');
            }
        }),

        /**
         * verifySignupTokenHttp - HTTP endpoint for web verification with CORS
         *
         * POST https://us-central1-albondigas-8cfd9.cloudfunctions.net/verifySignupTokenHttp
         * Body: { "token": "<jwt_token>" }
         */
        verifySignupTokenHttp: onRequest({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [jwtSecret]
        }, async (req, res) => {
            const origin = req.get('Origin') || '';
            setCorsHeaders(res, origin);

            // Handle CORS preflight
            if (req.method === 'OPTIONS') {
                res.status(204).send('');
                return;
            }

            // Only allow POST
            if (req.method !== 'POST') {
                res.status(405).json({ success: false, error: 'method_not_allowed' });
                return;
            }

            try {
                const { token } = req.body;

                if (!token) {
                    res.status(400).json({ success: false, error: 'invalid' });
                    return;
                }

                // Verify JWT signature and expiration
                let decoded;
                try {
                    decoded = jwt.verify(token, jwtSecret.value());
                } catch (error) {
                    if (error.name === 'TokenExpiredError') {
                        res.status(400).json({ success: false, error: 'expired' });
                        return;
                    }
                    res.status(400).json({ success: false, error: 'invalid' });
                    return;
                }

                if (decoded.purpose !== 'signup') {
                    res.status(400).json({ success: false, error: 'invalid' });
                    return;
                }

                const { emailHash, email } = decoded;

                // Look up pending registration
                const pendingRef = db.collection('pendingRegistrations').doc(emailHash);
                const pendingDoc = await pendingRef.get();

                if (!pendingDoc.exists) {
                    res.status(400).json({ success: false, error: 'invalid' });
                    return;
                }

                const pendingData = pendingDoc.data();

                // Verify token matches stored token
                if (pendingData.magicLinkToken !== token) {
                    res.status(400).json({ success: false, error: 'invalid' });
                    return;
                }

                // Check if already verified
                if (pendingData.verified) {
                    res.status(200).json({ success: true, alreadyVerified: true });
                    return;
                }

                // Check if registration expired
                if (new Date() > pendingData.expiresAt.toDate()) {
                    res.status(400).json({ success: false, error: 'expired' });
                    return;
                }

                // Generate verification token for completeSignup
                const verificationToken = generateToken(
                    {
                        email: email,
                        emailHash: emailHash,
                        purpose: 'complete_signup'
                    },
                    jwtSecret.value(),
                    VERIFICATION_TOKEN_EXPIRY_MINUTES
                );

                // Update pending registration
                await pendingRef.update({
                    verified: true,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    verificationToken: verificationToken
                });

                console.log(`verifySignupTokenHttp: Email verified for ${emailHash.substring(0, 8)}...`);
                res.status(200).json({ success: true });

            } catch (error) {
                console.error('Error in verifySignupTokenHttp:', error);
                res.status(500).json({ success: false, error: 'internal' });
            }
        }),

        /**
         * completeSignup - Create the Firebase Auth user after email verification
         *
         * Called after email is verified. Creates the user account and returns
         * a custom token for the client to sign in.
         */
        completeSignup: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [jwtSecret]
        }, async (request) => {
            try {
                const { verificationToken, password, displayName } = request.data;

                if (!verificationToken) {
                    throw new HttpsError('invalid-argument', 'Verification token is required');
                }

                if (!password || password.length < 6) {
                    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters');
                }

                if (!displayName || displayName.trim().length === 0) {
                    throw new HttpsError('invalid-argument', 'Display name is required');
                }

                // Verify JWT signature and expiration
                const decoded = verifyToken(verificationToken, jwtSecret.value());

                if (decoded.purpose !== 'complete_signup') {
                    throw new HttpsError('invalid-argument', 'Invalid token purpose');
                }

                const { emailHash, email } = decoded;

                // Look up pending registration
                const pendingRef = db.collection('pendingRegistrations').doc(emailHash);
                const pendingDoc = await pendingRef.get();

                if (!pendingDoc.exists) {
                    throw new HttpsError('not-found', 'Signup request not found or expired');
                }

                const pendingData = pendingDoc.data();

                // Verify email was verified
                if (!pendingData.verified) {
                    throw new HttpsError('failed-precondition', 'Email not verified');
                }

                // Verify token matches stored token
                if (pendingData.verificationToken !== verificationToken) {
                    throw new HttpsError('invalid-argument', 'Invalid verification token');
                }

                // Double-check email isn't already registered (race condition protection)
                try {
                    await admin.auth().getUserByEmail(email);
                    throw new HttpsError('already-exists', 'An account with this email already exists');
                } catch (authError) {
                    if (authError.code !== 'auth/user-not-found' && !(authError instanceof HttpsError)) {
                        throw authError;
                    }
                    if (authError instanceof HttpsError) {
                        throw authError;
                    }
                }

                // Create Firebase Auth user
                const userRecord = await admin.auth().createUser({
                    email: email,
                    password: password,
                    displayName: displayName.trim(),
                    emailVerified: true // Already verified via magic link
                });

                const uid = userRecord.uid;

                // Create Firestore user document
                await db.collection('users').doc(uid).set({
                    id: uid,
                    email: email,
                    displayName: displayName.trim(),
                    isPremium: false,
                    hasCompletedOnboarding: false,
                    isEmailVerified: true,
                    emailVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Delete pending registration (cleanup)
                await pendingRef.delete();

                // Generate custom token for iOS to sign in
                const customToken = await admin.auth().createCustomToken(uid);

                console.log(`completeSignup: Created user ${uid} for ${emailHash.substring(0, 8)}...`);
                return {
                    success: true,
                    customToken: customToken,
                    userId: uid
                };

            } catch (error) {
                if (error instanceof HttpsError) {
                    throw error;
                }
                console.error('Error in completeSignup:', error);
                throw new HttpsError('internal', 'Failed to complete signup');
            }
        }),

        /**
         * resendSignupLink - Resend the magic link email
         *
         * Same as initiateSignup but with stricter rate limiting messaging.
         */
        resendSignupLink: onCall({
            region: 'us-central1',
            maxInstances: 10,
            timeoutSeconds: 60,
            secrets: [mailgunApiKey, jwtSecret]
        }, async (request) => {
            const mg = mailgun({
                apiKey: mailgunApiKey.value(),
                domain: mailgunDomain
            });

            try {
                const { email } = request.data;

                if (!email || !isValidEmail(email)) {
                    throw new HttpsError('invalid-argument', 'Valid email is required');
                }

                const normalizedEmail = email.toLowerCase().trim();
                const emailHash = generateEmailHash(normalizedEmail);

                // Check if email already exists in Firebase Auth
                try {
                    await admin.auth().getUserByEmail(normalizedEmail);
                    // Email exists - return same success response
                    return { success: true, message: 'If a signup is in progress, a new link has been sent' };
                } catch (authError) {
                    if (authError.code !== 'auth/user-not-found') {
                        throw authError;
                    }
                }

                // Check for existing pending registration
                const pendingRef = db.collection('pendingRegistrations').doc(emailHash);
                const pendingDoc = await pendingRef.get();

                if (!pendingDoc.exists) {
                    // No pending registration - return same response (enumeration protection)
                    return { success: true, message: 'If a signup is in progress, a new link has been sent' };
                }

                const data = pendingDoc.data();
                const lastAttemptAt = data.lastAttemptAt?.toDate() || new Date(0);
                const hourAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

                // Stricter rate limiting for resend - max 3 per hour
                if (lastAttemptAt > hourAgo && data.attempts >= MAX_ATTEMPTS_PER_HOUR) {
                    throw new HttpsError(
                        'resource-exhausted',
                        'Too many resend attempts. Please try again later.'
                    );
                }

                // Reset attempts if outside rate limit window
                const currentAttempts = lastAttemptAt > hourAgo ? data.attempts : 0;

                // Generate new magic link token
                const magicLinkToken = generateToken(
                    {
                        email: normalizedEmail,
                        emailHash: emailHash,
                        purpose: 'signup'
                    },
                    jwtSecret.value(),
                    MAGIC_LINK_EXPIRY_MINUTES
                );

                // Update record with new token
                await pendingRef.update({
                    magicLinkToken: magicLinkToken,
                    expiresAt: admin.firestore.Timestamp.fromDate(
                        new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)
                    ),
                    attempts: currentAttempts + 1,
                    lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
                    verified: false,
                    verifiedAt: null,
                    verificationToken: null
                });

                // Send email
                await sendMagicLinkEmail(mg, normalizedEmail, magicLinkToken);

                console.log(`resendSignupLink: Resent link for ${emailHash.substring(0, 8)}...`);
                return { success: true, message: 'If a signup is in progress, a new link has been sent' };

            } catch (error) {
                if (error instanceof HttpsError) {
                    throw error;
                }
                console.error('Error in resendSignupLink:', error);
                throw new HttpsError('internal', 'Failed to resend signup link');
            }
        }),

        /**
         * cleanupPendingRegistrations - Daily cleanup of expired registrations
         *
         * Runs daily at 6:00 AM PT to remove expired pending registrations.
         */
        cleanupPendingRegistrations: onSchedule({
            schedule: '0 6 * * *', // 6:00 AM every day (UTC, adjust for PT)
            timeZone: 'America/Los_Angeles',
            region: 'us-central1',
            timeoutSeconds: 300
        }, async (event) => {
            console.log('cleanupPendingRegistrations: Starting cleanup...');

            const now = admin.firestore.Timestamp.now();
            let totalDeleted = 0;
            let hasMore = true;

            try {
                while (hasMore) {
                    // Query expired registrations in batches
                    const expiredQuery = await db.collection('pendingRegistrations')
                        .where('expiresAt', '<=', now)
                        .limit(500)
                        .get();

                    if (expiredQuery.empty) {
                        hasMore = false;
                        break;
                    }

                    // Batch delete
                    const batch = db.batch();
                    expiredQuery.docs.forEach(doc => {
                        batch.delete(doc.ref);
                    });

                    await batch.commit();
                    totalDeleted += expiredQuery.docs.length;

                    // If we got fewer than 500, we're done
                    if (expiredQuery.docs.length < 500) {
                        hasMore = false;
                    }
                }

                // Log results
                await db.collection('systemLogs')
                    .doc('pendingRegistrationCleanup')
                    .collection('runs')
                    .add({
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        triggeredBy: 'scheduled',
                        totalDeleted: totalDeleted,
                        success: true
                    });

                console.log(`cleanupPendingRegistrations: Deleted ${totalDeleted} expired registrations`);

            } catch (error) {
                console.error('cleanupPendingRegistrations error:', error);

                // Log error
                await db.collection('systemLogs')
                    .doc('pendingRegistrationCleanup')
                    .collection('errors')
                    .add({
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        triggeredBy: 'scheduled',
                        error: error.message,
                        stack: error.stack
                    });
            }
        })
    };
};

/**
 * Send magic link email via Mailgun
 */
async function sendMagicLinkEmail(mg, email, token) {
    const magicLink = `https://vlrb.app/verify?token=${encodeURIComponent(token)}`;

    const emailBody = `Welcome to vlrb!

We're excited you're here. Tap the link below to verify your email and finish signing up:

${magicLink}

This link expires in 15 minutes.

If you didn't request this, you can ignore this email.

- The vlrb team`;

    const mailData = {
        from: 'vlrb <noreply@vlrb.app>',
        to: email,
        subject: 'Verify your email for vlrb',
        text: emailBody,
        html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
    <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 24px;">Welcome to vlrb!</h1>

    <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
        We're excited you're here. Tap the button below to verify your email and finish signing up.
    </p>

    <div style="text-align: center; margin: 32px 0;">
        <a href="${magicLink}"
           style="display: inline-block; background-color: #007AFF; color: white; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
            Verify My Email
        </a>
    </div>

    <p style="font-size: 14px; color: #666; line-height: 1.5;">
        This link expires in 15 minutes.
    </p>

    <p style="font-size: 14px; color: #666; line-height: 1.5;">
        If you didn't request this, you can ignore this email.
    </p>

    <p style="font-size: 14px; color: #666; margin-top: 32px;">
        - The vlrb team
    </p>

    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">

    <p style="font-size: 12px; color: #999; line-height: 1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${magicLink}" style="color: #007AFF; word-break: break-all;">${magicLink}</a>
    </p>
</body>
</html>
        `
    };

    return new Promise((resolve, reject) => {
        mg.messages().send(mailData, (error, body) => {
            if (error) reject(error);
            else resolve(body);
        });
    });
}
