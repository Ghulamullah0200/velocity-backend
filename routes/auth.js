const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════════════════
router.post('/register', asyncHandler(async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }

    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
        return res.status(400).json({
            message: existing.username === username ? 'Username already taken' : 'Email already in use'
        });
    }

    const user = new User({ username, email, password });
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    logger.info('AUTH', `User registered: ${username}`);

    res.status(201).json({
        message: 'Account created successfully',
        token,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            wallet: user.wallet,
            status: user.status,
            pinSet: user.pinSet,
            queueStatus: user.queueStatus,
            hasDeposited: user.hasDeposited,
            depositStatus: user.depositStatus,
            lifecyclePhase: user.lifecyclePhase
        }
    });
}));

// ═══════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════
router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: 'Invalid username or password' });
    }
    if (user.status === 'suspended') {
        return res.status(403).json({ message: 'Account has been suspended' });
    }
    if (user.status === 'terminated') {
        return res.status(403).json({ message: 'Account has been terminated. No further actions allowed.' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    logger.info('AUTH', `User logged in: ${username}`);

    res.json({
        token,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            wallet: user.wallet,
            status: user.status,
            pinSet: user.pinSet,
            queueStatus: user.queueStatus,
            hasDeposited: user.hasDeposited,
            depositStatus: user.depositStatus,
            lifecyclePhase: user.lifecyclePhase
        }
    });
}));

// ═══════════════════════════════════════════════════
// PIN SETUP & VERIFY
// ═══════════════════════════════════════════════════
router.post('/pin/setup', auth, asyncHandler(async (req, res) => {
    const { pin } = req.body;
    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        return res.status(400).json({ message: 'PIN must be exactly 4 digits' });
    }

    req.user.pin = pin;
    await req.user.save();
    res.json({ message: 'PIN set successfully', pinSet: true });
}));

router.post('/pin/verify', auth, asyncHandler(async (req, res) => {
    const { pin } = req.body;
    if (!req.user.pinSet) {
        return res.status(400).json({ message: 'PIN not set up yet' });
    }
    const isValid = await req.user.comparePin(pin);
    res.json({ valid: isValid });
}));

module.exports = router;
