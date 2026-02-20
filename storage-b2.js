// storage-b2.js — Backblaze B2 Private Bucket (10GB free, no credit card)
const { 
    S3Client, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand 
} = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const b2Client = new S3Client({
    region: 'us-west-004', // ← Check your bucket's region
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APP_KEY,
    },
    forcePathStyle: true,
});

const BUCKET = process.env.B2_BUCKET_NAME || 'bharatqa-recordings';

async function uploadVideo(filePath, originalName) {
    try {
        const timestamp = Date.now();
        const ext = path.extname(originalName) || '.mp4';
        const key = `recordings/${timestamp}_${Math.random().toString(36).slice(2, 8)}${ext}`;

        // Check file exists and has content
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const fileStats = fs.statSync(filePath);
        const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(1);

        if (fileStats.size === 0) {
            throw new Error('File is empty (0 bytes)');
        }

        console.log(`📹 Uploading to B2: ${fileSizeMB} MB from ${filePath}`);

        const fileStream = fs.createReadStream(filePath);

        await b2Client.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: fileStream,
            ContentLength: fileStats.size,
            ContentType: 'video/mp4',
        }));

        console.log(`✅ Video → B2: ${key} (${fileSizeMB} MB)`);
        return { path: key };
    } catch (err) {
        console.error('❌ B2 upload failed:', err.message);
        throw err;
    }
}

// Stream video from B2 (for proxy endpoint)
async function getVideoStream(key) {
    const response = await b2Client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }));
    return response;
}

// Delete video from B2
async function deleteVideo(key) {
    try {
        await b2Client.send(new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: key,
        }));
        console.log(`🗑️ B2 deleted: ${key}`);
    } catch (err) {
        console.error('B2 delete error:', err.message);
    }
}

// Delete multiple videos
async function deleteVideos(keys) {
    for (const key of keys) {
        await deleteVideo(key);
    }
}

module.exports = { uploadVideo, getVideoStream, deleteVideo, deleteVideos };