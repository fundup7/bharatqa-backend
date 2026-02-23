require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process'); // ← Add this


// Video storage — Backblaze B2 (private bucket, 10GB free)
let b2Storage = null;
if (process.env.B2_KEY_ID) {
    b2Storage = require('./storage-b2');
    console.log('📹 Video storage: Backblaze B2 (10GB free, private)');
} else {
    console.log('📹 Video storage: Supabase (1GB free)');
}

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

// ============================================
// GLOBAL API KEY MIDDLEWARE
// ============================================
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.warn('⚠️  WARNING: API_KEY is not set. All endpoints are unprotected!');
}

app.use((req, res, next) => {
    // Whitelist health check (for uptime monitors / Render)
    if (req.path === '/api/health') return next();

    // If no key is configured, skip enforcement (local dev mode)
    if (!API_KEY) return next();

    const provided = req.headers['x-api-key'] || req.query.api_key;

    if (!provided || provided !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    }

    next();
});

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
// VIDEO PROXY — Serves private B2 videos
// ============================================
app.get('/api/videos/:bugId', async (req, res) => {
    try {
        const bug = await db.query(
            'SELECT recording_path, recording_storage FROM bugs WHERE id = $1',
            [req.params.bugId]
        );

        if (!bug.rows[0]?.recording_path) {
            return res.status(404).json({ error: 'No recording found' });
        }

        const row = bug.rows[0];

        if (row.recording_storage === 'b2' && b2Storage) {
            // Stream from B2 private bucket
            const response = await b2Storage.getVideoStream(row.recording_path);
            res.set('Content-Type', response.ContentType || 'video/mp4');
            if (response.ContentLength) {
                res.set('Content-Length', response.ContentLength);
            }
            response.Body.pipe(res);
        } else if (row.recording_path) {
            // Redirect to Supabase public URL
            const bug2 = await db.query(
                'SELECT recording_url FROM bugs WHERE id = $1',
                [req.params.bugId]
            );
            res.redirect(bug2.rows[0].recording_url);
        } else {
            res.status(404).json({ error: 'Recording not available' });
        }
    } catch (err) {
        console.error('Video proxy error:', err.message);
        res.status(500).json({ error: 'Failed to stream video' });
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
        const companyId = Number(req.params.companyId);

        const sql = `
      SELECT
        t.*,
        (SELECT COUNT(*)::int FROM bugs b WHERE b.test_id = t.id) AS bug_count,
        (SELECT COUNT(*)::int FROM bugs b WHERE b.test_id = t.id AND lower(b.severity)='critical') AS critical_count,
        (SELECT COUNT(DISTINCT b.tester_id)::int
         FROM bugs b
         WHERE b.test_id = t.id AND b.tester_id IS NOT NULL) AS tester_count
      FROM tests t
      WHERE t.company_id = $1
      ORDER BY t.created_at DESC;
    `;

        const result = await db.query(sql, [companyId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/company/:companyId/unique-testers', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT COUNT(DISTINCT b.tester_id) AS unique_testers
       FROM bugs b
       JOIN tests t ON t.id = b.test_id
       WHERE t.company_id = $1 AND b.tester_id IS NOT NULL`,
            [req.params.companyId]
        );
        res.json({ unique_testers: Number(r.rows[0].unique_testers || 0) });
    } catch (e) {
        res.status(500).json({ error: e.message });
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
            google_id, email, profile_picture,
            device_model, android_version, screen_resolution,
            latitude, longitude, city, state, full_address,
            // Targeting profile fields
            ram_gb, network_type, device_tier
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
                ram_gb = COALESCE($16, ram_gb),
                network_type = COALESCE($17, network_type),
                device_tier = COALESCE($18, device_tier),
                last_active = NOW()
                WHERE id = $15 RETURNING *`,
                [
                    full_name, upi_id, google_id, email, profile_picture,
                    device_model, android_version, screen_resolution,
                    latitude, longitude, city, state, full_address,
                    phoneClean, existing.id,
                    ram_gb || null, network_type || null, device_tier || null
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
                    latitude, longitude, city, state, full_address,
                    ram_gb, network_type, device_tier
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
                RETURNING *`,
                [
                    full_name, phoneClean, upi_id, google_id, email, profile_picture,
                    device_model, android_version, screen_resolution,
                    latitude || 0, longitude || 0, city || 'Unknown',
                    state || 'Unknown', full_address || 'Unknown',
                    ram_gb || null, network_type || null, device_tier || null
                ]
            );
            tester = result.rows[0];
            console.log(`✨ New tester registered: ${tester.full_name}`);
        }

        // Check if banned
        if (tester.is_banned) {
            return res.status(403).json({
                success: false,
                banned: true,
                ban_reason: tester.ban_reason || 'Your account has been suspended.'
            });
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
                total_earnings: tester.total_earnings || 0,
                ram_gb: tester.ram_gb,
                network_type: tester.network_type,
                device_tier: tester.device_tier
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
            'UPDATE testers SET upi_id = $1 WHERE id = $2 RETURNING id, full_name, upi_id',
            [upi_id, req.params.testerId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tester not found' });
        }

        res.json({ success: true, upi_id: result.rows[0].upi_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────

// GET /api/testers/:id/wallet — balance, earnings, next payout info
app.get('/api/testers/:testerId/wallet', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, full_name, upi_id,
                    COALESCE(total_earnings, 0)         AS total_earnings,
                    COALESCE(total_paid, 0)             AS total_paid,
                    COALESCE(total_earnings, 0) - COALESCE(total_paid, 0) AS pending
             FROM testers WHERE id = $1`,
            [req.params.testerId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tester not found' });

        // Next Sunday at 12:00 PM IST
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(now.getTime() + istOffsetMs);
        const dayOfWeek = nowIST.getUTCDay(); // 0=Sun, ..., 6=Sat
        const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
        const nextSunday = new Date(nowIST);
        nextSunday.setUTCDate(nowIST.getUTCDate() + daysUntilSunday);
        nextSunday.setUTCHours(6, 30, 0, 0); // 06:30 UTC = 12:00 IST

        res.json({
            success: true,
            wallet: {
                ...result.rows[0],
                next_payout: nextSunday.toISOString(),
                next_payout_label: 'Every Sunday at 12:00 PM IST',
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/testers/:id/payments — payment history
app.get('/api/testers/:testerId/payments', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM payment_transactions
             WHERE tester_id = $1
             ORDER BY paid_at DESC
             LIMIT 50`,
            [req.params.testerId]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/payments/pending — all testers with pending balance
app.get('/api/admin/payments/pending', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, full_name, email, phone, upi_id,
                    COALESCE(total_earnings, 0)                              AS total_earnings,
                    COALESCE(total_paid, 0)                                  AS total_paid,
                    COALESCE(total_earnings, 0) - COALESCE(total_paid, 0)   AS pending,
                    COALESCE(total_tests, 0)                                 AS total_tests
             FROM testers
             WHERE COALESCE(total_earnings, 0) - COALESCE(total_paid, 0) > 0
             ORDER BY pending DESC`
        );
        res.json({ success: true, testers: result.rows, total: result.rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/payments/batch — mark selected (or all) testers as paid
app.post('/api/admin/payments/batch', async (req, res) => {
    try {
        // Optional: pass { tester_ids: [1,2,3] } to pay specific testers only
        const { tester_ids, note } = req.body;
        const now = new Date();

        let candidates;
        if (tester_ids && tester_ids.length > 0) {
            const r = await db.query(
                `SELECT id, upi_id,
                        COALESCE(total_earnings,0) - COALESCE(total_paid,0) AS pending
                 FROM testers
                 WHERE id = ANY($1::int[])
                   AND COALESCE(total_earnings,0) - COALESCE(total_paid,0) > 0`,
                [tester_ids]
            );
            candidates = r.rows;
        } else {
            const r = await db.query(
                `SELECT id, upi_id,
                        COALESCE(total_earnings,0) - COALESCE(total_paid,0) AS pending
                 FROM testers
                 WHERE COALESCE(total_earnings,0) - COALESCE(total_paid,0) > 0`
            );
            candidates = r.rows;
        }

        if (candidates.length === 0) {
            return res.json({ success: true, paid: 0, message: 'No pending payments.' });
        }

        let totalPaid = 0;
        for (const t of candidates) {
            if (!t.upi_id) continue; // skip if no UPI on file
            const amount = parseFloat(t.pending);
            await db.query(
                `INSERT INTO payment_transactions
                    (tester_id, amount, upi_id, status, note, paid_at, period_end)
                 VALUES ($1, $2, $3, 'paid', $4, $5, $5)`,
                [t.id, amount, t.upi_id, note || null, now]
            );
            await db.query(
                `UPDATE testers SET total_paid = COALESCE(total_paid,0) + $1 WHERE id = $2`,
                [amount, t.id]
            );
            totalPaid += amount;
        }

        res.json({
            success: true,
            paid: candidates.length,
            total_amount: totalPaid,
            message: `Marked ${candidates.length} testers as paid (₹${totalPaid.toFixed(2)} total)`
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ===== APP VERSION / UPDATE ROUTES =====

// GET /api/app/latest-version — app checks this on launch
app.get('/api/app/latest-version', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT version_code, version_name, apk_url, release_notes, 
                    is_mandatory, min_supported_version
             FROM app_versions 
             WHERE is_active = true 
             ORDER BY version_code DESC 
             LIMIT 1`
        );

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                update_available: false
            });
        }

        const latest = result.rows[0];
        res.json({
            success: true,
            update_available: true,
            latest: {
                version_code: latest.version_code,
                version_name: latest.version_name,
                apk_url: latest.apk_url,
                release_notes: latest.release_notes,
                is_mandatory: latest.is_mandatory,
                min_supported_version: latest.min_supported_version
            }
        });
    } catch (err) {
        console.error('Version check error:', err);
        res.status(500).json({ success: false, error: 'Failed to check version' });
    }
});

// POST /api/app/upload-apk — push new APK to B2 directly
app.post('/api/app/upload-apk', upload.single('apk'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No APK file uploaded' });
        }

        if (!b2Storage) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(500).json({ success: false, error: 'B2 Storage is not configured' });
        }

        console.log(`🚀 Uploading APK to Backblaze B2: ${req.file.originalname}`);

        const result = await b2Storage.uploadApk(req.file.path, req.file.originalname);

        // Delete temp file
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.json({
            success: true,
            // Return BOTH the full B2 proxy url and the raw B2 key for internal streaming
            apk_url: `${process.env.BACKEND_URL || (req.protocol + '://' + req.get('host'))}/api/app/download/${result.key}`,
            message: 'APK uploaded to Backblaze B2 successfully'
        });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('App Upload error:', err);
        res.status(500).json({ success: false, error: 'Failed to upload APK to B2: ' + err.message });
    }
});

// GET /api/app/download/* — Proxy APK downloads from B2
app.get('/api/app/download/*', async (req, res) => {
    try {
        // The wildcard matched path corresponds to the B2 Key (e.g. app-updates/bharatqa_update.apk)
        const b2Key = req.params[0];

        if (!b2Key || !b2Storage) {
            return res.status(404).send('APK not found or B2 not configured');
        }

        console.log(`⬇️ Proxying APK from B2: ${b2Key}`);

        // Use the existing video stream method in B2 since it retrieves the file object stream identically
        const response = await b2Storage.getVideoStream(b2Key);

        res.set('Content-Type', 'application/vnd.android.package-archive');
        res.set('Content-Disposition', `attachment; filename="bharatqa_update.apk"`);
        if (response.ContentLength) {
            res.set('Content-Length', response.ContentLength);
        }

        response.Body.pipe(res);

    } catch (err) {
        console.error('App Download Proxy error:', err.message);
        res.status(500).send('Failed to stream APK from B2');
    }
});

// POST /api/app/release — push update from admin
app.post('/api/app/release', async (req, res) => {
    try {
        const { version_code, version_name, apk_url, release_notes, is_mandatory, min_supported_version } = req.body;

        if (!version_code || !version_name || !apk_url) {
            return res.status(400).json({ success: false, error: 'version_code, version_name, apk_url required' });
        }

        await db.query('UPDATE app_versions SET is_active = false');

        const result = await db.query(
            `INSERT INTO app_versions (version_code, version_name, apk_url, release_notes, 
             is_mandatory, min_supported_version, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, true)
             RETURNING *`,
            [
                version_code,
                version_name,
                apk_url,
                release_notes || '',
                is_mandatory !== false,
                min_supported_version || 1
            ]
        );

        res.json({ success: true, version: result.rows[0] });
    } catch (err) {
        console.error('Release error:', err);
        res.status(500).json({ success: false, error: 'Failed to create release' });
    }
});

// GET /api/app/check-update/:currentVersionCode
app.get('/api/app/check-update/:currentVersionCode', async (req, res) => {
    try {
        const currentVersion = parseInt(req.params.currentVersionCode);

        const result = await db.query(
            `SELECT version_code, version_name, apk_url, release_notes, 
                    is_mandatory, min_supported_version
             FROM app_versions 
             WHERE is_active = true 
             ORDER BY version_code DESC 
             LIMIT 1`
        );

        if (result.rows.length === 0) {
            return res.json({ success: true, update_available: false });
        }

        const latest = result.rows[0];
        const updateAvailable = latest.version_code > currentVersion;
        const forceUpdate = updateAvailable && (
            latest.is_mandatory || currentVersion < latest.min_supported_version
        );

        res.json({
            success: true,
            update_available: updateAvailable,
            force_update: forceUpdate,
            current_version: currentVersion,
            latest: updateAvailable ? {
                version_code: latest.version_code,
                version_name: latest.version_name,
                apk_url: latest.apk_url,
                release_notes: latest.release_notes,
                is_mandatory: latest.is_mandatory
            } : null
        });
    } catch (err) {
        console.error('Update check error:', err);
        res.status(500).json({ success: false, error: 'Failed to check update' });
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
        const { tester_id, google_id } = req.query;

        // Resolve tester from google_id or tester_id
        let tester = null;
        if (google_id) {
            const r = await db.query('SELECT * FROM testers WHERE google_id = $1', [google_id]);
            tester = r.rows[0] || null;
        } else if (tester_id) {
            const r = await db.query('SELECT * FROM testers WHERE id = $1', [tester_id]);
            tester = r.rows[0] || null;
        }

        // Block banned testers
        if (tester?.is_banned) {
            return res.status(403).json({
                success: false,
                banned: true,
                ban_reason: tester.ban_reason || 'Your account has been suspended.'
            });
        }

        // Base query for active tests
        let sql = `SELECT * FROM tests WHERE status = 'active'`;
        const params = [];

        if (tester) {
            // Filter tests by targeting criteria matching this tester's profile
            // A test's criteria field is NULL = open to all; otherwise must match
            sql += `
              AND (
                criteria IS NULL
                OR (
                  (criteria->>'device_tier' IS NULL OR criteria->>'device_tier' = '' OR criteria->>'device_tier' = $${params.length + 1}::text)
                  AND (criteria->>'network_type' IS NULL OR criteria->>'network_type' = '' OR criteria->>'network_type' = $${params.length + 2}::text)
                  AND (criteria->>'min_ram_gb' IS NULL OR (criteria->>'min_ram_gb')::numeric <= $${params.length + 3}::numeric)
                  AND (criteria->>'max_ram_gb' IS NULL OR (criteria->>'max_ram_gb')::numeric >= $${params.length + 3}::numeric)
                  AND (criteria->>'allowed_states' IS NULL OR criteria->>'allowed_states' = '' OR criteria->>'allowed_states' ILIKE $${params.length + 4}::text)
                  AND (criteria->>'allowed_cities' IS NULL OR criteria->>'allowed_cities' = '' OR criteria->>'allowed_cities' ILIKE $${params.length + 5}::text)
                )
              )`;
            params.push(
                tester.device_tier || '',
                tester.network_type || '',
                tester.ram_gb || 0,
                `%${tester.state || ''}%`,
                `%${tester.city || ''}%`
            );
        }

        sql += ' ORDER BY created_at DESC';
        const result = await db.query(sql, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bugs', upload.fields([
    { name: 'recording', maxCount: 1 },
    { name: 'screenshots', maxCount: 5 }
]), async (req, res) => {
    try {
        const { test_id, tester_name, bug_title, bug_description, severity,
            device_info, test_duration, device_stats, tester_google_id } = req.body;

        if (!test_id || !tester_name || !bug_title) {
            return res.status(400).json({ error: 'test_id, tester_name, bug_title required' });
        }

        const validSev = ['low', 'medium', 'high', 'critical'];
        const finalSev = validSev.includes(severity) ? severity : 'low';

        // Upload recording
        // Upload recording
        let recording_url = null, recording_path = null, recording_storage = 'supabase';

        if (req.files?.['recording']) {
            const file = req.files['recording'][0];

            if (b2Storage) {
                // ★ Upload to Backblaze B2 private bucket (10GB free)
                const result = await b2Storage.uploadVideo(file.path, file.originalname);
                recording_path = result.path;
                recording_storage = 'b2';
                // URL points to our proxy endpoint
                recording_url = `/api/videos/${null}`; // Will update after insert
                console.log(`📹 Video → B2: ${(file.size / 1024 / 1024).toFixed(1)} MB`);
            } else {
                // Fallback to Supabase
                const result = await storage.uploadFile(file.path, 'recordings', file.originalname);
                recording_url = result.url;
                recording_path = result.path;
                recording_storage = 'supabase';
            }

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

        let testerId = null;
        if (tester_google_id) {
            const tr = await db.query('SELECT id FROM testers WHERE google_id = $1', [tester_google_id]);
            testerId = tr.rows[0]?.id || null;
        }

        const query = `INSERT INTO bugs (
    test_id, tester_name, bug_title, bug_description, severity,
    device_info, recording_url, recording_path, recording_storage,
    screenshots, screenshot_paths, test_duration, device_stats, tester_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`;

        const result = await db.query(query, [
            test_id, tester_name, bug_title, bug_description, finalSev,
            device_info, recording_url, recording_path, recording_storage,
            screenshots, screenshot_paths,
            test_duration || 0, JSON.stringify(statsJson), testerId
        ]);

        const bugId = result.rows[0].id;

        // Update recording URL to point to proxy (for B2 videos)
        if (recording_storage === 'b2') {
            const proxyUrl = `/api/videos/${bugId}`;
            await db.query(
                'UPDATE bugs SET recording_url = $1 WHERE id = $2',
                [proxyUrl, bugId]
            );
            recording_url = proxyUrl;
        }

        // Create earnings
        await db.query('INSERT INTO earnings (tester_name, test_id) VALUES ($1, $2)', [tester_name, test_id]);

        // ✅ Update tester stats BEFORE sending response
        if (tester_google_id) {
            try {
                await db.query(`
                    UPDATE testers 
                    SET total_tests = total_tests + 1,
                        total_earnings = total_earnings + 50,
                        last_active = NOW()
                    WHERE google_id = $1
                `, [tester_google_id]);
                console.log(`✅ Updated stats for tester: ${tester_google_id}`);
            } catch (statsErr) {
                console.error(`⚠️ Failed to update tester stats: ${statsErr.message}`);
                // Don't fail the whole request — bug was already saved
            }
        }



        // ✅ Send response AFTER all DB operations
        res.json({ id: bugId, message: 'Bug report submitted!', earned: 50 });

        // Auto AI analysis (fire-and-forget AFTER response)
        if (recording_url && process.env.GEMINI_API_KEY) {
            // Resolve relative B2 proxy URLs to absolute URL
            const backendBase = process.env.BACKEND_URL || 'https://bharatqa-backend.onrender.com';
            const fullVideoUrl = recording_url.startsWith('http')
                ? recording_url
                : `${backendBase}${recording_url}`;
            console.log(`🤖 Auto-analysis starting for bug #${bugId}... (${fullVideoUrl})`);
            analyzeBugReport(bugId, fullVideoUrl, device_stats, bug_description)
                .then(r => console.log(r.success ? `✅ Bug #${bugId} analyzed` : `⚠️ Analysis failed: ${r.error}`))
                .catch(e => console.error('Analysis error:', e.message));
        }

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
        const bug = await db.query(
            'SELECT recording_path, recording_storage, screenshot_paths FROM bugs WHERE id = $1',
            [bugId]
        );
        const frames = await db.query(
            'SELECT frame_path FROM ai_frames WHERE bug_id = $1',
            [bugId]
        );

        // Delete recording from correct storage
        if (bug.rows[0]?.recording_path) {
            if (bug.rows[0].recording_storage === 'b2' && b2Storage) {
                await b2Storage.deleteVideo(bug.rows[0].recording_path);
            } else {
                await storage.deleteFile('recordings', bug.rows[0].recording_path);
            }
        }

        if (bug.rows[0]?.screenshot_paths) {
            const paths = bug.rows[0].screenshot_paths.split(',').map(p => p.trim());
            await storage.deleteFiles('screenshots', paths);
        }
        if (frames.rows.length > 0) {
            await storage.deleteFiles('ai-frames', frames.rows.map(f => f.frame_path));
        }

        await db.query('DELETE FROM bugs WHERE id = $1', [bugId]);
        res.json({ message: 'Bug deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
        // Resolve relative B2 proxy URLs to absolute URL
        const backendBase = process.env.BACKEND_URL || 'https://bharatqa-backend.onrender.com';
        const fullVideoUrl = b.recording_url.startsWith('http')
            ? b.recording_url
            : `${backendBase}${b.recording_url}`;
        analyzeBugReport(b.id, fullVideoUrl, JSON.stringify(b.device_stats), b.bug_description)
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

// GET /api/admin/testers — list all testers with profile + ban status
app.get('/api/admin/testers', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, full_name, email, phone, city, state,
                    device_model, android_version, ram_gb, network_type, device_tier,
                    is_banned, ban_reason, total_tests, total_earnings, last_active, created_at
             FROM testers ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/testers/:id/ban — ban a tester
app.post('/api/admin/testers/:id/ban', async (req, res) => {
    try {
        const { ban_reason } = req.body;
        const result = await db.query(
            `UPDATE testers SET is_banned = TRUE, ban_reason = $1 WHERE id = $2 RETURNING id, full_name, is_banned, ban_reason`,
            [ban_reason || 'Violation of terms of service', req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tester not found' });
        console.log(`🚫 Tester banned: ${result.rows[0].full_name} — ${ban_reason}`);
        res.json({ success: true, tester: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/testers/:id/ban — unban a tester
app.delete('/api/admin/testers/:id/ban', async (req, res) => {
    try {
        const result = await db.query(
            `UPDATE testers SET is_banned = FALSE, ban_reason = NULL WHERE id = $1 RETURNING id, full_name, is_banned`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tester not found' });
        console.log(`✅ Tester unbanned: ${result.rows[0].full_name}`);
        res.json({ success: true, tester: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tests/:id/criteria — set targeting criteria for a test
// Criteria fields (all optional, null = no restriction):
//   device_tier: 'low' | 'mid' | 'high'
//   network_type: '2g' | '3g' | '4g' | '5g' | 'wifi'
//   min_ram_gb: number
//   max_ram_gb: number
//   allowed_states: comma-separated state names e.g. "Maharashtra,Delhi"
//   allowed_cities: comma-separated city names
app.put('/api/tests/:id/criteria', async (req, res) => {
    try {
        const { device_tier, network_type, min_ram_gb, max_ram_gb, allowed_states, allowed_cities } = req.body;

        const criteria = {};
        if (device_tier) criteria.device_tier = device_tier;
        if (network_type) criteria.network_type = network_type;
        if (min_ram_gb != null) criteria.min_ram_gb = min_ram_gb;
        if (max_ram_gb != null) criteria.max_ram_gb = max_ram_gb;
        if (allowed_states) criteria.allowed_states = allowed_states;
        if (allowed_cities) criteria.allowed_cities = allowed_cities;

        const isEmpty = Object.keys(criteria).length === 0;

        const result = await db.query(
            `UPDATE tests SET criteria = $1 WHERE id = $2 RETURNING id, app_name, criteria`,
            [isEmpty ? null : JSON.stringify(criteria), req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Test not found' });
        console.log(`🎯 Criteria updated for test #${req.params.id}:`, criteria);
        res.json({ success: true, test: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tests/:id/criteria — get targeting criteria for a test
app.get('/api/tests/:id/criteria', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, app_name, criteria FROM tests WHERE id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Test not found' });
        res.json({ success: true, test: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tests/:id/eligible-testers — list testers who match this test's criteria
app.get('/api/tests/:id/eligible-testers', async (req, res) => {
    try {
        const testRes = await db.query('SELECT criteria FROM tests WHERE id = $1', [req.params.id]);
        if (testRes.rows.length === 0) return res.status(404).json({ error: 'Test not found' });

        const criteria = testRes.rows[0].criteria;

        let sql = `SELECT id, full_name, email, city, state, device_model, android_version,
                          ram_gb, network_type, device_tier, total_tests, last_active
                   FROM testers WHERE is_banned = FALSE OR is_banned IS NULL`;
        const params = [];

        if (criteria) {
            if (criteria.device_tier) {
                params.push(criteria.device_tier);
                sql += ` AND device_tier = $${params.length}`;
            }
            if (criteria.network_type) {
                params.push(criteria.network_type);
                sql += ` AND network_type = $${params.length}`;
            }
            if (criteria.min_ram_gb != null) {
                params.push(criteria.min_ram_gb);
                sql += ` AND ram_gb >= $${params.length}`;
            }
            if (criteria.max_ram_gb != null) {
                params.push(criteria.max_ram_gb);
                sql += ` AND ram_gb <= $${params.length}`;
            }
            if (criteria.allowed_states) {
                const states = criteria.allowed_states.split(',').map(s => s.trim());
                params.push(states);
                sql += ` AND state = ANY($${params.length})`;
            }
            if (criteria.allowed_cities) {
                const cities = criteria.allowed_cities.split(',').map(c => c.trim());
                params.push(cities);
                sql += ` AND city = ANY($${params.length})`;
            }
        }

        sql += ' ORDER BY last_active DESC';
        const result = await db.query(sql, params);
        res.json({ success: true, count: result.rows.length, testers: result.rows });
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

// ============================================
// KEEP-ALIVE PING
// ============================================
// Ping the backend every 5 minutes to prevent Render free tier from sleeping
const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

setInterval(async () => {
    try {
        console.log(`[Keep-Alive] Pinging ${BACKEND_URL}/api/health...`);
        // Using built-in fetch to avoid requiring extra dependencies here
        const response = await fetch(`${BACKEND_URL}/api/health`);
        if (response.ok) {
            console.log(`[Keep-Alive] Successfully pinged server (Status: ${response.status}) 🟢`);
        } else {
            console.log(`[Keep-Alive] Ping returned status: ${response.status} 🟡`);
        }
    } catch (error) {
        console.error(`[Keep-Alive] Failed to ping server: ${error.message} 🔴`);
    }
}, PING_INTERVAL_MS);