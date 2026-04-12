const QueueSlot = require('../models/QueueSlot');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');

class QueueEngine {
    constructor(io) {
        this.io = io;
        this.timerRunning = false;
        this.cycleTimer = 30;
    }

    // Get current settings
    async getSettings() {
        return await Settings.findOne() || { queueSize: 21, waitlistStart: 22, waitlistMax: 2222, maturityMultiplier: 2, cycleTimerSeconds: 30 };
    }

    // Get counts
    async getMainQueueCount() {
        return await QueueSlot.countDocuments({ status: 'queued', queueType: 'main' });
    }

    async getWaitlistCount() {
        return await QueueSlot.countDocuments({ status: 'queued', queueType: 'waitlist' });
    }

    // Place dollars into queue
    async invest(userId, numDollars) {
        const settings = await this.getSettings();
        const mainCount = await this.getMainQueueCount();

        // Atomically deduct from wallet
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

        if (!user) {
            throw new Error('Insufficient balance or account inactive');
        }

        const slots = [];
        let currentMainCount = mainCount;

        for (let i = 0; i < numDollars; i++) {
            const isMainQueue = currentMainCount < settings.queueSize;

            const slot = new QueueSlot({
                userId,
                amount: 1,
                queueType: isMainQueue ? 'main' : 'waitlist',
                status: 'queued',
            });

            if (isMainQueue) {
                slot.position = currentMainCount + 1;
                currentMainCount++;
            } else {
                // Assign waitlist number
                const lastWaitlist = await QueueSlot.findOne({ queueType: 'waitlist', status: 'queued' })
                    .sort({ waitlistNumber: -1 });
                slot.waitlistNumber = lastWaitlist
                    ? lastWaitlist.waitlistNumber + 1
                    : settings.waitlistStart;
                slot.position = 0; // Will be assigned when promoted
            }

            await slot.save();
            slots.push(slot);
        }

        // Record transaction
        await new Transaction({
            userId,
            type: 'invest',
            amount: numDollars,
            status: 'completed',
            description: `Invested $${numDollars} into ${slots.length} queue slot(s)`
        }).save();

        // Start cycle if queue is full
        const newMainCount = await this.getMainQueueCount();
        if (newMainCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }

        await this.broadcastState();
        return { slots, wallet: user.wallet };
    }

    // Process one maturation cycle
    async processCycle() {
        const settings = await this.getSettings();

        // Get position #1 slot
        const maturingSlot = await QueueSlot.findOne({
            status: 'queued',
            queueType: 'main',
            position: 1
        });

        if (!maturingSlot) return;

        // Mark as matured
        maturingSlot.status = 'matured';
        maturingSlot.maturedAt = new Date();
        maturingSlot.position = 0;
        await maturingSlot.save();

        const earning = maturingSlot.amount * settings.maturityMultiplier;

        // Credit user wallet atomically
        await User.findByIdAndUpdate(maturingSlot.userId, {
            $inc: {
                'wallet.balance': earning,
                'wallet.activeInQueue': -maturingSlot.amount,
                'wallet.totalEarned': earning
            }
        });

        // Record earning transaction
        await new Transaction({
            userId: maturingSlot.userId,
            type: 'earning',
            amount: earning,
            status: 'completed',
            description: `Queue slot matured: $${maturingSlot.amount} → $${earning}`
        }).save();

        console.log(`[CYCLE] Slot matured for user ${maturingSlot.userId}: $${maturingSlot.amount} → $${earning}`);

        // Shift all main queue positions down by 1
        await QueueSlot.updateMany(
            { status: 'queued', queueType: 'main', position: { $gt: 1 } },
            { $inc: { position: -1 } }
        );

        // Auto-promote from waitlist if enabled
        if (settings.autoPromote) {
            await this.promoteFromWaitlist();
        }

        await this.broadcastState();
    }

    // Promote waitlist entry to main queue
    async promoteFromWaitlist() {
        const settings = await this.getSettings();
        const mainCount = await this.getMainQueueCount();

        if (mainCount >= settings.queueSize) return;

        const nextWaitlist = await QueueSlot.findOne({
            status: 'queued',
            queueType: 'waitlist'
        }).sort({ waitlistNumber: 1 });

        if (!nextWaitlist) return;

        nextWaitlist.queueType = 'main';
        nextWaitlist.position = mainCount + 1;
        nextWaitlist.waitlistNumber = null;
        await nextWaitlist.save();

        console.log(`[PROMOTE] Waitlist → Main queue at position ${mainCount + 1}`);

        // Recursively fill if more space
        if (mainCount + 1 < settings.queueSize) {
            await this.promoteFromWaitlist();
        }
    }

    // Start the cycle timer
    startCycle() {
        if (this.timerRunning) return;
        this.timerRunning = true;

        Settings.findOne().then(settings => {
            this.cycleTimer = settings?.cycleTimerSeconds || 30;

            const interval = setInterval(async () => {
                this.cycleTimer--;
                this.io.emit('timerUpdate', this.cycleTimer);

                if (this.cycleTimer <= 0) {
                    clearInterval(interval);
                    this.timerRunning = false;
                    await this.processCycle();

                    const mainCount = await this.getMainQueueCount();
                    const settings = await this.getSettings();
                    if (mainCount >= settings.queueSize) {
                        this.startCycle();
                    }
                }
            }, 1000);
        });
    }

    // Initialize on server start
    async initialize() {
        const settings = await this.getSettings();
        const mainCount = await this.getMainQueueCount();

        console.log(`[QUEUE] Main: ${mainCount}/${settings.queueSize} | Timer running: ${this.timerRunning}`);

        if (mainCount >= settings.queueSize && !this.timerRunning) {
            this.startCycle();
        }
    }

    // Broadcast full state via Socket.io
    async broadcastState() {
        try {
            const mainQueue = await QueueSlot.find({ status: 'queued', queueType: 'main' })
                .sort({ position: 1 })
                .populate('userId', 'username');

            const waitlist = await QueueSlot.find({ status: 'queued', queueType: 'waitlist' })
                .sort({ waitlistNumber: 1 })
                .populate('userId', 'username');

            const settings = await this.getSettings();

            this.io.emit('queueUpdate', {
                mainQueue,
                waitlist,
                mainCount: mainQueue.length,
                waitlistCount: waitlist.length,
                queueSize: settings.queueSize,
                timer: this.cycleTimer
            });
        } catch (err) {
            console.error('[BROADCAST ERROR]', err);
        }
    }
}

module.exports = QueueEngine;
