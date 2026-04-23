const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
        type: String,
        enum: ['deposit', 'withdrawal', 'queue_entry', 'earning', 'invest', 'reinvest'],
        required: true,
        index: true
    },
    amount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'completed', 'rejected'],
        default: 'pending',
        index: true
    },
    screenshot: { type: String, default: null },
    accountDetails: {
        accountTitle: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        bankName: { type: String, default: '' }
    },
    description: { type: String, default: '' },
}, { timestamps: true });

transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1, createdAt: -1 }); // Admin queries

module.exports = mongoose.model('Transaction', transactionSchema);
