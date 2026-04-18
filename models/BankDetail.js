const mongoose = require('mongoose');

const bankDetailSchema = new mongoose.Schema({
    accountNumber: { type: String, required: true, trim: true },
    bankName: { type: String, default: '', trim: true },
    accountTitle: { type: String, required: true, trim: true },
    additionalInstructions: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Indexes for efficient queries
bankDetailSchema.index({ isActive: -1 }); // Find active quickly
bankDetailSchema.index({ publishedAt: -1 }); // Get latest first

module.exports = mongoose.model('BankDetail', bankDetailSchema);
