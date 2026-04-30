const mongoose = require('mongoose');

const appVersionSchema = new mongoose.Schema({
    latestVersion: { type: String, required: true, trim: true },  // e.g. "2.1.0"
    apkUrl: { type: String, required: true, trim: true },          // Download URL
    forceUpdate: { type: Boolean, default: false },                 // Block app usage until updated
    releaseNotes: { type: String, default: '' },                    // What changed
    minSupportedVersion: { type: String, default: '1.0.0' },       // Versions below this MUST update
    checksum: { type: String, default: '' },                        // SHA-256 for APK integrity
    fileSize: { type: Number, default: 0 },                         // APK size in bytes
    isActive: { type: Boolean, default: true, index: true },        // Only one active version
    publishedAt: { type: Date, default: Date.now },
}, { timestamps: true });

appVersionSchema.index({ isActive: 1, publishedAt: -1 });

// Static: Get the currently active version config
appVersionSchema.statics.getActiveVersion = async function () {
    return this.findOne({ isActive: true }).sort({ publishedAt: -1 }).lean();
};

// Helper: Compare semver versions — returns -1, 0, or 1
appVersionSchema.statics.compareVersions = function (v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const a = parts1[i] || 0;
        const b = parts2[i] || 0;
        if (a > b) return 1;
        if (a < b) return -1;
    }
    return 0;
};

module.exports = mongoose.model('AppVersion', appVersionSchema);
