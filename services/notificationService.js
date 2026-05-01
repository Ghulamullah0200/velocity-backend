/**
 * Firebase Notification Service — FCM Push Notifications
 * 
 * Sends real push notifications to user devices via Firebase Cloud Messaging.
 * Falls back to Socket.IO-only delivery if Firebase is not configured.
 * 
 * Setup: npm install firebase-admin
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */
const logger = require('../utils/logger');
const User = require('../models/User');

let firebaseApp = null;
let messaging = null;

// Lazy initialization
function getMessaging() {
    if (messaging) return messaging;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || projectId === 'your_project_id' || !clientEmail || !privateKey) {
        logger.warn('FCM', 'Not configured — notifications will use Socket.IO only');
        return null;
    }

    try {
        const admin = require('firebase-admin');

        if (!firebaseApp) {
            firebaseApp = admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey: privateKey.replace(/\\n/g, '\n'),
                }),
            });
            logger.info('FCM', 'Firebase Admin initialized');
        }

        messaging = admin.messaging();
        return messaging;
    } catch (err) {
        logger.error('FCM', 'Failed to initialize — install with: npm install firebase-admin', err.message);
        return null;
    }
}

/**
 * Send notification to a specific user by userId
 * @param {string} userId - MongoDB user ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 * @returns {Promise<{success: boolean, messageId?: string}>}
 */
async function sendToUser(userId, title, body, data = {}) {
    const fcm = getMessaging();

    // Get user's FCM token
    const user = await User.findById(userId).select('fcmToken username').lean();

    if (!user?.fcmToken) {
        logger.debug('FCM', `No FCM token for user ${userId} — skipping push`);
        return { success: false, reason: 'no_token' };
    }

    if (!fcm) {
        logger.debug('FCM', `Firebase not configured — skipping push for ${user.username}`);
        return { success: false, reason: 'not_configured' };
    }

    try {
        const message = {
            token: user.fcmToken,
            notification: {
                title,
                body,
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                timestamp: new Date().toISOString(),
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'velocity_cash_main',
                    icon: 'ic_notification',
                    color: '#00C853',
                    sound: 'default',
                },
            },
        };

        const messageId = await fcm.send(message);
        logger.info('FCM', `Push sent to ${user.username}: "${title}" (${messageId})`);
        return { success: true, messageId };
    } catch (err) {
        // Token expired or invalid — clean it up
        if (err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token') {
            await User.findByIdAndUpdate(userId, { fcmToken: null });
            logger.warn('FCM', `Invalid token for ${user.username} — removed`);
        } else {
            logger.error('FCM', `Push failed for ${user.username}: ${err.message}`);
        }
        return { success: false, reason: err.code || err.message };
    }
}

/**
 * Send notification to multiple users (broadcast)
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendBroadcast(title, body, data = {}) {
    const fcm = getMessaging();
    if (!fcm) {
        logger.debug('FCM', 'Firebase not configured — skipping broadcast push');
        return { sent: 0, failed: 0 };
    }

    // Get all users with FCM tokens
    const users = await User.find({
        fcmToken: { $ne: null },
        status: { $nin: ['suspended', 'terminated', 'admin'] }
    }).select('fcmToken username').lean();

    if (users.length === 0) {
        logger.info('FCM', 'No users with FCM tokens — skipping broadcast');
        return { sent: 0, failed: 0 };
    }

    const tokens = users.map(u => u.fcmToken).filter(Boolean);

    try {
        // Firebase supports up to 500 tokens per multicast
        const batchSize = 500;
        let totalSent = 0;
        let totalFailed = 0;

        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            const message = {
                tokens: batch,
                notification: { title, body },
                data: {
                    ...data,
                    type: 'broadcast',
                    timestamp: new Date().toISOString(),
                },
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'velocity_cash_main',
                        icon: 'ic_notification',
                        color: '#00C853',
                        sound: 'default',
                    },
                },
            };

            const response = await fcm.sendEachForMulticast(message);
            totalSent += response.successCount;
            totalFailed += response.failureCount;

            // Cleanup invalid tokens
            response.responses.forEach((res, idx) => {
                if (!res.success && res.error?.code === 'messaging/registration-token-not-registered') {
                    User.findOneAndUpdate(
                        { fcmToken: batch[idx] },
                        { fcmToken: null }
                    ).exec(); // Fire and forget
                }
            });
        }

        logger.info('FCM', `Broadcast: ${totalSent} sent, ${totalFailed} failed (${tokens.length} total)`);
        return { sent: totalSent, failed: totalFailed };
    } catch (err) {
        logger.error('FCM', `Broadcast failed: ${err.message}`);
        return { sent: 0, failed: tokens.length };
    }
}

/**
 * Check if Firebase is configured and available
 */
function isAvailable() {
    return getMessaging() !== null;
}

module.exports = { sendToUser, sendBroadcast, isAvailable };
