const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Upload file to Supabase Storage
async function uploadFile(localPath, bucket, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    const fileName = `${uuidv4()}${ext}`;
    const filePath = `${fileName}`;

    const fileBuffer = fs.readFileSync(localPath);

    const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, fileBuffer, {
            contentType: getContentType(ext),
            upsert: false
        });

    if (error) throw new Error(`Upload failed: ${error.message}`);

    // Get public URL
    const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

    const url = urlData.publicUrl;
    console.log(`☁️ Uploaded to ${bucket}: ${fileName} (${Math.round(fileBuffer.length / 1024)}KB)`);

    return { path: filePath, url };
}

// Upload buffer directly (for AI frames)
async function uploadBuffer(buffer, bucket, fileName) {
    const ext = path.extname(fileName).toLowerCase();

    const { data, error } = await supabase.storage
        .from(bucket)
        .upload(fileName, buffer, {
            contentType: getContentType(ext),
            upsert: true
        });

    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);

    return { path: fileName, url: urlData.publicUrl };
}

// Delete file
async function deleteFile(bucket, filePath) {
    try {
        const { error } = await supabase.storage
            .from(bucket)
            .remove([filePath]);

        if (error) console.error(`Delete failed: ${error.message}`);
        else console.log(`🗑️ Deleted from ${bucket}: ${filePath}`);
    } catch (e) {
        console.error(`Delete error: ${e.message}`);
    }
}

// Delete multiple files
async function deleteFiles(bucket, filePaths) {
    try {
        const { error } = await supabase.storage
            .from(bucket)
            .remove(filePaths);

        if (error) console.error(`Bulk delete failed: ${error.message}`);
        else console.log(`🗑️ Deleted ${filePaths.length} files from ${bucket}`);
    } catch (e) {
        console.error(`Bulk delete error: ${e.message}`);
    }
}

function getContentType(ext) {
    const types = {
        '.mp4': 'video/mp4',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.apk': 'application/vnd.android.package-archive',
        '.webm': 'video/webm'
    };
    return types[ext] || 'application/octet-stream';
}

module.exports = { uploadFile, uploadBuffer, deleteFile, deleteFiles };