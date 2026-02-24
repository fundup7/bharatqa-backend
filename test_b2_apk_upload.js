const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

// Create a dummy APK file
const dummyApkPath = path.join(__dirname, 'dummy_app.apk');
fs.writeFileSync(dummyApkPath, 'This is a test APK content');

async function testUpload() {
    try {
        console.log('Testing APK upload to B2...');
        const form = new FormData();
        form.append('apk', fs.createReadStream(dummyApkPath));

        const response = await axios.post('http://localhost:3000/api/app/upload-apk', form, {
            headers: {
                ...form.getHeaders(),
                // Use the API key from local environment if provided
                'x-api-key': process.env.API_KEY || 'wtT8mu]R.9v*1k#6qDb;CA[)+2-D8#n_x)fe!!byQ.WMGJ>/p}DM7zSM9r,2y-H>'
            }
        });

        console.log('✅ Upload Success:', response.data);
    } catch (err) {
        console.error('❌ Upload Failed:');
        if (err.response) {
            console.error(err.response.data);
        } else {
            console.error(err.message);
        }
    } finally {
        if (fs.existsSync(dummyApkPath)) fs.unlinkSync(dummyApkPath);
    }
}

testUpload();
