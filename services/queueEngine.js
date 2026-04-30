const QueueSlot = require('../models/QueueSlot');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');

class QueueEngine {
    constructor(io) {
        this.io = io;
        this.timerRunning = false;
        this.cycleTimer = 5;
        this.cooldownActive = false;
    }

    // ═══════════════════════════════════════════════
    // SETTINGS
    // ═══════════════════════════════════════════════

    async getSettings() {
        return await Settings.findOne() || {
            queueSize: 21,
            waitlistStart: 22,
            waitlistMax: 2222,
            maturityMultiplier: 10,
            cycleTimerSeconds: 5,
            cooldownSeconds: 15,
            depositAmount: 1.00,
            withdrawalTimerHours: 20,
            allowAutoReentry: false
        };
    }

    // ═══════════════════════════════════════════════
    // QUEUE COUNTS (Indexed queries — O(log n))
    // ═══════════════════════════════════════════════

    async getActiveQueueCount() {
        return await QueueSlot.countDocuments({ status: 'active', queueType: 'main' });
    }

    async getWaitlistCount() {
        return await QueueSlot.countDocuments({ status: 'waiting', queueType: 'waitlist' });
    }

    // ═══════════════════════════════════════════════
    // ASSIGN USER TO QUEUE (After deposit approval)
    // ═══════════════════════════════════════════════

    async assignToQueue(userId, depositTransactionId) {
        const settings = await this.getSettings();
        const activeCount = await this.getActiveQueueCount();

        const user = await User.findById(userId);
        if (!user) throw new Error('User not found');
        if (user.status === 'suspended') throw new Error('Account is suspended');
        if (user.queueStatus === 'expired' && !settings.allowAutoReentry) {
            throw new Error('Account expired. Contact admin for reactivation.');
        }

        const isMainQueue = activeCount < settings.queueSize;
        const depositAmount = settings.depositAmount ?? 1.00;

        const slot = new QueueSlot({
            userId,
            amount: depositAmount,
            queueType: isMainQueue ? 'main' : 'waitlist',
            status: isMainQueue ? 'active' : 'waiting',
            depositTransactionId,
        });

        if (isMainQueue) {
            slot.position = activeCount + 1;

            // ═══ FEATURE 2: NO automatic timer ═══
            // Position #1 stays indefinitely until admin approves withdrawal
            // Timer is NOT started automatically
        } else {
            const lastWaitlist = await QueueSlot.findOne({ queueType: 'waitlist', status: 'waiting' })
                .sort({ waitlistNumber: -1 });
            slot.waitlistNumber = lastWaitlist
                ? lastWaitlist.waitlistNumber + 1
                : settings.waitlistStart;
            slot.position = 0;
        }

        await slot.save();

        // Update user queue status
        await User.findByIdAndUpdate(userId, { queueStatus: 'in_queue' });

        // Record queue entry transaction
        await new Transaction({
            userId,
            type: 'queue_entry',
            amount: depositAmount,
            status: 'completed',
            description: isMainQueue
                ? `Assigned to queue position #${slot.position}`
                : `Added to waitlist #${slot.waitlistNumber}`
        }).save();

        logger.info('QUEUE', `User ${userId} → ${isMainQueue ? `Main #${slot.position}` : `Waitlist #${slot.waitlistNumber}`}`);

        // ═══ Auto-notification: User reaches top of queue ═══
        if (isMainQueue && slot.position === 1) {
            try {
                await new Notification({
                    title: 'You\'re #1 in Queue! 🎉',
                    body: 'You are now at the top of the queue. Wait for admin to approve your withdrawal.',
                    type: 'queue',
                    targetUserId: userId,
                }).save();
            } catch (notifErr) {
                logger.warn('NOTIFICATION', 'Failed to create queue top notification', notifErr.message);
            }
        }

        // Start cycle if queue is full
        const newCount = await this.getActiveQueueCount();
        if (newCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        await this.broadcastState();
        return slot;
    }

    // ═══════════════════════════════════════════════
    // PROCESS CYCLE
    // ═══════════════════════════════════════════════
    // FEATURE 2 CHANGE: No automatic expiry. Cycle just processes queue state.

    async processCycle() {
        // No automatic timer/expiry logic — admin controls withdrawal approval
        // This cycle is kept for queue state management and broadcasting
        await this.broadcastState();
    }

    // ═══════════════════════════════════════════════
    // WITHDRAWAL (Admin approves → user gets paid)
    // ═══════════════════════════════════════════════

    async completeWithdrawal(slotId, userId) {
        const settings = await this.getSettings();

        const slot = await QueueSlot.findOne({
            _id: slotId,
            userId: userId,
            status: 'active',
            queueType: 'main',
            position: 1
        });

        if (!slot) throw new Error('You are not at the top of the queue');

        const earning = slot.amount * settings.maturityMultiplier;

        // Mark slot as completed
        slot.status = 'completed';
        slot.completedAt = new Date();
        slot.position = 0;
        await slot.save();

        // Credit user wallet
        await User.findByIdAndUpdate(slot.userId, {
            queueStatus: 'eligible',
            $inc: {
                'wallet.balance': earning,
                'wallet.activeInQueue': -slot.amount,
                'wallet.totalEarned': earning
            }
        });

        // Record earning
        await new Transaction({
            userId: slot.userId,
            type: 'earning',
            amount: earning,
            status: 'completed',
            description: `Queue completed: $${slot.amount} → $${earning}`
        }).save();

        logger.info('COMPLETED', `Slot ${slot._id}: $${slot.amount} → $${earning} for user ${slot.userId}`);

        // Shift positions down
        await QueueSlot.updateMany(
            { status: 'active', queueType: 'main', position: { $gt: 1 } },
            { $inc: { position: -1 } }
        );

        // Promote from waitlist
        if (settings.autoPromote) {
            await this.promoteFromWaitlist();
        }

        // ═══ Notify new #1 user ═══
        const newTopSlot = await QueueSlot.findOne({
            status: 'active',
            queueType: 'main',
            position: 1
        });
        if (newTopSlot) {
            try {
                await new Notification({
                    title: 'You\'re #1 in Queue! 🎉',
                    body: 'You are now at the top of the queue. Wait for admin to approve your withdrawal.',
                    type: 'queue',
                    targetUserId: newTopSlot.userId,
                }).save();
            } catch (notifErr) {
                logger.warn('NOTIFICATION', 'Failed to create queue promotion notification');
            }
        }

        await this.broadcastState();
        return { earning, wallet: (await User.findById(slot.userId)).wallet };
    }

    // ═══════════════════════════════════════════════
    // PROMOTE FROM WAITLIST
    // ═══════════════════════════════════════════════

    async promoteFromWaitlist() {
        const settings = await this.getSettings();
        const activeCount = await this.getActiveQueueCount();

        if (activeCount >= settings.queueSize) return;

        const nextWaitlist = await QueueSlot.findOne({
            status: 'waiting',
            queueType: 'waitlist'
        }).sort({ waitlistNumber: 1 });

        if (!nextWaitlist) return;

        nextWaitlist.queueType = 'main';
        nextWaitlist.status = 'active';
        nextWaitlist.position = activeCount + 1;
        nextWaitlist.waitlistNumber = null;
        await nextWaitlist.save();

        await User.findByIdAndUpdate(nextWaitlist.userId, { queueStatus: 'in_queue' });

        logger.info('PROMOTE', `Waitlist → Main queue position #${activeCount + 1}`);

        // Recursively fill more spots
        if (activeCount + 1 < settings.queueSize) {
            await this.promoteFromWaitlist();
        }
    }

    // ═══════════════════════════════════════════════
    // ADMIN: Reactivate expired user
    // ═══════════════════════════════════════════════

    async reactivateUser(userId) {
        const user = await User.findById(userId);
        if (!user) throw new Error('User not found');
        if (user.queueStatus !== 'expired') throw new Error('User is not expired');

        user.queueStatus = 'eligible';
        await user.save();

        logger.info('ADMIN', `Reactivated expired user ${userId}`);
        return user;
    }

    // ═══════════════════════════════════════════════
    // CYCLE TIMER (Legacy-compatible)
    // ═══════════════════════════════════════════════

    startCycle() {
        if (this.timerRunning) return;
        this.timerRunning = true;

        Settings.findOne().then(settings => {
            this.cycleTimer = settings?.cycleTimerSeconds || 5;
            const cooldownSeconds = settings?.cooldownSeconds || 15;

            const interval = setInterval(async () => {
                this.cycleTimer--;
                this.io.emit('timerUpdate', this.cycleTimer);

                if (this.cycleTimer <= 0) {
                    clearInterval(interval);
                    this.timerRunning = false;
                    await this.processCycle();

                    const mainCount = await this.getActiveQueueCount();
                    const settings = await this.getSettings();
                    if (mainCount >= settings.queueSize) {
                        this.cooldownActive = true;
                        this.io.emit('cooldownUpdate', { active: true, seconds: cooldownSeconds });
                        setTimeout(() => {
                            this.cooldownActive = false;
                            this.io.emit('cooldownUpdate', { active: false, seconds: 0 });
                            this.startCycle();
                        }, cooldownSeconds * 1000);
                    }
                }
            }, 1000);
        });
    }

    // ═══════════════════════════════════════════════
    // INITIALIZE
    // ═══════════════════════════════════════════════

    async initialize() {
        const settings = await this.getSettings();
        const mainCount = await this.getActiveQueueCount();

        logger.info('QUEUE', `Active: ${mainCount}/${settings.queueSize} | Timer running: ${this.timerRunning}`);

        // Start cycle if queue is full
        if (mainCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        // ═══ FEATURE 2: No automatic expiry check interval ═══
        // Timer-based expiry has been removed.
        // Admin manually controls when users are removed from queue.
    }

    // ═══════════════════════════════════════════════
    // BROADCAST STATE via Socket.io
    // ═══════════════════════════════════════════════

    async broadcastState() {
        try {
            const mainQueue = await QueueSlot.find({ status: 'active', queueType: 'main' })
                .sort({ position: 1 })
                .populate('userId', 'username')
                .lean();

            const waitlist = await QueueSlot.find({ status: 'waiting', queueType: 'waitlist' })
                .sort({ waitlistNumber: 1 })
                .populate('userId', 'username')
                .lean();

            const settings = await this.getSettings();

            this.io.emit('queueUpdate', {
                mainQueue,
                waitlist,
                mainCount: mainQueue.length,
                waitlistCount: waitlist.length,
                queueSize: settings.queueSize,
                timer: this.cycleTimer,
            });
        } catch (err) {
            logger.error('BROADCAST', `Broadcast error: ${err.message}`);
        }
    }

    // ═══════════════════════════════════════════════
    // LEGACY INVEST (kept for backward compat)
    // ═══════════════════════════════════════════════

    async invest(userId, numDollars) {
        const settings = await this.getSettings();
        const mainCount = await this.getActiveQueueCount();

        const user = await User.findOneAndUpdate(
            { _id: userId, 'wallet.balance': { $gte: numDollars }, status: 'active' },
            {
                $inc: {
                    'wallet.balance': -numDollars,
                    'wallet.activeInQueue': numDollars
                }
            },
            { new: true }
        );

        if (!user) throw new Error('Insufficient balance or account inactive');

        const slots = [];
        let currentMainCount = mainCount;
        const depositAmount = settings.depositAmount ?? 1.00;

        for (let i = 0; i < numDollars; i++) {
            const isMainQueue = currentMainCount < settings.queueSize;
            const slot = new QueueSlot({
                userId,
                amount: depositAmount,
                queueType: isMainQueue ? 'main' : 'waitlist',
                status: isMainQueue ? 'active' : 'waiting',
            });

            if (isMainQueue) {
                slot.position = currentMainCount + 1;
                currentMainCount++;
            } else {
                const lastWaitlist = await QueueSlot.findOne({ queueType: 'waitlist', status: 'waiting' })
                    .sort({ waitlistNumber: -1 });
                slot.waitlistNumber = lastWaitlist
                    ? lastWaitlist.waitlistNumber + 1
                    : settings.waitlistStart;
                slot.position = 0;
            }

            await slot.save();
            slots.push(slot);
        }

        await new Transaction({
            userId,
            type: 'invest',
            amount: numDollars,
            status: 'completed',
            description: `Invested $${numDollars} into ${slots.length} queue slot(s)`
        }).save();

        const newMainCount = await this.getActiveQueueCount();
        if (newMainCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        await this.broadcastState();
        return { slots, wallet: user.wallet };
    }
}

module.exports = QueueEngine;
