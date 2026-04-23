const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    queueSize: { type: Number, default: 21 },
    waitlistStart: { type: Number, default: 22 },
    waitlistMax: { type: Number, default: 2222 },
    maturityMultiplier: { type: Number, default: 10 },
    cycleTimerSeconds: { type: Number, default: 5 },
    cooldownSeconds: { type: Number, default: 15 },
    autoPromote: { type: Boolean, default: true },
    minDeposit: { type: Number, default: 1 },
    maxDeposit: { type: Number, default: 1 }, // Enforced $1 only
    withdrawalTimerHours: { type: Number, default: 20 }, // 20-hour countdown
    allowAutoReentry: { type: Boolean, default: false }, // Expired users cannot re-enter
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);
