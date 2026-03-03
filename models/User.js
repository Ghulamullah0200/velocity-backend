const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    status: { type: String, enum: ['Pending Verification', 'Verified', 'Admin', 'Withdraw Available', 'Red-List', 'Terminated'], default: 'Pending Verification' },
    balance: { type: Number, default: 0 },
    rank: { type: Number, default: 0 },
    isWithdrawEligible: { type: Boolean, default: false },
    paymentScreenshot: { type: String },
    accountDetails: {
        accountTitle: String,
        accountNumber: String,
        bankName: String
    }
}, { timestamps: true });

userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
