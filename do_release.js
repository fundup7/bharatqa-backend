const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');

const API_KEY = 'BQAnkMj6rMoWsJBLHkX4Ptt49MPw6XYTJ1zzdODqv5Cj8oL5rVQcilfP9MWxn8xxZYa';
const BACKEND_URL = 'https://bharatqa-backend.onrender.com';
const APK_PATH = 'D:\\BharatQA\\app\\build\\outputs\\apk\\release\\app-release.apk';

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
        console.log(`\n2. Creating new release with version 1.4.0 (Code 5)...`);

        // Step 2: Create Release
        const releaseRes = await axios.post(`${BACKEND_URL}/api/app/release`, {
            version_code: 7,
            version_name: '1.6.0',
            apk_url: b2Url,
            release_notes: 'Better UI, Payment Integration, New Dashboard',
            is_mandatory: true,
            min_supported_version: 7
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
