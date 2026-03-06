const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    position: { type: Number, default: 0 }, // Position in activeQueue
    status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
    amount: { type: Number, default: 1 } // Entry fee at time of joining
}, { timestamps: true });

module.exports = mongoose.model('Entry', entrySchema);
