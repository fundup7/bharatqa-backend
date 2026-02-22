const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');

const API_KEY = 'wtT8mu]R.9v*1k#6qDb;CA[)+2-D8#n_x)fe!!byQ.WMGJ>/p}DM7zSM9r,2y-H>';
const BACKEND_URL = 'https://bharatqa-backend.onrender.com';
const APK_PATH = 'D:\\BharatQA\\app\\build\\outputs\\apk\\debug\\app-debug.apk';

async function uploadAndRelease() {
    try {
        console.log(`1. Uploading APK from ${APK_PATH}...`);

        if (!fs.existsSync(APK_PATH)) {
            throw new Error(`APK file not found at ${APK_PATH}`);
        }

        const form = new FormData();
        form.append('apk', fs.createReadStream(APK_PATH));

        // Step 1: Upload to Backblaze
        const uploadRes = await axios.post(`${BACKEND_URL}/api/app/upload-apk`, form, {
            headers: {
                ...form.getHeaders(),
                'x-api-key': API_KEY
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        if (!uploadRes.data.success) {
            throw new Error('Upload failed: ' + JSON.stringify(uploadRes.data));
        }

        const b2Url = uploadRes.data.apk_url;
        console.log(`✅ Upload successful! B2 URL: ${b2Url}`);
        console.log(`\n2. Creating new release with version 1.3.0 (Code 4)...`);

        // Step 2: Create Release
        const releaseRes = await axios.post(`${BACKEND_URL}/api/app/release`, {
            version_code: 4,
            version_name: '1.3.0',
            apk_url: b2Url,
            release_notes: 'Fixed the APK Parse Error by migrating to Backblaze B2',
            is_mandatory: true,
            min_supported_version: 4
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            }
        });

        if (releaseRes.data.success) {
            console.log(`🎉 Release created successfully!`);
            console.log(releaseRes.data.version);
        } else {
            console.error('❌ Failed to create release:', releaseRes.data);
        }

    } catch (error) {
        console.error('\n❌ Error occurred:');
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

uploadAndRelease();
