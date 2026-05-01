const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const QueueSlot = require('../models/QueueSlot');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const BankDetail = require('../models/BankDetail');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const { adminAuth } = require('../middleware/auth');
const { asyncHandler, paginationMeta } = require('../utils/helpers');
const logger = require('../utils/logger');
const fcmService = require('../services/notificationService');

// ═══════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════
router.get('/stats', adminAuth, asyncHandler(async (req, res) => {
    const [userStats] = await User.aggregate([
        { $match: { status: { $ne: 'admin' } } },
        {
            $group: {
                _id: null,
                totalUsers: { $sum: 1 },
                activeUsers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                suspendedUsers: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
                terminatedUsers: { $sum: { $cond: [{ $eq: ['$status', 'terminated'] }, 1, 0] } },
                expiredUsers: { $sum: { $cond: [{ $eq: ['$queueStatus', 'expired'] }, 1, 0] } },
                // Only count active users' balances (exclude suspended/terminated)
                activeUserBalances: {
                    $sum: {
                        $cond: [
                            { $eq: ['$status', 'active'] },
                            '$wallet.balance',
                            0
                        ]
                    }
                },
                // Total active queue amounts (only active users)
                activeQueueAmounts: {
                    $sum: {
                        $cond: [
                            { $eq: ['$status', 'active'] },
                            '$wallet.activeInQueue',
                            0
                        ]
                    }
                },
            }
        }
    ]);

    // Only count active/waiting queue slots (not suspended/terminated user slots)
    const [mainQueueCount, waitlistCount] = await Promise.all([
        QueueSlot.countDocuments({ status: 'active', queueType: 'main' }),
        QueueSlot.countDocuments({ status: 'waiting', queueType: 'waitlist' }),
    ]);

    const [depositStats] = await Transaction.aggregate([
        { $match: { type: 'deposit' } },
        {
            $group: {
                _id: null,
                totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            }
        }
    ]);

    const [withdrawalStats] = await Transaction.aggregate([
        { $match: { type: 'withdrawal' } },
        {
            $group: {
                _id: null,
                totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            }
        }
    ]);

    res.json({
        totalUsers: userStats?.totalUsers || 0,
        activeUsers: userStats?.activeUsers || 0,
        suspendedUsers: userStats?.suspendedUsers || 0,
        terminatedUsers: userStats?.terminatedUsers || 0,
        expiredUsers: userStats?.expiredUsers || 0,
        mainQueueCount,
        waitlistCount,
        totalDeposits: depositStats?.totalCompleted || 0,
        totalWithdrawals: withdrawalStats?.totalCompleted || 0,
        pendingDeposits: depositStats?.pendingCount || 0,
        pendingWithdrawals: withdrawalStats?.pendingCount || 0,
        // Use ACTIVE users' balances only (not suspended/terminated)
        totalUserBalances: userStats?.activeUserBalances || 0,
        activeQueueAmounts: userStats?.activeQueueAmounts || 0,
    });
}));

// ═══════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/users', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const statusFilter = req.query.status; // NEW: Filter by status

    let query = { status: { $ne: 'admin' } };

    // Status filter for user history page
    if (statusFilter) {
        if (statusFilter === 'inactive') {
            query.status = { $in: ['suspended', 'terminated'] };
        } else {
            query.status = statusFilter;
        }
    }

    if (search) {
        query.$or = [
            { username: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    const [users, total] = await Promise.all([
        User.find(query)
            .select('-password -pin')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments(query)
    ]);

    // Batch fetch active slot counts
    const userIds = users.map(u => u._id);
    const slotCounts = await QueueSlot.aggregate([
        { $match: { userId: { $in: userIds }, status: { $in: ['active', 'waiting'] } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]);
    const slotMap = {};
    slotCounts.forEach(s => { slotMap[s._id.toString()] = s.count; });

    const usersWithSlots = users.map(user => ({
        ...user,
        activeSlots: slotMap[user._id.toString()] || 0
    }));

    res.json({
        users: usersWithSlots,
        pagination: paginationMeta(page, limit, total)
    });
}));

// ═══════════════════════════════════════════════════
// FEATURE 3: BULK DELETE IRRELEVANT USERS
// ═══════════════════════════════════════════════════
router.post('/users/cleanup', adminAuth, asyncHandler(async (req, res) => {
    const { statuses, confirm: confirmAction } = req.body;

    // Valid statuses for cleanup
    const validStatuses = ['suspended', 'terminated'];
    const targetStatuses = statuses?.filter(s => validStatuses.includes(s)) || validStatuses;

    if (!confirmAction || confirmAction !== 'DELETE_ALL_CONFIRMED') {
        // Preview mode: return count of users that would be deleted
        const counts = {};
        for (const status of targetStatuses) {
            counts[status] = await User.countDocuments({ status });
        }
        // Also count completed lifecycle users
        const completedCount = await User.countDocuments({
            lifecyclePhase: 'completed',
            status: { $ne: 'admin' }
        });
        counts.completed = completedCount;

        return res.json({
            message: 'Preview mode — send confirm: "DELETE_ALL_CONFIRMED" to execute',
            preview: true,
            counts,
            totalToDelete: Object.values(counts).reduce((a, b) => a + b, 0),
        });
    }

    // ═══ BATCH DELETE with transaction ═══
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Find users to delete
        const usersToDelete = await User.find({
            $or: [
                { status: { $in: targetStatuses } },
                { lifecyclePhase: 'completed', status: { $ne: 'admin' } }
            ]
        }).select('_id username status lifecyclePhase').session(session);

        const userIds = usersToDelete.map(u => u._id);
        const deleteCount = userIds.length;

        if (deleteCount === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.json({ message: 'No users to delete', deleted: 0 });
        }

        // Batch delete related data
        const [txnResult, slotResult] = await Promise.all([
            Transaction.deleteMany({ userId: { $in: userIds } }).session(session),
            QueueSlot.deleteMany({ userId: { $in: userIds } }).session(session),
        ]);

        // Delete users
        const userResult = await User.deleteMany({ _id: { $in: userIds } }).session(session);

        // Audit log
        await new AuditLog({
            action: 'user.bulk_delete',
            performedBy: req.userId,
            details: {
                deletedCount: deleteCount,
                statuses: targetStatuses,
                usernames: usersToDelete.map(u => u.username),
                transactionsDeleted: txnResult.deletedCount,
                slotsDeleted: slotResult.deletedCount,
            }
        }).save({ session });

        await session.commitTransaction();
        session.endSession();

        logger.info('ADMIN', `Bulk deleted ${deleteCount} users (statuses: ${targetStatuses.join(', ')})`);

        res.json({
            message: `Successfully deleted ${deleteCount} users`,
            deleted: deleteCount,
            transactionsDeleted: txnResult.deletedCount,
            slotsDeleted: slotResult.deletedCount,
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
}));

// ═══════════════════════════════════════════════════
// DEPOSIT MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/deposits', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const status = req.query.status;

    let query = { type: 'deposit' };
    if (status) query.status = status;

    const [deposits, total] = await Promise.all([
        Transaction.find(query)
            .populate('userId', 'username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Transaction.countDocuments(query)
    ]);

    res.json({
        deposits,
        pagination: paginationMeta(page, limit, total)
    });
}));

// DEPOSIT VERIFY → AUTO QUEUE ASSIGNMENT
router.post('/deposits/:id/verify', adminAuth, asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const transaction = await Transaction.findById(req.params.id).session(session);
        if (!transaction || transaction.status !== 'pending' || transaction.type !== 'deposit') {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Pending deposit not found' });
        }

        transaction.status = 'completed';
        await transaction.save();

        await User.findByIdAndUpdate(transaction.userId, {
            $inc: { 'wallet.balance': transaction.amount },
            $set: {
                hasDeposited: true,
                depositStatus: 'approved',
                lifecyclePhase: 'in_queue'
            }
        }).session(session);

        await session.commitTransaction();
        session.endSession();

        logger.info('ADMIN', `Deposit $${transaction.amount} verified for user ${transaction.userId}`);

        // AUTO-ASSIGN to queue after approval
        try {
            await req.queueEngine.assignToQueue(transaction.userId, transaction._id);
            await User.findByIdAndUpdate(transaction.userId, {
                $inc: { 'wallet.balance': -transaction.amount, 'wallet.activeInQueue': transaction.amount }
            });

            // ═══ Auto-notification: Deposit approved (DB + FCM Push) ═══
            try {
                const depositNotifTitle = 'Deposit Approved ✅';
                const depositNotifBody = `Your deposit of $${transaction.amount.toFixed(2)} has been approved and you've been assigned to the queue!`;
                const notif = await new Notification({
                    title: depositNotifTitle,
                    body: depositNotifBody,
                    type: 'deposit',
                    targetUserId: transaction.userId,
                    metadata: { transactionId: transaction._id, amount: transaction.amount },
                    sentBy: req.userId,
                }).save();
                // Send FCM push to device notification bar
                fcmService.sendToUser(transaction.userId, depositNotifTitle, depositNotifBody, {
                    notificationId: notif._id.toString(),
                    type: 'deposit'
                }).catch(() => { });
            } catch (notifErr) {
                logger.warn('NOTIFICATION', 'Failed to create deposit notification', notifErr.message);
            }

            res.json({ message: 'Deposit verified, credited, and user assigned to queue' });
        } catch (queueErr) {
            logger.error('QUEUE', `Queue assign error: ${queueErr.message}`);
            res.json({ message: `Deposit verified and credited. Queue assignment: ${queueErr.message}` });
        }
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
}));

router.post('/deposits/:id/reject', adminAuth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.status !== 'pending') {
        return res.status(404).json({ message: 'Pending deposit not found' });
    }

    transaction.status = 'rejected';
    await transaction.save();

    await User.findByIdAndUpdate(transaction.userId, {
        $set: {
            depositStatus: 'rejected',
            lifecyclePhase: 'fresh'
        }
    });

    res.json({ message: 'Deposit rejected. User can submit a new deposit.' });
}));

// ═══════════════════════════════════════════════════
// WITHDRAWAL MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/withdrawals', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [withdrawals, total] = await Promise.all([
        Transaction.find({ type: 'withdrawal' })
            .populate('userId', 'username email accountDetails')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Transaction.countDocuments({ type: 'withdrawal' })
    ]);

    res.json({
        withdrawals,
        pagination: paginationMeta(page, limit, total)
    });
}));

router.post('/withdrawals/:id/pay', adminAuth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(404).json({ message: 'Pending withdrawal not found' });
    }

    transaction.status = 'completed';
    await transaction.save();

    // ═══ ACCOUNT LIFECYCLE: TERMINATE on withdrawal approval ═══
    const user = await User.findById(transaction.userId);
    if (user) {
        await QueueSlot.updateMany(
            { userId: user._id, status: { $in: ['active', 'waiting'] } },
            { $set: { status: 'completed' } }
        );

        user.status = 'terminated';
        user.lifecyclePhase = 'completed';
        user.terminatedAt = new Date();
        user.wallet.activeInQueue = 0;
        await user.save();

        logger.info('LIFECYCLE', `User ${user.username} TERMINATED after withdrawal of $${transaction.amount}`);

        // ═══ Auto-notification: Withdrawal approved (DB + FCM Push) ═══
        try {
            const withdrawNotifTitle = 'Withdrawal Approved 💰';
            const withdrawNotifBody = `Your withdrawal of $${transaction.amount} has been processed! Amount has been sent to your account.`;
            const notif = await new Notification({
                title: withdrawNotifTitle,
                body: withdrawNotifBody,
                type: 'withdrawal',
                targetUserId: transaction.userId,
                metadata: { transactionId: transaction._id, amount: transaction.amount },
                sentBy: req.userId,
            }).save();
            // Send FCM push to device notification bar
            fcmService.sendToUser(transaction.userId, withdrawNotifTitle, withdrawNotifBody, {
                notificationId: notif._id.toString(),
                type: 'withdrawal'
            }).catch(() => { });
        } catch (notifErr) {
            logger.warn('NOTIFICATION', 'Failed to create withdrawal notification', notifErr.message);
        }
    }

    res.json({ message: 'Withdrawal paid. User account terminated.' });
}));

router.post('/withdrawals/:id/reject', adminAuth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(404).json({ message: 'Pending withdrawal not found' });
    }

    await User.findByIdAndUpdate(transaction.userId, {
        $inc: { 'wallet.balance': transaction.amount }
    });

    transaction.status = 'rejected';
    await transaction.save();
    res.json({ message: 'Withdrawal rejected and refunded' });
}));

// ═══════════════════════════════════════════════════
// USER ACTIONS
// ═══════════════════════════════════════════════════
router.post('/users/:id/suspend', adminAuth, asyncHandler(async (req, res) => {
    const userId = req.params.id;
    await User.findByIdAndUpdate(userId, { status: 'suspended' });

    const activeSlots = await QueueSlot.find({ userId, status: { $in: ['active', 'waiting'] } });
    if (activeSlots.length > 0) {
        const refundAmount = activeSlots.reduce((sum, s) => sum + s.amount, 0);
        await QueueSlot.updateMany(
            { userId, status: { $in: ['active', 'waiting'] } },
            { status: 'cancelled' }
        );
        await User.findByIdAndUpdate(userId, {
            $inc: { 'wallet.balance': refundAmount, 'wallet.activeInQueue': -refundAmount }
        });
    }

    await req.queueEngine.broadcastState();
    res.json({ message: 'User suspended and queue slots cancelled' });
}));

router.post('/users/:id/activate', adminAuth, asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { status: 'active', queueStatus: 'eligible' });
    res.json({ message: 'User activated' });
}));

router.post('/users/:id/add-balance', adminAuth, asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

    const user = await User.findByIdAndUpdate(
        req.params.id,
        { $inc: { 'wallet.balance': amount } },
        { new: true }
    );
    res.json({ message: `$${amount} added`, wallet: user.wallet });
}));

// ═══════════════════════════════════════════════════
// QUEUE MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/queue', adminAuth, asyncHandler(async (req, res) => {
    const mainQueue = await QueueSlot.find({ status: 'active', queueType: 'main' })
        .sort({ position: 1 })
        .populate('userId', 'username email');
    const waitlist = await QueueSlot.find({ status: 'waiting', queueType: 'waitlist' })
        .sort({ waitlistNumber: 1 })
        .populate('userId', 'username email');
    const settings = await req.queueEngine.getSettings();

    const expiredSlots = await QueueSlot.find({ status: 'expired' })
        .sort({ expiredAt: -1 })
        .limit(20)
        .populate('userId', 'username email');

    res.json({
        mainQueue,
        waitlist,
        expiredSlots,
        settings,
        timer: req.queueEngine.cycleTimer,
    });
}));

router.post('/queue/assign/:userId', adminAuth, asyncHandler(async (req, res) => {
    const settings = await Settings.findOne();
    const depositAmt = settings?.depositAmount ?? 1.00;
    const slot = await req.queueEngine.assignToQueue(req.params.userId, null);
    await User.findByIdAndUpdate(req.params.userId, {
        $inc: { 'wallet.balance': -depositAmt, 'wallet.activeInQueue': depositAmt }
    });
    res.json({ message: 'User assigned to queue', slot });
}));

router.post('/queue/reactivate/:userId', adminAuth, asyncHandler(async (req, res) => {
    const user = await req.queueEngine.reactivateUser(req.params.userId);
    res.json({ message: 'User reactivated and eligible for queue', user: { _id: user._id, username: user.username, queueStatus: user.queueStatus } });
}));

// ═══════════════════════════════════════════════════
// BANK DETAILS
// ═══════════════════════════════════════════════════
router.get('/bank-details', adminAuth, asyncHandler(async (req, res) => {
    const records = await BankDetail.find().sort({ publishedAt: -1 });
    res.json(records);
}));

router.post('/bank-details', adminAuth, asyncHandler(async (req, res) => {
    const { accountNumber, bankName, accountTitle, additionalInstructions } = req.body;
    if (!accountNumber || !accountTitle) {
        return res.status(400).json({ message: 'Account Title and Account Number are required' });
    }

    await BankDetail.updateMany({}, { $set: { isActive: false } });

    const newDetail = new BankDetail({
        accountNumber,
        bankName: bankName || '',
        accountTitle,
        additionalInstructions: additionalInstructions || '',
        isActive: true,
        publishedAt: new Date()
    });
    await newDetail.save();

    req.io.emit('bankDetailsUpdated', newDetail);
    res.json({ message: 'Bank details published successfully', bankDetail: newDetail });
}));

// ═══════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════
router.get('/settings', adminAuth, asyncHandler(async (req, res) => {
    const settings = await Settings.findOne();
    res.json(settings || {});
}));

router.post('/settings', adminAuth, asyncHandler(async (req, res) => {
    const allowedFields = ['queueSize', 'waitlistStart', 'waitlistMax', 'maturityMultiplier', 'cycleTimerSeconds', 'cooldownSeconds', 'autoPromote', 'depositAmount', 'minDeposit', 'maxDeposit', 'withdrawalTimerHours', 'allowAutoReentry'];
    const updates = {};
    allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const updatedSettings = await Settings.findOneAndUpdate({}, updates, { upsert: true, new: true });

    if (updates.depositAmount !== undefined) {
        req.io.emit('depositAmountUpdated', {
            depositAmount: updatedSettings.depositAmount
        });
        logger.info('ADMIN', `Deposit amount updated to $${updatedSettings.depositAmount}`);
    }

    res.json({ message: 'Settings updated' });
}));

router.post('/update-credentials', adminAuth, asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (username) req.user.username = username;
    if (password) req.user.password = password;
    await req.user.save();
    res.json({ message: 'Admin credentials updated' });
}));

// ═══════════════════════════════════════════════════
// FEATURE 5: NOTIFICATION MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/notifications', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find()
            .populate('targetUserId', 'username')
            .populate('sentBy', 'username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments()
    ]);

    res.json({
        notifications,
        pagination: paginationMeta(page, limit, total)
    });
}));

// Send manual notification to specific user
router.post('/notifications/send', adminAuth, asyncHandler(async (req, res) => {
    const { title, body, targetUserId } = req.body;

    if (!title || !body) {
        return res.status(400).json({ message: 'Title and body are required' });
    }

    const notification = new Notification({
        title,
        body,
        type: targetUserId ? 'manual' : 'broadcast',
        targetUserId: targetUserId || null,
        sentBy: req.userId,
    });
    await notification.save();

    // Emit via socket for real-time
    if (targetUserId) {
        req.io.emit(`notification:${targetUserId}`, { title, body, type: 'manual' });
        // FCM push
        fcmService.sendToUser(targetUserId, title, body, { notificationId: notification._id.toString() }).catch(() => { });
    } else {
        req.io.emit('notification:broadcast', { title, body, type: 'broadcast' });
        fcmService.sendBroadcast(title, body, { notificationId: notification._id.toString() }).catch(() => { });
    }

    logger.info('NOTIFICATION', `${targetUserId ? 'Manual' : 'Broadcast'} notification sent: "${title}"`);
    res.json({ message: 'Notification sent', notification });
}));

// Broadcast to all users
router.post('/notifications/broadcast', adminAuth, asyncHandler(async (req, res) => {
    const { title, body } = req.body;

    if (!title || !body) {
        return res.status(400).json({ message: 'Title and body are required' });
    }

    const notification = new Notification({
        title,
        body,
        type: 'broadcast',
        targetUserId: null,
        sentBy: req.userId,
    });
    await notification.save();

    req.io.emit('notification:broadcast', { title, body, type: 'broadcast', id: notification._id });

    // FCM push to all users with tokens
    const fcmResult = await fcmService.sendBroadcast(title, body, { notificationId: notification._id.toString() });

    logger.info('NOTIFICATION', `Broadcast sent: "${title}" | FCM: ${fcmResult.sent} sent, ${fcmResult.failed} failed`);
    res.json({ message: 'Broadcast notification sent to all users', notification, fcm: fcmResult });
}));

// ═══════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════
router.get('/audit-logs', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
        AuditLog.find()
            .populate('performedBy', 'username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AuditLog.countDocuments()
    ]);

    res.json({
        logs,
        pagination: paginationMeta(page, limit, total)
    });
}));

module.exports = router;
