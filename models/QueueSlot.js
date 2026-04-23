const mongoose = require('mongoose');

const queueSlotSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, default: 1 },
    position: { type: Number, default: 0, index: true },
    status: {
        type: String,
        enum: ['active', 'waiting', 'completed', 'expired', 'cancelled'],
        default: 'waiting',
        index: true
    },
    queueType: {
        type: String,
        enum: ['main', 'waitlist'],
        default: 'main',
        index: true
    },
    waitlistNumber: { type: Number, default: null },
    // Withdrawal timer fields
    withdrawalDeadline: { type: Date, default: null },
    timerStartedAt: { type: Date, default: null },
    // Tracking
    completedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    depositTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
}, { timestamps: true });

// Compound indexes for common queries — O(log n) lookups
queueSlotSchema.index({ status: 1, queueType: 1, position: 1 });
queueSlotSchema.index({ userId: 1, status: 1 });
queueSlotSchema.index({ status: 1, withdrawalDeadline: 1 }); // For expiry checks
queueSlotSchema.index({ queueType: 1, waitlistNumber: 1 }); // Waitlist ordering

module.exports = mongoose.model('QueueSlot', queueSlotSchema);
