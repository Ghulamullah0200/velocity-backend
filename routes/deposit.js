const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { asyncHandler } = require('../utils/helpers');
const logger = require('../utils/logger');
const cloudinaryService = require('../services/cloudinaryService');

// ═══════════════════════════════════════════════════
// DEPOSIT SETTINGS (Public — no auth required)
// ═══════════════════════════════════════════════════
router.get('/settings', asyncHandler(async (req, res) => {
    const settings = await Settings.findOne().lean();
    res.json({
        depositAmount: settings?.depositAmount ?? 1.00,
        maturityMultiplier: settings?.maturityMultiplier ?? 10,
    });
}));

// ═══════════════════════════════════════════════════
// SUBMIT DEPOSIT
// ═══════════════════════════════════════════════════
router.post('/', auth, upload.single('screenshot'), asyncHandler(async (req, res) => {
    const settings = await Settings.findOne();
    const requiredAmount = settings?.depositAmount ?? 1.00;

    const { amount } = req.body;
    const depositAmount = parseFloat(amount);

    if (!depositAmount || Math.abs(depositAmount - requiredAmount) > 0.001) {
        return res.status(400).json({ message: `Only $${requiredAmount.toFixed(2)} deposits are allowed` });
    }
    if (!req.file) {
        return res.status(400).json({ message: 'Payment screenshot required' });
    }

    const user = await User.findById(req.userId);

    if (user.status === 'terminated') {
        return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
    }
    if (user.hasDeposited === true) {
        return res.status(403).json({ message: 'Deposit already used. Wait for queue completion.' });
    }
    if (user.depositStatus === 'pending') {
        return res.status(403).json({ message: 'You already have a pending deposit awaiting approval.' });
    }
    if (user.queueStatus === 'expired') {
        return res.status(403).json({ message: 'Your account has expired. Please contact admin for reactivation.' });
    }

    // ═══ IMAGE: Upload to Cloudinary (cloud CDN), fallback to base64 ═══
    let screenshotData;

    if (cloudinaryService.isAvailable()) {
        const uploadResult = await cloudinaryService.uploadImage(
            req.file.buffer,
            'deposits',
            `deposit_${user.username}_${Date.now()}`
        );

        if (uploadResult) {
            screenshotData = uploadResult.url; // CDN URL
            logger.info('DEPOSIT', `Screenshot uploaded to Cloudinary: ${uploadResult.url}`);
        }
    }

    // Fallback: base64 in MongoDB
    if (!screenshotData) {
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype;
        screenshotData = `data:${mimeType};base64,${base64Image}`;
        logger.info('DEPOSIT', 'Screenshot stored as base64 (Cloudinary unavailable)');
    }

    const deposit = new Transaction({
        userId: req.userId,
        type: 'deposit',
        amount: requiredAmount,
        screenshot: screenshotData,
        status: 'pending',
        description: `Deposit request for $${requiredAmount.toFixed(2)}`
    });
    await deposit.save();

    user.depositStatus = 'pending';
    user.lifecyclePhase = 'deposited';
    await user.save();

    logger.info('DEPOSIT', `User ${user.username} submitted deposit of $${requiredAmount}`);
    res.json({ message: 'Deposit submitted! Awaiting admin verification.' });
}));

module.exports = router;
