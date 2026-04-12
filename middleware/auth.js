const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Standard JWT auth middleware
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Authentication required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) return res.status(401).json({ message: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ message: 'Account suspended' });

        req.user = user;
        req.userId = user._id;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};

// Admin-only middleware (use after auth)
const adminAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Authentication required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user || user.status !== 'admin') {
            return res.status(403).json({ message: 'Admin access required' });
        }

        req.user = user;
        req.userId = user._id;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};

// PIN verification middleware (use after auth)
const pinVerify = async (req, res, next) => {
    try {
        const { pin } = req.body;
        if (!pin) return res.status(400).json({ message: 'PIN required for this action' });

        const user = req.user;
        if (!user.pinSet) return res.status(400).json({ message: 'Please set up your PIN first' });

        const isValid = await user.comparePin(pin);
        if (!isValid) return res.status(403).json({ message: 'Invalid PIN' });

        next();
    } catch (err) {
        res.status(500).json({ message: 'PIN verification failed' });
    }
};

module.exports = { auth, adminAuth, pinVerify };
