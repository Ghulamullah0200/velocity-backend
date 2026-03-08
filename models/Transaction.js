const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'velo_purchase'], required: true },
    amount: { type: Number, required: true },
    numVelos: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
    screenshot: { type: String },
    accountDetails: {
        accountTitle: String,
        accountNumber: String,
        bankName: String
    }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
