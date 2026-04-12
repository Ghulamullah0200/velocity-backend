const mongoose = require('mongoose');

const queueSlotSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, default: 1 },
    position: { type: Number, default: 0, index: true },
    status: {
        type: String,
        enum: ['queued', 'matured', 'withdrawn', 'cancelled'],
        default: 'queued',
        index: true
    },
    queueType: {
        type: String,
        enum: ['main', 'waitlist'],
        default: 'main',
        index: true
    },
    waitlistNumber: { type: Number, default: null },
    maturedAt: { type: Date, default: null },
}, { timestamps: true });

// Compound indexes for common queries
queueSlotSchema.index({ status: 1, queueType: 1, position: 1 });
queueSlotSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('QueueSlot', queueSlotSchema);
