const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    status: { type: String, enum: ['Pending Verification', 'Verified', 'Admin', 'Withdraw Available', 'Red-List', 'Terminated'], default: 'Pending Verification' },
    balance: { type: Number, default: 0 },
    rank: { type: Number, default: 0 },
    velosOwned: { type: Number, default: 0 },
    isWithdrawEligible: { type: Boolean, default: false },
    paymentScreenshot: { type: String },
    accountDetails: {
        accountTitle: String,
        accountNumber: String,
        bankName: String
    }
}, { timestamps: true });

userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;

    try {
        this.password = await bcrypt.hash(this.password, 10);
    } catch (err) {
        console.error('[USER MODEL] Hashing failed:', err);
        throw err;
    }
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
