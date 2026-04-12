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
        enum: ['active', 'suspended', 'admin'],
        default: 'active'
    }
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
