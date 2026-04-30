const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    action: { type: String, required: true, index: true },  // e.g. 'user.bulk_delete', 'deposit.verify'
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetType: { type: String, default: '' },  // 'user', 'transaction', 'settings'
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },  // Flexible payload
    ipAddress: { type: String, default: '' },
}, { timestamps: true });

auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
