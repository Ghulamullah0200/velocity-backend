const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth, pinVerify } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// WITHDRAW
// ═══════════════════════════════════════════════════
router.post('/', auth, pinVerify, asyncHandler(async (req, res) => {
    const { amount, accountDetails } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
        return res.status(400).json({ message: 'Invalid withdrawal amount' });
    }

    const userCheck = await User.findById(req.userId);
    if (userCheck.status === 'terminated') {
        return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
    }

    // Atomic deduction
    const user = await User.findOneAndUpdate(
        { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
        { $inc: { 'wallet.balance': -withdrawAmount } },
        { new: true }
    );

    if (!user) {
        return res.status(400).json({ message: 'Insufficient balance' });
    }

    if (accountDetails) {
        user.accountDetails = accountDetails;
        await user.save();
    }

    const withdrawal = new Transaction({
        userId: req.userId,
        type: 'withdrawal',
        amount: withdrawAmount,
        accountDetails: accountDetails || user.accountDetails,
        status: 'pending',
        description: `Withdrawal request for $${withdrawAmount}`
    });
    await withdrawal.save();

    res.json({ message: 'Withdrawal request submitted!', wallet: user.wallet });
}));

// ═══════════════════════════════════════════════════
// WITHDRAW ALL
// ═══════════════════════════════════════════════════
router.post('/all', auth, pinVerify, asyncHandler(async (req, res) => {
    const { accountDetails } = req.body;
    const user = await User.findById(req.userId);

    if (!user || user.wallet.balance <= 0) {
        return res.status(400).json({ message: 'No balance to withdraw' });
    }
    if (user.status === 'terminated') {
        return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
    }

    const withdrawAmount = user.wallet.balance;

    const updated = await User.findOneAndUpdate(
        { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
        { $inc: { 'wallet.balance': -withdrawAmount } },
        { new: true }
    );

    if (!updated) return res.status(400).json({ message: 'Failed to process' });

    if (accountDetails) {
        updated.accountDetails = accountDetails;
        await updated.save();
    }

    const withdrawal = new Transaction({
        userId: req.userId,
        type: 'withdrawal',
        amount: withdrawAmount,
        accountDetails: accountDetails || updated.accountDetails,
        status: 'pending',
        description: `Full withdrawal of $${withdrawAmount}`
    });
    await withdrawal.save();

    res.json({ message: 'Full withdrawal submitted!', wallet: updated.wallet });
}));

// ═══════════════════════════════════════════════════
// CANCEL WITHDRAW
// ═══════════════════════════════════════════════════
router.post('/:id/cancel', auth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findOne({
        _id: req.params.id,
        userId: req.userId,
        type: 'withdrawal',
        status: 'pending'
    });

    if (!transaction) return res.status(404).json({ message: 'Pending withdrawal not found' });

    await User.findByIdAndUpdate(req.userId, {
        $inc: { 'wallet.balance': transaction.amount }
    });

    transaction.status = 'rejected';
    transaction.description += ' (Cancelled by user)';
    await transaction.save();

    const user = await User.findById(req.userId);
    res.json({ message: 'Withdrawal cancelled and refunded', wallet: user.wallet });
}));

module.exports = router;
