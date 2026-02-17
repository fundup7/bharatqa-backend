require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process'); // ← Add this

// Fix ffprobe permissions on Render
try {
  const ffprobePath = path.join(__dirname, 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe');
  if (fs.existsSync(ffprobePath)) {
    execSync(`chmod +x "${ffprobePath}"`);
    console.log('✅ ffprobe permissions fixed');
  }
} catch (e) {
  console.log('⚠️ ffprobe chmod skipped:', e.message);
}

// Also fix ffmpeg if you use it
try {
  const ffmpegPath = path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(ffmpegPath)) {
    execSync(`chmod +x "${ffmpegPath}"`);
    console.log('✅ ffmpeg permissions fixed');
  }
} catch (e) {
  console.log('⚠️ ffmpeg chmod skipped:', e.message);
}

const db = require('./db');
const storage = require('./storage');
const { analyzeBugReport } = require('./ai-analyzer-cloud');

const app = express();
app.use(cors());
app.use(express.json());

// Temp folder for uploads before sending to Supabase
const tempDir = path.join(__dirname, 'temp-uploads');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
const upload = multer({ dest: tempDir, limits: { fileSize: 500 * 1024 * 1024 } });

// ============================================
// COMPANY ENDPOINTS
// ============================================

// ============================================
// COMPANY ENDPOINTS
// ============================================

// Create test (linked to company)
app.post('/api/tests', upload.single('apk'), async (req, res) => {
  try {
    const { company_name, app_name, instructions, company_id } = req.body;

    // DEBUG: Log what we receive
    console.log('📦 req.body:', req.body);
    console.log('📦 company_id:', company_id, 'type:', typeof company_id);

    if (!company_name || !app_name || !instructions) {
      return res.status(400).json({ error: 'company_name, app_name, and instructions required' });
    }

    if (!company_id) {
      return res.status(400).json({ error: 'company_id is required' });
    }

    let apk_file_url = null, apk_file_path = null;

    if (req.file) {
      const result = await storage.uploadFile(req.file.path, 'apks', req.file.originalname);
      apk_file_url = result.url;
      apk_file_path = result.path;
      fs.unlinkSync(req.file.path);
    }

    const query = `INSERT INTO tests (company_name, app_name, apk_file_url, apk_file_path, instructions, company_id) 
                   VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
    const result = await db.query(query, [
      company_name, app_name, apk_file_url, apk_file_path, instructions,
      parseInt(company_id)  // ← Force integer, not string
    ]);

    console.log('✅ Test created with company_id:', parseInt(company_id));
    res.json({ id: result.rows[0].id, message: 'Test created!' });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('❌ Test creation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AUTH ENDPOINTS
// ============================================

// Google Sign In — verify token and create/login company
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({ error: 'No credential provided' });
        }

        // Decode Google JWT token (it's base64 encoded)
        const parts = credential.split('.');
        if (parts.length !== 3) {
            return res.status(400).json({ error: 'Invalid token format' });
        }

        // Decode payload (middle part)
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

        const { sub: googleId, email, name, picture } = payload;

        if (!googleId || !email) {
            return res.status(400).json({ error: 'Invalid token data' });
        }

        // Check if company already exists
        const existing = await db.query(
            'SELECT * FROM companies WHERE google_id = $1',
            [googleId]
        );

        let company;

        if (existing.rows.length > 0) {
            // Existing company — update last login
            await db.query(
                'UPDATE companies SET last_login = NOW(), name = $1, picture = $2 WHERE google_id = $3',
                [name, picture, googleId]
            );
            company = existing.rows[0];
            company.name = name;
            company.picture = picture;
            console.log(`🔑 Company logged in: ${email}`);
        } else {
            // New company — create account
            const result = await db.query(
                'INSERT INTO companies (google_id, email, name, picture) VALUES ($1, $2, $3, $4) RETURNING *',
                [googleId, email, name, picture]
            );
            company = result.rows[0];
            console.log(`🆕 New company registered: ${email}`);
        }

        // In the res.json at the end of /api/auth/google
res.json({
  success: true,
  company: {
    id: company.id,
    email: company.email,
    name: company.name,
    picture: company.picture,
    company_name: company.company_name,
    industry: company.industry,
    onboarding_complete: company.onboarding_complete || false
  }
});

    } catch (err) {
        console.error('Auth error:', err.message);
        res.status(500).json({ error: 'Authentication failed: ' + err.message });
    }
});

// Complete company onboarding profile
app.put('/api/auth/onboarding/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { 
      company_name, industry, company_size, 
      role, phone, website, referral_source 
    } = req.body;

    if (!company_name || !industry || !company_size || !role || !phone) {
      return res.status(400).json({ 
        error: 'Please fill all required fields' 
      });
    }

    const result = await db.query(
      `UPDATE companies SET 
        company_name = $1, industry = $2, company_size = $3,
        role = $4, phone = $5, website = $6, referral_source = $7,
        onboarding_complete = TRUE
      WHERE id = $8 RETURNING *`,
      [company_name, industry, company_size, role, phone, 
       website || null, referral_source || null, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    console.log(`✅ Onboarding complete: ${company_name}`);
    res.json({ 
      success: true, 
      company: result.rows[0] 
    });

  } catch (err) {
    console.error('Onboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get company profile
app.get('/api/auth/profile/:companyId', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, email, name, picture, created_at FROM companies WHERE id = $1',
            [req.params.companyId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create test (now linked to company)
app.post('/api/tests', upload.single('apk'), async (req, res) => {
    try {
        const { company_name, app_name, instructions, company_id } = req.body;

        if (!company_name || !app_name || !instructions) {
            return res.status(400).json({ error: 'company_name, app_name, and instructions required' });
        }

        let apk_file_url = null, apk_file_path = null;

        if (req.file) {
            const result = await storage.uploadFile(req.file.path, 'apks', req.file.originalname);
            apk_file_url = result.url;
            apk_file_path = result.path;
            fs.unlinkSync(req.file.path);
        }

        const query = `INSERT INTO tests (company_name, app_name, apk_file_url, apk_file_path, instructions, company_id) 
                        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        const result = await db.query(query, [
            company_name, app_name, apk_file_url, apk_file_path, instructions,
            company_id || null
        ]);

        res.json({ id: result.rows[0].id, message: 'Test created!' });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

// Get tests for a specific company
app.get('/api/company/:companyId/tests', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM tests WHERE company_id = $1 ORDER BY created_at DESC',
            [req.params.companyId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tests/:id', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM tests WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// SETTINGS ENDPOINTS
// ============================================

// Get full company profile
app.get('/api/auth/company/:companyId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, name, picture, company_name, industry, 
       company_size, role, phone, website, referral_source,
       onboarding_complete, created_at, last_login
       FROM companies WHERE id = $1`,
      [req.params.companyId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update company profile (settings)
app.put('/api/auth/company/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { 
      company_name, industry, company_size, 
      role, phone, website, referral_source 
    } = req.body;

    if (!company_name || !industry || !company_size || !role || !phone) {
      return res.status(400).json({ 
        error: 'Please fill all required fields' 
      });
    }

    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) {
      return res.status(400).json({ 
        error: 'Please enter a valid 10-digit phone number' 
      });
    }

    const result = await db.query(
      `UPDATE companies SET 
        company_name = $1, industry = $2, company_size = $3,
        role = $4, phone = $5, website = $6, referral_source = $7
       WHERE id = $8 RETURNING *`,
      [company_name, industry, company_size, role, 
       phoneClean, website || null, referral_source || null, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    console.log(`✅ Profile updated: ${company_name}`);
    res.json({ 
      success: true, 
      company: result.rows[0] 
    });

  } catch (err) {
    console.error('Settings update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete company account
app.delete('/api/auth/company/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    // Delete all tests owned by this company first
    await db.query(
      'DELETE FROM tests WHERE company_id = $1', 
      [companyId]
    );
    
    // Delete the company
    const result = await db.query(
      'DELETE FROM companies WHERE id = $1 RETURNING email', 
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    console.log(`🗑️ Account deleted: ${result.rows[0].email}`);
    res.json({ success: true, message: 'Account deleted' });

  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TESTER ENDPOINTS
// ============================================

// Register new tester
// Register or Login tester (with Google support)
app.post('/api/testers/register', async (req, res) => {
    try {
        const {
            full_name, phone, upi_id, 
            google_id, email, profile_picture, // New fields
            device_model, android_version, screen_resolution,
            latitude, longitude, city, state, full_address
        } = req.body;

        // We need at least a phone number OR a google_id to proceed
        if (!phone && !google_id) {
            return res.status(400).json({ error: 'Phone number or Google ID required' });
        }

        const phoneClean = phone ? phone.replace(/\D/g, '') : null;

        // 1. Try to find existing user by Google ID or Phone
        let existing = null;
        
        if (google_id) {
            const r = await db.query('SELECT * FROM testers WHERE google_id = $1', [google_id]);
            if (r.rows.length > 0) existing = r.rows[0];
        }
        
        if (!existing && phoneClean) {
            const r = await db.query('SELECT * FROM testers WHERE phone = $1', [phoneClean]);
            if (r.rows.length > 0) existing = r.rows[0];
        }

        let tester;

        if (existing) {
            // UPDATE existing user
            const result = await db.query(
                `UPDATE testers SET 
                full_name = COALESCE($1, full_name), 
                upi_id = COALESCE($2, upi_id),
                google_id = COALESCE($3, google_id),
                email = COALESCE($4, email),
                profile_picture = COALESCE($5, profile_picture),
                device_model = COALESCE($6, device_model),
                android_version = COALESCE($7, android_version),
                screen_resolution = COALESCE($8, screen_resolution),
                latitude = COALESCE($9, latitude),
                longitude = COALESCE($10, longitude),
                city = COALESCE($11, city),
                state = COALESCE($12, state),
                full_address = COALESCE($13, full_address),
                phone = COALESCE($14, phone),
                last_active = NOW()
                WHERE id = $15 RETURNING *`,
                [
                    full_name, upi_id, google_id, email, profile_picture,
                    device_model, android_version, screen_resolution,
                    latitude, longitude, city, state, full_address,
                    phoneClean, existing.id
                ]
            );
            tester = result.rows[0];
            console.log(`✅ Tester updated: ${tester.full_name}`);
        } else {
            // INSERT new user
            const result = await db.query(
                `INSERT INTO testers (
                    full_name, phone, upi_id, google_id, email, profile_picture,
                    device_model, android_version, screen_resolution,
                    latitude, longitude, city, state, full_address
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
                RETURNING *`,
                [
                    full_name, phoneClean, upi_id, google_id, email, profile_picture,
                    device_model, android_version, screen_resolution,
                    latitude || 0, longitude || 0, city || 'Unknown', 
                    state || 'Unknown', full_address || 'Unknown'
                ]
            );
            tester = result.rows[0];
            console.log(`✨ New tester registered: ${tester.full_name}`);
        }

        res.json({
            success: true,
            tester: {
                id: tester.id,
                full_name: tester.full_name,
                phone: tester.phone,
                email: tester.email,
                google_id: tester.google_id,
                profile_picture: tester.profile_picture,
                upi_id: tester.upi_id,
                total_tests: tester.total_tests || 0,
                total_earnings: tester.total_earnings || 0
            }
        });

    } catch (err) {
        console.error('Tester register error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get tester profile
app.get('/api/testers/:testerId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM testers WHERE id = $1', 
      [req.params.testerId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tester not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update tester UPI
app.put('/api/testers/:testerId/upi', async (req, res) => {
  try {
    const { upi_id } = req.body;
    if (!upi_id) {
      return res.status(400).json({ error: 'UPI ID is required' });
    }
    
    const result = await db.query(
      'UPDATE testers SET upi_id = $1 WHERE id = $2 RETURNING *',
      [upi_id, req.params.testerId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tester not found' });
    }
    
    res.json({ success: true, tester: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update tester location (called on each test)
app.put('/api/testers/:testerId/location', async (req, res) => {
  try {
    const { latitude, longitude, city, state, full_address } = req.body;
    await db.query(
      `UPDATE testers SET 
        latitude = $1, longitude = $2, city = $3, 
        state = $4, full_address = $5, last_active = NOW()
      WHERE id = $6`,
      [latitude || 0, longitude || 0, city || 'Unknown', 
       state || 'Unknown', full_address || 'Unknown', 
       req.params.testerId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/testers/google/:googleId
app.get('/api/testers/google/:googleId', async (req, res) => {
    try {
        const { googleId } = req.params;
        // Use db.query, NOT supabase.from
        const result = await db.query('SELECT * FROM testers WHERE google_id = $1', [googleId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tester not found' });
        }

        res.json({ success: true, tester: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/tests/:id', async (req, res) => {
    try {
        const testId = req.params.id;

        // Get files to delete
        const test = await db.query('SELECT apk_file_path FROM tests WHERE id = $1', [testId]);
        const bugs = await db.query('SELECT recording_path, screenshot_paths FROM bugs WHERE test_id = $1', [testId]);
        const frames = await db.query(
            'SELECT frame_path FROM ai_frames WHERE bug_id IN (SELECT id FROM bugs WHERE test_id = $1)', [testId]
        );

        // Delete from Supabase Storage
        if (test.rows[0]?.apk_file_path) {
            await storage.deleteFile('apks', test.rows[0].apk_file_path);
        }

        const recPaths = bugs.rows.filter(b => b.recording_path).map(b => b.recording_path);
        if (recPaths.length > 0) await storage.deleteFiles('recordings', recPaths);

        const ssPaths = [];
        bugs.rows.forEach(b => {
            if (b.screenshot_paths) b.screenshot_paths.split(',').forEach(p => ssPaths.push(p.trim()));
        });
        if (ssPaths.length > 0) await storage.deleteFiles('screenshots', ssPaths);

        const framePaths = frames.rows.map(f => f.frame_path);
        if (framePaths.length > 0) await storage.deleteFiles('ai-frames', framePaths);

        // Delete from database (CASCADE handles bugs + ai_frames)
        await db.query('DELETE FROM earnings WHERE test_id = $1', [testId]);
        await db.query('DELETE FROM tests WHERE id = $1', [testId]);

        res.json({ message: 'Test and all data deleted' });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tests/:id/bugs', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM bugs WHERE test_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tests/:id/stats', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM test_stats WHERE test_id = $1', [req.params.id]);
        res.json(result.rows[0] || { total_bugs: 0, total_testers: 0, critical_bugs: 0, high_bugs: 0, medium_bugs: 0, low_bugs: 0, avg_duration: 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tests/:id/download-apk', async (req, res) => {
    try {
        const result = await db.query('SELECT apk_file_url FROM tests WHERE id = $1', [req.params.id]);
        if (!result.rows[0]?.apk_file_url) return res.status(404).json({ error: 'No APK' });
        res.redirect(result.rows[0].apk_file_url);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================
// TESTER ENDPOINTS
// ============================================

app.get('/api/available-tests', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM tests WHERE status = 'active' ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bugs', upload.fields([
    { name: 'recording', maxCount: 1 },
    { name: 'screenshots', maxCount: 5 }
]), async (req, res) => {
    try {
        const { test_id, tester_name, bug_title, bug_description, severity,
            device_info, test_duration, device_stats } = req.body;

        if (!test_id || !tester_name || !bug_title) {
            return res.status(400).json({ error: 'test_id, tester_name, bug_title required' });
        }

        const validSev = ['low', 'medium', 'high', 'critical'];
        const finalSev = validSev.includes(severity) ? severity : 'low';

        // Upload recording
        let recording_url = null, recording_path = null;
        if (req.files?.['recording']) {
            const file = req.files['recording'][0];
            const result = await storage.uploadFile(file.path, 'recordings', file.originalname);
            recording_url = result.url;
            recording_path = result.path;
            fs.unlinkSync(file.path);
        }

        // Upload screenshots
        let screenshots = null, screenshot_paths = null;
        if (req.files?.['screenshots']) {
            const urls = [], paths = [];
            for (const file of req.files['screenshots']) {
                const result = await storage.uploadFile(file.path, 'screenshots', file.originalname);
                urls.push(result.url);
                paths.push(result.path);
                fs.unlinkSync(file.path);
            }
            screenshots = urls.join(',');
            screenshot_paths = paths.join(',');
        }

        // Parse device stats
        let statsJson = null;
        try { statsJson = device_stats ? JSON.parse(device_stats) : null; } catch (e) { }

        const query = `INSERT INTO bugs (test_id, tester_name, bug_title, bug_description, severity,
                        device_info, recording_url, recording_path, screenshots, screenshot_paths,
                        test_duration, device_stats) 
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`;

        const result = await db.query(query, [
            test_id, tester_name, bug_title, bug_description, finalSev,
            device_info, recording_url, recording_path, screenshots, screenshot_paths,
            test_duration || 0, JSON.stringify(statsJson)
        ]);

        const bugId = result.rows[0].id;

        // Create earnings
        await db.query('INSERT INTO earnings (tester_name, test_id) VALUES ($1, $2)', [tester_name, test_id]);

        // Auto AI analysis
        if (recording_url && process.env.GEMINI_API_KEY) {
            console.log(`🤖 Auto-analysis starting for bug #${bugId}...`);
            analyzeBugReport(bugId, recording_url, device_stats, bug_description)
                .then(r => console.log(r.success ? `✅ Bug #${bugId} analyzed` : `⚠️ Analysis failed: ${r.error}`))
                .catch(e => console.error('Analysis error:', e.message));
        }

        res.json({ id: bugId, message: 'Bug report submitted!', earned: 50 });

    } catch (err) {
        if (req.files) Object.values(req.files).flat().forEach(f => {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        });
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/bugs/:id', async (req, res) => {
    try {
        const bugId = req.params.id;
        const bug = await db.query('SELECT recording_path, screenshot_paths FROM bugs WHERE id = $1', [bugId]);
        const frames = await db.query('SELECT frame_path FROM ai_frames WHERE bug_id = $1', [bugId]);

        if (bug.rows[0]?.recording_path) await storage.deleteFile('recordings', bug.rows[0].recording_path);
        if (bug.rows[0]?.screenshot_paths) {
            const paths = bug.rows[0].screenshot_paths.split(',').map(p => p.trim());
            await storage.deleteFiles('screenshots', paths);
        }
        if (frames.rows.length > 0) {
            await storage.deleteFiles('ai-frames', frames.rows.map(f => f.frame_path));
        }

        await db.query('DELETE FROM bugs WHERE id = $1', [bugId]);
        res.json({ message: 'Bug deleted' });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// AI ANALYSIS
// ============================================

app.post('/api/bugs/:id/analyze', async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'No AI key' });

        const bug = await db.query('SELECT * FROM bugs WHERE id = $1', [req.params.id]);
        if (bug.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (!bug.rows[0].recording_url) return res.status(400).json({ error: 'No video' });
        if (bug.rows[0].ai_analysis) return res.json({ success: true, analysis: bug.rows[0].ai_analysis, cached: true });

        res.json({ success: true, message: 'Analysis started. Refresh in 30-60s.' });

        const b = bug.rows[0];
        analyzeBugReport(b.id, b.recording_url, JSON.stringify(b.device_stats), b.bug_description)
            .catch(e => console.error('Analysis error:', e.message));

    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bugs/:id/analysis', async (req, res) => {
    try {
        const result = await db.query('SELECT ai_analysis FROM bugs WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (result.rows[0].ai_analysis) res.json({ success: true, analysis: result.rows[0].ai_analysis });
        else res.json({ success: false, message: 'Not analyzed yet' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bugs/:id/frames', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM ai_frames WHERE bug_id = $1 ORDER BY frame_number', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// EARNINGS
// ============================================

app.get('/api/earnings/:tester_name', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT e.*, t.app_name, t.company_name FROM earnings e 
             LEFT JOIN tests t ON e.test_id = t.id 
             WHERE e.tester_name = $1 ORDER BY e.created_at DESC`,
            [req.params.tester_name]
        );
        const total = result.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
        const pending = result.rows.filter(r => r.status === 'pending').reduce((s, r) => s + parseFloat(r.amount), 0);
        res.json({ total_earned: total, pending_amount: pending, tests_completed: result.rows.length, earnings: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// ADMIN
// ============================================

app.get('/api/admin/stats', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM admin_overview');
        const stats = result.rows[0] || {};
        stats.ai_enabled = !!process.env.GEMINI_API_KEY;
        res.json(stats);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/all-bugs', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT b.*, t.app_name, t.company_name FROM bugs b 
             LEFT JOIN tests t ON b.test_id = t.id ORDER BY b.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (req, res) => {
    let dbOk = false;
    try { await db.query('SELECT 1'); dbOk = true; } catch (e) { }
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: dbOk ? 'connected' : 'disconnected',
        ai_enabled: !!process.env.GEMINI_API_KEY,
        storage: 'supabase'
    });
});

// ============================================
// START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔═══════════════════════════════════════╗');
    console.log('║      BharatQA Cloud Backend ☁️         ║');
    console.log('╠═══════════════════════════════════════╣');
    console.log(`║  Port:    ${PORT}                            ║`);
    console.log(`║  DB:      ${process.env.DATABASE_URL ? '🟢 Supabase' : '🔴 Not set'}               ║`);
    console.log(`║  Storage: ${process.env.SUPABASE_URL ? '🟢 Supabase' : '🔴 Not set'}               ║`);
    console.log(`║  AI:      ${process.env.GEMINI_API_KEY ? '🟢 Gemini' : '🔴 No key'}                ║`);
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
});