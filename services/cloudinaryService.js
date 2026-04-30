/**
 * Cloudinary Service — Cloud-based screenshot storage
 * 
 * Replaces base64 storage in MongoDB with CDN-hosted URLs.
 * Images are stored immutably and served via Cloudinary CDN.
 * 
 * Setup: npm install cloudinary
 * Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 */
const logger = require('../utils/logger');

let cloudinary = null;

// Lazy initialization — only load if env vars are set
function getCloudinary() {
    if (cloudinary) return cloudinary;

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || cloudName === 'your_cloud_name' || !apiKey || apiKey === 'your_api_key') {
        logger.warn('CLOUDINARY', 'Not configured — screenshots will use base64 MongoDB storage');
        return null;
    }

    try {
        const { v2: sdk } = require('cloudinary');
        sdk.config({
            cloud_name: cloudName,
            api_key: apiKey,
            api_secret: apiSecret,
            secure: true
        });
        cloudinary = sdk;
        logger.info('CLOUDINARY', 'Initialized successfully');
        return cloudinary;
    } catch (err) {
        logger.error('CLOUDINARY', 'Failed to initialize — install with: npm install cloudinary', err.message);
        return null;
    }
}

/**
 * Upload a file buffer to Cloudinary
 * @param {Buffer} fileBuffer - Image buffer from multer
 * @param {string} folder - Folder name in Cloudinary (e.g. 'deposits', 'receipts')
 * @param {string} publicId - Optional custom public ID
 * @returns {Promise<{url: string, publicId: string, bytes: number} | null>}
 */
async function uploadImage(fileBuffer, folder = 'deposits', publicId = null) {
    const sdk = getCloudinary();
    if (!sdk) return null; // Fallback to base64

    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = sdk.uploader.upload_stream(
                {
                    folder: `velocity-cash/${folder}`,
                    public_id: publicId || undefined,
                    resource_type: 'image',
                    transformation: [
                        { quality: 'auto:good', fetch_format: 'auto' }, // Auto-optimize
                    ],
                    overwrite: false,
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            uploadStream.end(fileBuffer);
        });

        logger.info('CLOUDINARY', `Uploaded: ${result.secure_url} (${result.bytes} bytes)`);

        return {
            url: result.secure_url,
            publicId: result.public_id,
            bytes: result.bytes,
            format: result.format,
            width: result.width,
            height: result.height
        };
    } catch (err) {
        logger.error('CLOUDINARY', `Upload failed: ${err.message}`);
        return null;
    }
}

/**
 * Delete an image from Cloudinary
 * @param {string} publicId - The public ID to delete
 */
async function deleteImage(publicId) {
    const sdk = getCloudinary();
    if (!sdk || !publicId) return false;

    try {
        await sdk.uploader.destroy(publicId);
        logger.info('CLOUDINARY', `Deleted: ${publicId}`);
        return true;
    } catch (err) {
        logger.error('CLOUDINARY', `Delete failed: ${err.message}`);
        return false;
    }
}

/**
 * Check if Cloudinary is configured and available
 */
function isAvailable() {
    return getCloudinary() !== null;
}

module.exports = { uploadImage, deleteImage, isAvailable };
