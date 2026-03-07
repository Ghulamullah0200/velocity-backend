const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
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

userSchema.pre('save', async function (next) {
  // 1. Only hash the password if it has been modified (or is new)
    if (!this.isModified('password')) {
        return next();
    }

    try {
        // 2. Hash the password
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        
        // 3. In async hooks, you can just return or call next() 
        // but don't do both. This is the safest way:
        next();
    } catch (error) {
        next(error);
    }
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
