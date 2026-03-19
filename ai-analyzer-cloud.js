'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const db = require('./db');

// ============================================================
// FFMPEG SETUP
// ============================================================

(function setupFfmpeg() {
  try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffprobePath = require('@ffprobe-installer/ffprobe').path;

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      execSync(`chmod +x "${ffmpegPath}"`);
      ffmpeg.setFfmpegPath(ffmpegPath);
      console.log('✅ ffmpeg ready:', ffmpegPath);
    }

    if (ffprobePath && fs.existsSync(ffprobePath)) {
      execSync(`chmod +x "${ffprobePath}"`);
      ffmpeg.setFfprobePath(ffprobePath);
      console.log('✅ ffprobe ready:', ffprobePath);
    }
  } catch (e) {
    console.warn('⚠️ @ffmpeg-installer not found, trying ffmpeg-static fallback:', e.message);

    try {
      const ffmpegPath = require('ffmpeg-static');
      if (ffmpegPath && fs.existsSync(ffmpegPath)) {
        execSync(`chmod +x "${ffmpegPath}"`);
        ffmpeg.setFfmpegPath(ffmpegPath);
        console.log('✅ ffmpeg (static) ready:', ffmpegPath);
      }
    } catch (e2) {
      console.error('❌ ffmpeg setup failed entirely:', e2.message);
    }

    try {
      const ffprobePath = require('ffprobe-static').path;
      if (ffprobePath && fs.existsSync(ffprobePath)) {
        execSync(`chmod +x "${ffprobePath}"`);
        ffmpeg.setFfprobePath(ffprobePath);
        console.log('✅ ffprobe (static) ready:', ffprobePath);
      }
    } catch (e2) {
      console.error('❌ ffprobe setup failed entirely:', e2.message);
    }
  }
})();

// ============================================================
// GEMINI CLIENT
// ============================================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const GEMINI_MODELS = [
  'models/gemini-2.0-flash',
  'models/gemini-1.5-flash-latest',
];

// ============================================================
// VIDEO DOWNLOAD
// ============================================================

/**
 * Downloads a file from a URL to a local destination, following redirects.
 * @param {string} url
 * @param {string} dest
 * @param {Record<string, string>} [headers]
 * @returns {Promise<void>}
 */
function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    client.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => { });
        return downloadFile(res.headers.location, dest, headers)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => { });
        return reject(new Error(`HTTP ${res.statusCode} while downloading video from ${url}`));
      }

      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => { });
      reject(err);
    });
  });
}

// ============================================================
// FRAME EXTRACTION HELPERS
// ============================================================

/**
 * Returns a sensible frame count for a given video duration (seconds).
 * @param {number} durationSeconds
 * @returns {number}
 */
function getFrameCount(durationSeconds) {
  if (durationSeconds < 30) return 10;
  if (durationSeconds < 60) return 15;
  if (durationSeconds < 120) return 25;
  if (durationSeconds < 180) return 35;
  if (durationSeconds < 300) return 45;
  if (durationSeconds < 600) return 60;
  return 80;
}

/**
 * Returns the duration of a video file in seconds.
 * @param {string} videoPath
 * @returns {Promise<number>}
 */
function getDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

/**
 * Extracts `count` evenly-spaced frames from a video.
 * Frames are written to `outDir` as JPEG files.
 * @param {string} videoPath
 * @param {string} outDir
 * @param {number} count
 * @returns {Promise<Array<{path: string, timestamp: number, frozenDuration?: number}>>}
 */
function extractFrames(videoPath, outDir, count) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);

      const dur = meta.format.duration;
      if (!dur) return reject(new Error('Could not determine video duration'));

      // Avoid the very first and last fraction of the video (often black frames / intros)
      const start = Math.min(1, dur * 0.05);
      const end = Math.max(dur - 1, dur * 0.95);
      const range = end - start;

      const times = [
        ...new Set(
          Array.from({ length: count }, (_, i) =>
            Math.floor(start + (i / Math.max(count - 1, 1)) * range)
          )
        ),
      ];

      if (times.length === 0) return resolve([]);

      const frames = [];
      let done = 0;
      let currentIndex = 0;
      const CONCURRENCY = 3;

      const runNext = () => {
        if (done === times.length) {
          return resolve(frames.sort((a, b) => a.timestamp - b.timestamp));
        }
        if (currentIndex >= times.length) return;

        const i = currentIndex++;
        const t = times[i];
        const out = path.join(outDir, `frame_${String(i).padStart(3, '0')}.jpg`);

        ffmpeg(videoPath)
          .seekInput(t)
          .frames(1)
          .output(out)
          .size('360x640')
          .on('end', () => {
            if (fs.existsSync(out) && fs.statSync(out).size > 500) {
              frames.push({ path: out, timestamp: t });
            }
            done++;
            runNext();
          })
          .on('error', (e) => {
            console.warn(`⚠️ Frame ${i} skipped (${e.message})`);
            done++;
            runNext();
          })
          .run();
      };

      for (let j = 0; j < Math.min(CONCURRENCY, times.length); j++) {
        runNext();
      }
    });
  });
}

// ============================================================
// DUPLICATE FRAME DETECTION
// ============================================================

/**
 * Returns a rough visual-similarity score [0–100] between two JPEG files.
 * Based on byte-level sampling — fast but not pixel-perfect.
 * @param {string} p1
 * @param {string} p2
 * @returns {Promise<number>}
 */
async function compareFrames(p1, p2) {
  try {
    const b1 = fs.readFileSync(p1);
    const b2 = fs.readFileSync(p2);

    // Very different file sizes → frames are clearly different
    const sizeDiff = Math.abs(b1.length - b2.length) / Math.max(b1.length, b2.length);
    if (sizeDiff > 0.15) return 0;

    const samples = Math.min(b1.length, b2.length, 5000);
    const step = Math.floor(b1.length / samples);
    let matches = 0;

    for (let i = 0; i < samples; i++) {
      const idx = i * step;
      if (idx < b1.length && idx < b2.length && Math.abs(b1[idx] - b2[idx]) < 20) {
        matches++;
      }
    }

    return (matches / samples) * 100;
  } catch {
    return 0;
  }
}

/**
 * Removes near-duplicate frames from a sorted frame list.
 * Also annotates frames that were preceded by a frozen/stuck screen.
 * @param {Array<{path: string, timestamp: number}>} frames
 * @returns {Promise<{unique: Array, removed: number, freezes: number}>}
 */
async function filterDuplicates(frames) {
  if (frames.length <= 1) return { unique: frames, removed: 0, freezes: 0 };

  const unique = [frames[0]];
  let removed = 0;
  let freezes = 0;
  let streak = 0;

  for (let i = 1; i < frames.length; i++) {
    const sim = await compareFrames(unique[unique.length - 1].path, frames[i].path);

    if (sim < 85) {
      // Screen changed — was there a freeze before this transition?
      if (streak > 2) {
        unique[unique.length - 1].frozenDuration = Math.round(
          frames[i - 1].timestamp - unique[unique.length - 1].timestamp
        );
        freezes++;
      }
      unique.push(frames[i]);
      streak = 0;
    } else {
      removed++;
      streak++;
    }
  }

  // Handle freeze at the very end of the session
  if (streak > 2) freezes++;

  return { unique, removed, freezes };
}

// ============================================================
// AI PROMPTS
// ============================================================

const SHARED_CONSTRAINTS = `
FORMATTING RULES (strictly enforced):
- No emojis, em-dashes, or markdown bold/italic (**text** or __text__)
- No preamble ("As a QA auditor...", "Based on the video...", "I have reviewed...")
- No sign-off or closing remarks
- Use the exact section headers listed below, prefixed with #
- Output only the requested sections, in the order listed
`.trim();

/**
 * Builds the text-only (no video frames) analysis prompt.
 */
function buildTextOnlyPrompt({ appName, instructions, bugDescription, deviceStats }) {
  return `
You are a Senior QA Engineer writing a formal, structured bug report. Your output will be parsed programmatically — follow the format exactly.

${SHARED_CONSTRAINTS}

INPUT DATA:
- App: ${appName}
- Test Instructions: ${instructions}
- Bug Description: ${bugDescription || 'General session audit — no specific bug described'}
- Device Telemetry: ${deviceStats || 'Not available'}

OUTPUT SECTIONS (use these exact # headers, in this order):

# TITLE
Write a concise, descriptive title for this bug (5–10 words). Use technical language. Example: "Checkout flow hangs after payment confirmation on low-memory devices".

# REPRODUCTION STEPS
Numbered list of precise, minimal steps to reproduce this issue. Each step should be actionable by a developer who has never seen the app.

# TECHNICAL ROOT CAUSE
Your best hypothesis for the underlying engineering cause. Reference the telemetry data where relevant. Be specific — avoid vague language like "there may be an issue with...".

# RECOMMENDED FIXES
Numbered list of 3–5 concrete engineering recommendations, ordered by impact. Each fix should be actionable.

# SEVERITY
State exactly one severity level: LOW, MEDIUM, HIGH, or CRITICAL.
Follow it with one sentence explaining why this severity level was chosen.

==== INTERNAL ADMIN VERDICT ====
VERDICT: APPROVE or REJECT
REASONING: 2–3 sentences explaining the audit decision for the internal QA team. Note if the bug description is too vague, if the session produced insufficient evidence, or if the report is confident and actionable.
`.trim();
}

/**
 * Builds the vision-enabled (with video frames) analysis prompt.
 */
function buildVisionPrompt({
  appName,
  instructions,
  bugDescription,
  statsText,
  sessionDuration,
  frameCount,
  timeline,
}) {
  return `
You are a Senior QA Engineer performing a visual audit of a recorded mobile test session. Analyze the ${frameCount} video frames alongside the device telemetry. Your output will be parsed programmatically — follow the format exactly.

${SHARED_CONSTRAINTS}

INPUT DATA:
- App: ${appName}
- Test Instructions: ${instructions || 'Standard exploratory session'}
- Bug Description: ${bugDescription || 'General session audit — no specific bug described'}
- Device Telemetry: ${statsText}
- Session Duration: ${sessionDuration}

FRAME TIMELINE:
${timeline}
(Entries marked SLOW or FROZEN indicate potential performance or rendering issues.)

OUTPUT SECTIONS (use these exact # headers, in this order):

# TITLE
Write a concise, descriptive title for this bug (5–10 words). Ground it in what you actually observed in the frames. Example: "Settings screen becomes unresponsive after toggling notifications rapidly".

# REPRODUCTION STEPS
Numbered list of precise steps a developer could follow to reproduce this exact issue. Base the steps on the visual sequence shown in the frames. Note the approximate timestamp where the bug occurs.

# TECHNICAL ROOT CAUSE
Your best hypothesis for the underlying engineering cause. Cross-reference visual evidence (e.g., frame at 0:42 shows a blank screen after a network call) with telemetry (e.g., high battery drain, weak network). Be specific.

# RECOMMENDED FIXES
Numbered list of 3–5 concrete engineering recommendations, ordered by impact. Reference the frame evidence where it supports a specific fix.

# SEVERITY
State exactly one severity level: LOW, MEDIUM, HIGH, or CRITICAL.
Follow it with one sentence explaining why, referencing the visual or telemetry evidence.

==== INTERNAL ADMIN VERDICT ====
VERDICT: APPROVE or REJECT
REASONING: 2–3 sentences for the internal QA team. Assess whether the visual evidence clearly supports the bug report, note any ambiguities, and state whether the report is ready for developer handoff.
`.trim();
}

// ============================================================
// REPORT PARSING
// ============================================================

/**
 * Extracts the bug title and splits the report into public + admin sections.
 * @param {string} rawAnalysis - Full text returned by Gemini
 * @returns {{ title: string, publicReport: string, adminContext: string }}
 */
function parseReport(rawAnalysis) {
  let text = rawAnalysis
    .replace(/^#?\s*ANALYSIS[:\s]*\n/i, '')
    .replace(/^#?\s*AUDIT REPORT[:\s]*\n/i, '')
    .trim();

  // Extract title
  let title = '';
  const titleMatch = text.match(/^#\s*TITLE\s*\n([^\n#=]+)/im);
  if (titleMatch) {
    title = titleMatch[1].trim();
    text = text.replace(titleMatch[0], '').trim();
  } else {
    // Fallback: treat first non-empty, short line as the title
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const candidate = lines[0]?.replace(/^[#\s*]+|[#\s*]+$/g, '').trim();
    if (candidate && candidate.length > 3 && candidate.length < 100) {
      title = candidate;
      text = lines.slice(1).join('\n').trim();
    }
  }

  // Split public report from internal admin verdict
  let publicReport = text;
  let adminContext = '';
  const splitIdx = text.indexOf('==== INTERNAL ADMIN VERDICT ====');
  if (splitIdx !== -1) {
    publicReport = text.slice(0, splitIdx).trim();
    adminContext = text.slice(splitIdx + '==== INTERNAL ADMIN VERDICT ===='.length).trim();
  }

  return { title, publicReport, adminContext };
}

// ============================================================
// MAIN EXPORT
// ============================================================

const VIDEO_CACHE_DIR = path.join(os.tmpdir(), 'bugvid-cache');

/**
 * Downloads the session recording, extracts frames, and calls Gemini to produce
 * a structured QA bug report. Writes results to the database.
 *
 * @param {number|string} bugId
 * @param {string}        videoUrl      - Signed URL or direct URL to the .mp4
 * @param {string}        deviceStats   - JSON string of device telemetry
 * @param {string}        bugDescription
 * @param {string}        apiKey        - API key forwarded as x-api-key header for video download
 * @returns {Promise<{ success: boolean, analysis?: string, model?: string, error?: string }>}
 */
async function analyzeBugReport(bugId, videoUrl, deviceStats, bugDescription, apiKey) {
  const tempDir = path.join(__dirname, 'temp-analysis', `bug-${bugId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log(`\n🤖 ═══ Starting analysis: Bug #${bugId} ═══`);

    // ----------------------------------------------------------
    // 1. Fetch test context from database
    // ----------------------------------------------------------
    let testInfo = { app_name: 'Unknown App', company_name: 'Unknown', instructions: 'None' };
    try {
      const meta = await db.query(
        `SELECT t.instructions, t.app_name, t.company_name
           FROM tests t
           JOIN bugs b ON b.test_id = t.id
          WHERE b.id = $1`,
        [bugId]
      );
      if (meta.rows.length > 0) testInfo = meta.rows[0];
    } catch (dbErr) {
      console.warn('⚠️ Could not fetch test context from DB:', dbErr.message);
    }

    // ----------------------------------------------------------
    // 2. Obtain the video file (cache-first to save bandwidth)
    // ----------------------------------------------------------
    const videoPath = path.join(tempDir, 'video.mp4');
    let cacheHit = false;

    try {
      const bugRow = await db.query('SELECT recording_path FROM bugs WHERE id = $1', [bugId]);
      const recordingPath = bugRow.rows[0]?.recording_path;

      if (recordingPath) {
        const cacheKey = recordingPath.replace(/[/\\]/g, '_');
        const cachePath = path.join(VIDEO_CACHE_DIR, cacheKey);

        if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
          fs.copyFileSync(cachePath, videoPath);
          cacheHit = true;
          console.log(`⚡ Cache HIT — skipped download for bug #${bugId}`);
        }
      }
    } catch {
      // Cache lookup failure is non-fatal
    }

    if (!cacheHit) {
      console.log('⬇️  Downloading video...');
      await downloadFile(videoUrl, videoPath, { 'x-api-key': apiKey });
      console.log(`📹 Video downloaded (${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB)`);

      // Populate cache for future requests
      try {
        const bugRow = await db.query('SELECT recording_path FROM bugs WHERE id = $1', [bugId]);
        const recordingPath = bugRow.rows[0]?.recording_path;
        if (recordingPath) {
          fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
          const cacheKey = recordingPath.replace(/[/\\]/g, '_');
          fs.copyFileSync(videoPath, path.join(VIDEO_CACHE_DIR, cacheKey));
          console.log('💾 Video cached for future use');
        }
      } catch {
        // Cache save failure is non-fatal
      }
    }

    // ----------------------------------------------------------
    // 3. Extract frames
    // ----------------------------------------------------------
    const duration = await getDuration(videoPath);
    const frameCount = getFrameCount(duration);
    const rawFrames = await extractFrames(videoPath, tempDir, frameCount);
    console.log(`🎞️  Extracted ${rawFrames.length} raw frames`);

    // ----------------------------------------------------------
    // 4. Build prompt + call Gemini
    // ----------------------------------------------------------
    let analysis = null;
    let usedModel = null;

    if (rawFrames.length === 0) {
      // ── Text-only path ──────────────────────────────────────
      console.log('⚠️  No frames extracted — falling back to text-only analysis');
      const prompt = buildTextOnlyPrompt({
        appName: testInfo.app_name,
        instructions: testInfo.instructions,
        bugDescription,
        deviceStats,
      });

      for (const modelName of GEMINI_MODELS) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          console.log(`🤖 Trying ${modelName} (text-only)...`);
          const result = await model.generateContent(prompt);
          analysis = result.response.text();
          usedModel = modelName;
          break;
        } catch (e) {
          console.warn(`⚠️ ${modelName} failed: ${e.message}`);
        }
      }
    } else {
      // ── Vision path ─────────────────────────────────────────
      const { unique, removed, freezes } = await filterDuplicates(rawFrames);
      console.log(`🔍 Deduplication: kept ${unique.length}, removed ${removed} duplicates, ${freezes} freeze(s) detected`);

      // Cap at 50 frames to stay within Gemini context limits
      const toSend = unique.length > 50
        ? unique.filter((_, i) => i % Math.ceil(unique.length / 50) === 0)
        : unique;

      // Build a human-readable timeline for the prompt
      const lastTs = rawFrames[rawFrames.length - 1].timestamp;
      const dMin = Math.floor(lastTs / 60);
      const dSec = Math.round(lastTs % 60);

      const timeline = toSend
        .map((f, i) => {
          const m = Math.floor(f.timestamp / 60);
          const s = String(Math.round(f.timestamp % 60)).padStart(2, '0');
          let line = `Frame ${i + 1} [${m}:${s}]`;

          if (i > 0) {
            const gap = Math.round((f.timestamp - toSend[i - 1].timestamp) * 10) / 10;
            line += ` (+${gap}s)`;
            if (gap > 10) line += ' — VERY SLOW';
            else if (gap > 5) line += ' — SLOW';
          }
          if (f.frozenDuration) line += ` — FROZEN for ${f.frozenDuration}s`;

          return line;
        })
        .join('\n');

      // Parse device telemetry into a compact string
      let statsText = deviceStats || 'Not available';
      try {
        const p = JSON.parse(deviceStats);
        statsText = [
          `Battery: ${p.batteryStart}% → ${p.batteryEnd}% (${p.batteryDrain}% drain)`,
          `Network: ${p.networkType} (${p.networkSpeed})`,
          `Device: ${p.deviceModel} / Android ${p.androidVersion}`,
          `Duration: ${p.testDuration}s`,
          `Location: ${p.city}, ${p.state}`,
        ].join(' | ');
      } catch {
        // Telemetry was not valid JSON — use raw string
      }

      const prompt = buildVisionPrompt({
        appName: testInfo.app_name,
        instructions: testInfo.instructions,
        bugDescription,
        statsText,
        sessionDuration: `${dMin}m ${dSec}s`,
        frameCount: toSend.length,
        timeline,
      });

      for (const modelName of GEMINI_MODELS) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          const images = toSend
            .filter((f) => fs.existsSync(f.path))
            .map((f) => ({
              inlineData: {
                data: fs.readFileSync(f.path).toString('base64'),
                mimeType: 'image/jpeg',
              },
            }));

          console.log(`🤖 Trying ${modelName} with ${images.length} frames...`);
          const result = await model.generateContent([prompt, ...images]);
          analysis = result.response.text();
          usedModel = modelName;
          break;
        } catch (e) {
          console.warn(`⚠️ ${modelName} failed: ${e.message}`);
        }
      }
    }

    // ----------------------------------------------------------
    // 5. Parse and persist the report
    // ----------------------------------------------------------
    if (analysis) {
      const { title, publicReport, adminContext } = parseReport(analysis);

      await db.query(
        `UPDATE bugs
            SET ai_analysis      = $1,
                ai_admin_context = $2,
                ai_model         = $3,
                title            = CASE WHEN $4 <> '' THEN $4 ELSE title END,
                ai_analyzed_at   = NOW()
          WHERE id = $5`,
        [publicReport, adminContext, usedModel, title, bugId]
      );

      console.log(`✅ Bug #${bugId} analysed — title: "${title || '(none extracted)'}"`);
    } else {
      console.error(`❌ All models failed for bug #${bugId}`);
    }

    return {
      success: !!analysis,
      analysis,
      model: usedModel,
      error: analysis ? null : 'All Gemini models returned an error',
    };
  } catch (err) {
    console.error(`❌ Bug #${bugId} analysis threw:`, err.message);
    return { success: false, error: err.message };
  } finally {
    // Always clean up temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { analyzeBugReport };