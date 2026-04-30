const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['system', 'deposit', 'withdrawal', 'queue', 'broadcast', 'manual'],
        default: 'system',
        index: true
    },
    // Target: null = broadcast to all, specific userId = targeted
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    // Metadata for linking to specific entities
    metadata: {
        transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
        amount: { type: Number, default: null },
    },
    // Delivery tracking
    sentViaFCM: { type: Boolean, default: false },
    fcmMessageId: { type: String, default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Admin who sent it (for manual/broadcast)
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Efficient queries for notification history
notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ targetUserId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
