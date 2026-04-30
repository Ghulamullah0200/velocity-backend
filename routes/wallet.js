const express = require('express');
const router = express.Router();
const User = require('../models/User');
const QueueSlot = require('../models/QueueSlot');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// GET WALLET
// ═══════════════════════════════════════════════════
router.get('/', auth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    const activeSlots = await QueueSlot.countDocuments({ userId: req.userId, status: 'active' });
    const completedSlots = await QueueSlot.countDocuments({ userId: req.userId, status: 'completed' });

    res.json({
        wallet: user.wallet,
        activeSlots,
        maturedSlots: completedSlots,
        pinSet: user.pinSet,
        queueStatus: user.queueStatus
    });
}));

module.exports = router;
