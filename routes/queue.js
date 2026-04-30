const express = require('express');
const router = express.Router();
const User = require('../models/User');
const QueueSlot = require('../models/QueueSlot');
const BankDetail = require('../models/BankDetail');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// GET QUEUE (User-facing)
// ═══════════════════════════════════════════════════
router.get('/', auth, asyncHandler(async (req, res) => {
    const mainQueue = await QueueSlot.find({ status: 'active', queueType: 'main' })
        .sort({ position: 1 })
        .populate('userId', 'username');
    const waitlist = await QueueSlot.find({ status: 'waiting', queueType: 'waitlist' })
        .sort({ waitlistNumber: 1 })
        .populate('userId', 'username');

    const settings = await req.queueEngine.getSettings();

    res.json({
        mainQueue,
        waitlist,
        queueSize: settings.queueSize,
        mainCount: mainQueue.length,
        waitlistCount: waitlist.length,
        timer: req.queueEngine.cycleTimer,
        timerRunning: req.queueEngine.timerRunning,
    });
}));

// ═══════════════════════════════════════════════════
// MY POSITIONS
// ═══════════════════════════════════════════════════
router.get('/my-positions', auth, asyncHandler(async (req, res) => {
    const slots = await QueueSlot.find({
        userId: req.userId,
        status: { $in: ['active', 'waiting', 'completed'] }
    }).sort({ position: 1 });

    res.json({
        queued: slots.filter(s => s.status === 'active' && s.queueType === 'main'),
        waitlisted: slots.filter(s => s.status === 'waiting' && s.queueType === 'waitlist'),
        matured: slots.filter(s => s.status === 'completed'),
    });
}));

// ═══════════════════════════════════════════════════
// CLAIM (User at #1 claims their earning)
// ═══════════════════════════════════════════════════
const { pinVerify } = require('../middleware/auth');

router.post('/claim', auth, pinVerify, asyncHandler(async (req, res) => {
    const topSlot = await QueueSlot.findOne({
        userId: req.userId,
        status: 'active',
        queueType: 'main',
        position: 1
    });

    if (!topSlot) {
        return res.status(400).json({ message: 'You are not at the top of the queue' });
    }

    const userCheck = await User.findById(req.userId);
    if (userCheck?.status === 'terminated') {
        return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
    }

    const result = await req.queueEngine.completeWithdrawal(topSlot._id, req.userId);

    res.json({
        message: `Queue completed! You earned $${result.earning}`,
        earning: result.earning,
        wallet: result.wallet
    });
}));

// ═══════════════════════════════════════════════════
// BANK DETAILS (Public)
// ═══════════════════════════════════════════════════
router.get('/bank-details', asyncHandler(async (req, res) => {
    const activeDetail = await BankDetail.findOne({ isActive: true }).sort({ publishedAt: -1 });
    if (!activeDetail) {
        return res.json({ message: 'No bank details published yet' });
    }
    res.json(activeDetail);
}));

// ═══════════════════════════════════════════════════
// TOPPERS (Public — shows current #1 and upcoming #2)
// ═══════════════════════════════════════════════════
router.get('/toppers', asyncHandler(async (req, res) => {
    const topSlots = await QueueSlot.find({
        status: 'active',
        queueType: 'main',
        position: { $in: [1, 2] }
    })
        .sort({ position: 1 })
        .populate('userId', 'username')
        .lean();

    const currentTopper = topSlots.find(s => s.position === 1);
    const upcomingTopper = topSlots.find(s => s.position === 2);

    res.json({
        currentTopper: currentTopper ? {
            username: currentTopper.userId?.username || 'Unknown',
            position: 1,
            amount: currentTopper.amount,
            joinedAt: currentTopper.createdAt,
        } : null,
        upcomingTopper: upcomingTopper ? {
            username: upcomingTopper.userId?.username || 'Unknown',
            position: 2,
            amount: upcomingTopper.amount,
            joinedAt: upcomingTopper.createdAt,
        } : null,
    });
}));

module.exports = router;
