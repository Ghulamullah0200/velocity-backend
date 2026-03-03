const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    entryFee: { type: Number, default: 1 }, // Default $1
    minDeposit: { type: Number, default: 1 },
    maxDepositLimitForFixed: { type: Number, default: 2 }, // > $2 rule
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);
