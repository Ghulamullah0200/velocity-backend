/**
 * Firebase Notification Service — Production Ready
 * 
 * Features:
 * - Multi-device support (fcmTokens array)
 * - Robust error handling
 * - Token cleanup (invalid/expired)
 * - Batch broadcasting (500 tokens per request)
 * - Safe initialization
 */

const logger = require('../utils/logger');
const User = require('../models/User');

let messaging = null;

/**
 * Initialize Firebase Admin safely (singleton)
 */
function getMessaging() {
    if (messaging) return messaging;

    try {
        const admin = require('firebase-admin');

        if (!admin.apps.length) {
            const projectId = process.env.FIREBASE_PROJECT_ID;
            const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
            const privateKey = process.env.FIREBASE_PRIVATE_KEY;

            if (!projectId || !clientEmail || !privateKey) {
                logger.warn('FCM', 'Missing Firebase config');
                return null;
            }

            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey: privateKey.replace(/\\n/g, '\n'),
                }),
            });

            logger.info('FCM', 'Firebase initialized');
        }

        messaging = require('firebase-admin').messaging();
        return messaging;

    } catch (err) {
        logger.error('FCM', 'Initialization failed', err.message);
        return null;
    }
}

/**
 * Send notification to a specific user
 */
async function sendToUser(userId, title, body, data = {}) {
    const fcm = getMessaging();
    if (!fcm) return { success: false, reason: 'not_configured' };

    try {
        const user = await User.findById(userId)
            .select('fcmTokens username')
            .lean();

        if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
            logger.debug('FCM', `No tokens for user ${userId}`);
            return { success: false, reason: 'no_tokens' };
        }

        const response = await fcm.sendEachForMulticast({
            tokens: user.fcmTokens,
            notification: { title, body },
            data: {
                ...data,
                timestamp: new Date().toISOString(),
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'velocity_cash_main',
                    sound: 'default',
                },
            },
        });

        // Cleanup invalid tokens
        const invalidTokens = [];

        response.responses.forEach((res, idx) => {
            if (!res.success) {
                const code = res.error?.code;

                if (
                    code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token'
                ) {
                    invalidTokens.push(user.fcmTokens[idx]);
                }
            }
        });

        if (invalidTokens.length > 0) {
            await User.updateOne(
                { _id: userId },
                { $pull: { fcmTokens: { $in: invalidTokens } } }
            );
            logger.warn('FCM', `Removed ${invalidTokens.length} invalid tokens`);
        }

        logger.info(
            'FCM',
            `User ${user.username}: ${response.successCount}/${user.fcmTokens.length} delivered`
        );

        return {
            success: true,
            sent: response.successCount,
            failed: response.failureCount,
        };

    } catch (err) {
        logger.error('FCM', `Send failed: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

/**
 * Broadcast notification to all active users
 */
async function sendBroadcast(title, body, data = {}) {
    const fcm = getMessaging();
    if (!fcm) {
        logger.warn('FCM', 'Broadcast skipped — Firebase not configured');
        return { sent: 0, failed: 0 };
    }

    try {
        const users = await User.find({
            fcmTokens: { $exists: true, $ne: [] },
            status: { $nin: ['suspended', 'terminated', 'admin'] }
        })
            .select('fcmTokens')
            .lean();

        const tokens = users.flatMap(u => u.fcmTokens || []);

        if (tokens.length === 0) {
            logger.info('FCM', 'No tokens found for broadcast');
            return { sent: 0, failed: 0 };
        }

        const batchSize = 500;
        let totalSent = 0;
        let totalFailed = 0;

        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            const response = await fcm.sendEachForMulticast({
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
                        sound: 'default',
                    },
                },
            });

            totalSent += response.successCount;
            totalFailed += response.failureCount;

            // Cleanup invalid tokens
            const invalidTokens = [];

            response.responses.forEach((res, idx) => {
                if (!res.success) {
                    const code = res.error?.code;

                    if (code === 'messaging/registration-token-not-registered') {
                        invalidTokens.push(batch[idx]);
                    }
                }
            });

            if (invalidTokens.length > 0) {
                await User.updateMany(
                    { fcmTokens: { $in: invalidTokens } },
                    { $pull: { fcmTokens: { $in: invalidTokens } } }
                );
            }
        }

        logger.info(
            'FCM',
            `Broadcast complete: ${totalSent} sent, ${totalFailed} failed`
        );

        return { sent: totalSent, failed: totalFailed };

    } catch (err) {
        logger.error('FCM', `Broadcast error: ${err.message}`);
        return { sent: 0, failed: 0 };
    }
}

/**
 * Check Firebase availability
 */
function isAvailable() {
    return !!getMessaging();
}

module.exports = {
    sendToUser,
    sendBroadcast,
    isAvailable,
};