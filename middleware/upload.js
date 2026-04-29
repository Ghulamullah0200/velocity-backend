const multer = require('multer');
const path = require('path');

// ═══════════════════════════════════════════════════
// USE MEMORY STORAGE instead of disk storage.
// Railway has an ephemeral filesystem — files saved to
// disk are lost on every deploy/restart.  By keeping
// the buffer in memory we can convert it to a base64
// data-URI and persist it directly in MongoDB.
// ═══════════════════════════════════════════════════

const storage = multer.memoryStorage();

// File filter - only images
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        cb(new Error('Only JPG, PNG, and GIF images are allowed'));
    }
};

// Limits: 5MB
const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

module.exports = upload;
