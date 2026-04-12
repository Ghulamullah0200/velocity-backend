const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    queueSize: { type: Number, default: 21 },
    waitlistStart: { type: Number, default: 22 },
    waitlistMax: { type: Number, default: 2222 },
    maturityMultiplier: { type: Number, default: 2 },
    cycleTimerSeconds: { type: Number, default: 30 },
    autoPromote: { type: Boolean, default: true },
    minDeposit: { type: Number, default: 1 },
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);
