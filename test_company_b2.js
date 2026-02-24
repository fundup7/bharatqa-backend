const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const BACKEND_URL = 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'BQAnkMj6rMoWsJBLHkX4Ptt49MPw6XYTJ1zzdODqv5Cj8oL5rVQcilfP9MWxn8xxZYa';

// Create a dummy APK file
const dummyApkPath = path.join(__dirname, 'test_company.apk');
fs.writeFileSync(dummyApkPath, 'This is a test company APK content');

async function testCompanyUpload() {
    try {
        console.log('Testing Company APK upload to B2 via /api/tests...');
        const form = new FormData();
        form.append('apk', fs.createReadStream(dummyApkPath));
        form.append('company_name', 'B2 Test Corp');
        form.append('app_name', 'B2 Storage Test');
        form.append('instructions', 'Test that APK goes to B2');
        form.append('company_id', '1'); // Assuming company 1 exists

        const response = await axios.post(`${BACKEND_URL}/api/tests`, form, {
            headers: {
                ...form.getHeaders(),
                'x-api-key': API_KEY
            }
        });

        console.log('✅ Upload Success:', response.data);
        console.log('URL received:', response.data.id); // Returns test ID

        // Note: The response only returns {id, message}. 
        // We'd need to fetch the test details to verify the URL structure.
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

testCompanyUpload();