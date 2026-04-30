const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    pin: { type: String, default: null },
    pinSet: { type: Boolean, default: false },
    wallet: {
        balance: { type: Number, default: 0 },
        activeInQueue: { type: Number, default: 0 },
        totalEarned: { type: Number, default: 0 },
    },
    accountDetails: {
        accountTitle: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        bankName: { type: String, default: '' }
    },
    status: {
        type: String,
        enum: ['active', 'suspended', 'terminated', 'admin'],
        default: 'active',
        index: true
    },
    queueStatus: {
        type: String,
        enum: ['eligible', 'in_queue', 'expired'],
        default: 'eligible',
        index: true
    },
    // ═══ ONE-TIME DEPOSIT SYSTEM ═══
    hasDeposited: { type: Boolean, default: false, index: true },
    depositStatus: {
        type: String,
        enum: ['none', 'pending', 'approved', 'rejected'],
        default: 'none',
        index: true
    },
    // ═══ LIFECYCLE TRACKING ═══
    lifecyclePhase: {
        type: String,
        enum: ['fresh', 'deposited', 'in_queue', 'withdrawal_eligible', 'withdrawal_pending', 'completed'],
        default: 'fresh',
        index: true
    },
    terminatedAt: { type: Date, default: null },
    // ═══ PUSH NOTIFICATIONS (FCM) ═══
    fcmToken: { type: String, default: null, index: true },
    lastActiveAt: { type: Date, default: null },
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function () {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 12);
    }
    if (this.isModified('pin') && this.pin) {
        this.pin = await bcrypt.hash(this.pin, 12);
        this.pinSet = true;
    }
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

userSchema.methods.comparePin = function (pin) {
    if (!this.pin) return Promise.resolve(false);
    return bcrypt.compare(pin, this.pin);
};

module.exports = mongoose.model('User', userSchema);
