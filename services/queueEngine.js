const QueueSlot = require('../models/QueueSlot');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');

class QueueEngine {
    constructor(io) {
        this.io = io;
        this.timerRunning = false;
        this.cycleTimer = 5;
        this.cooldownActive = false;
        this.expiryCheckInterval = null;
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

        // Check if user is eligible
        const user = await User.findById(userId);
        if (!user) throw new Error('User not found');
        if (user.status === 'suspended') throw new Error('Account is suspended');
        if (user.queueStatus === 'expired' && !settings.allowAutoReentry) {
            throw new Error('Account expired. Contact admin for reactivation.');
        }

        const isMainQueue = activeCount < settings.queueSize;

        const slot = new QueueSlot({
            userId,
            amount: 1,
            queueType: isMainQueue ? 'main' : 'waitlist',
            status: isMainQueue ? 'active' : 'waiting',
            depositTransactionId,
        });

        if (isMainQueue) {
            slot.position = activeCount + 1;

            // If this user lands at position 1 (empty queue), start their timer immediately
            if (slot.position === 1) {
                const deadline = new Date();
                deadline.setHours(deadline.getHours() + settings.withdrawalTimerHours);
                slot.withdrawalDeadline = deadline;
                slot.timerStartedAt = new Date();
            }
        } else {
            // Assign waitlist number
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
            amount: 1,
            status: 'completed',
            description: isMainQueue
                ? `Assigned to queue position #${slot.position}`
                : `Added to waitlist #${slot.waitlistNumber}`
        }).save();

        console.log(`[QUEUE] User ${userId} → ${isMainQueue ? `Main #${slot.position}` : `Waitlist #${slot.waitlistNumber}`}`);

        // Start cycle if queue is full
        const newCount = await this.getActiveQueueCount();
        if (newCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        await this.broadcastState();
        return slot;
    }

    // ═══════════════════════════════════════════════
    // PROCESS CYCLE (FIFO maturation)
    // ═══════════════════════════════════════════════

    async processCycle() {
        const settings = await this.getSettings();

        // Get position #1 slot (top of queue)
        const topSlot = await QueueSlot.findOne({
            status: 'active',
            queueType: 'main',
            position: 1
        });

        if (!topSlot) return;

        // Check if timer has been started for this slot
        if (!topSlot.withdrawalDeadline) {
            // Start the 20-hour withdrawal timer
            const deadline = new Date();
            deadline.setHours(deadline.getHours() + settings.withdrawalTimerHours);
            topSlot.withdrawalDeadline = deadline;
            topSlot.timerStartedAt = new Date();
            await topSlot.save();
            console.log(`[TIMER] Started 20-hour countdown for slot ${topSlot._id} (user: ${topSlot.userId})`);
            await this.broadcastState();
            return; // Don't process — wait for withdrawal or expiry
        }

        // If deadline hasn't passed, skip (timer still running)
        if (new Date() < topSlot.withdrawalDeadline) {
            return;
        }

        // Deadline passed and user didn't withdraw — EXPIRE
        await this.expireSlot(topSlot);
    }

    // ═══════════════════════════════════════════════
    // EXPIRY HANDLING
    // ═══════════════════════════════════════════════

    async expireSlot(slot) {
        slot.status = 'expired';
        slot.expiredAt = new Date();
        slot.position = 0;
        await slot.save();

        // Mark user as expired
        await User.findByIdAndUpdate(slot.userId, {
            queueStatus: 'expired',
            $inc: { 'wallet.activeInQueue': -slot.amount }
        });

        console.log(`[EXPIRED] Slot ${slot._id} for user ${slot.userId} — timer exceeded`);

        // Shift all positions down
        await QueueSlot.updateMany(
            { status: 'active', queueType: 'main', position: { $gt: 1 } },
            { $inc: { position: -1 } }
        );

        // Auto-promote from waitlist
        const settings = await this.getSettings();
        if (settings.autoPromote) {
            await this.promoteFromWaitlist();
        }

        // Start timer for new position #1 if exists
        await this.startTimerForTopSlot();

        await this.broadcastState();
    }

    // ═══════════════════════════════════════════════
    // WITHDRAWAL (User withdraws from top position)
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

        console.log(`[COMPLETED] Slot ${slot._id}: $${slot.amount} → $${earning} for user ${slot.userId}`);

        // Shift positions down
        await QueueSlot.updateMany(
            { status: 'active', queueType: 'main', position: { $gt: 1 } },
            { $inc: { position: -1 } }
        );

        // Promote from waitlist
        if (settings.autoPromote) {
            await this.promoteFromWaitlist();
        }

        // Start timer for new #1
        await this.startTimerForTopSlot();

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

        // Update user status
        await User.findByIdAndUpdate(nextWaitlist.userId, { queueStatus: 'in_queue' });

        console.log(`[PROMOTE] Waitlist → Main queue position #${activeCount + 1}`);

        // Recursively fill more spots
        if (activeCount + 1 < settings.queueSize) {
            await this.promoteFromWaitlist();
        }
    }

    // ═══════════════════════════════════════════════
    // TIMER MANAGEMENT
    // ═══════════════════════════════════════════════

    async startTimerForTopSlot() {
        const settings = await this.getSettings();
        const topSlot = await QueueSlot.findOne({
            status: 'active',
            queueType: 'main',
            position: 1
        });

        if (topSlot && !topSlot.withdrawalDeadline) {
            const deadline = new Date();
            deadline.setHours(deadline.getHours() + settings.withdrawalTimerHours);
            topSlot.withdrawalDeadline = deadline;
            topSlot.timerStartedAt = new Date();
            await topSlot.save();
            console.log(`[TIMER] Started countdown for new #1 slot ${topSlot._id}`);
        }
    }

    // Admin: Extend timer
    async extendTimer(slotId, additionalHours) {
        const slot = await QueueSlot.findById(slotId);
        if (!slot || slot.status !== 'active') throw new Error('Active slot not found');
        if (!slot.withdrawalDeadline) throw new Error('Timer not started yet');

        const newDeadline = new Date(slot.withdrawalDeadline.getTime() + (additionalHours * 60 * 60 * 1000));
        slot.withdrawalDeadline = newDeadline;
        await slot.save();

        console.log(`[ADMIN] Timer extended by ${additionalHours}h for slot ${slotId}`);
        await this.broadcastState();
        return slot;
    }

    // Admin: Reactivate expired user
    async reactivateUser(userId) {
        const user = await User.findById(userId);
        if (!user) throw new Error('User not found');
        if (user.queueStatus !== 'expired') throw new Error('User is not expired');

        user.queueStatus = 'eligible';
        await user.save();

        console.log(`[ADMIN] Reactivated expired user ${userId}`);
        return user;
    }

    // ═══════════════════════════════════════════════
    // EXPIRY CHECK (runs periodically)
    // ═══════════════════════════════════════════════

    async checkExpiredSlots() {
        const expiredSlots = await QueueSlot.find({
            status: 'active',
            withdrawalDeadline: { $lte: new Date() },
            position: 1
        });

        for (const slot of expiredSlots) {
            await this.expireSlot(slot);
        }
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
                        // Cooldown before next cycle
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

        console.log(`[QUEUE] Active: ${mainCount}/${settings.queueSize} | Timer running: ${this.timerRunning}`);

        // Start cycle if queue is full
        if (mainCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        // Start periodic expiry check (every 60 seconds)
        if (this.expiryCheckInterval) clearInterval(this.expiryCheckInterval);
        this.expiryCheckInterval = setInterval(() => this.checkExpiredSlots(), 60000);

        // Run initial expiry check
        await this.checkExpiredSlots();

        // Ensure #1 position has timer started
        await this.startTimerForTopSlot();
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

            // Include timer info for top slot
            const topSlot = mainQueue.find(s => s.position === 1);
            let withdrawalTimer = null;
            if (topSlot && topSlot.withdrawalDeadline) {
                const remaining = Math.max(0, new Date(topSlot.withdrawalDeadline).getTime() - Date.now());
                withdrawalTimer = {
                    slotId: topSlot._id,
                    userId: topSlot.userId,
                    deadline: topSlot.withdrawalDeadline,
                    remainingMs: remaining,
                    remainingHours: Math.floor(remaining / (1000 * 60 * 60)),
                    remainingMinutes: Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60)),
                };
            }

            this.io.emit('queueUpdate', {
                mainQueue,
                waitlist,
                mainCount: mainQueue.length,
                waitlistCount: waitlist.length,
                queueSize: settings.queueSize,
                timer: this.cycleTimer,
                withdrawalTimer,
            });
        } catch (err) {
            console.error('[BROADCAST ERROR]', err);
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

        for (let i = 0; i < numDollars; i++) {
            const isMainQueue = currentMainCount < settings.queueSize;
            const slot = new QueueSlot({
                userId,
                amount: 1,
                queueType: isMainQueue ? 'main' : 'waitlist',
                status: isMainQueue ? 'active' : 'waiting',
            });

            if (isMainQueue) {
                slot.position = currentMainCount + 1;
                if (slot.position === 1) {
                    const deadline = new Date();
                    deadline.setHours(deadline.getHours() + settings.withdrawalTimerHours);
                    slot.withdrawalDeadline = deadline;
                    slot.timerStartedAt = new Date();
                }
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
