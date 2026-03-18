const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const db = require('./db');
const storage = require('./storage');

// ========================================
// FFMPEG SETUP - Works on Render
// ========================================
try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const ffprobePath = require('@ffprobe-installer/ffprobe').path;

  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  console.log('✅ ffmpeg:', ffmpegPath);
  console.log('✅ ffprobe:', ffprobePath);
} catch (e) {
  console.error('❌ ffmpeg/ffprobe setup failed:', e.message);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ... rest of the file stays exactly the same ...

// ========================================
// FIX PERMISSIONS ON STARTUP
// ========================================
function fixBinaryPermissions() {
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      execSync(`chmod +x "${ffmpegPath}"`);
      console.log('✅ ffmpeg permissions fixed:', ffmpegPath);
    }
    ffmpeg.setFfmpegPath(ffmpegPath);
  } catch (e) {
    console.log('⚠️ ffmpeg setup issue:', e.message);
  }

  try {
    const ffprobePath = require('ffprobe-static').path;
    if (ffprobePath && fs.existsSync(ffprobePath)) {
      execSync(`chmod +x "${ffprobePath}"`);
      console.log('✅ ffprobe permissions fixed:', ffprobePath);
    }
    ffmpeg.setFfprobePath(ffprobePath);
  } catch (e) {
    console.log('⚠️ ffprobe setup issue:', e.message);
  }
}

fixBinaryPermissions();


function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const options = { headers };
    client.get(url, options, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => { });
        return reject(new Error(`HTTP ${res.statusCode} downloading video`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => { }); reject(err); });
  });
}

function getFrameCount(dur) {
  if (dur < 30) return 10;
  if (dur < 60) return 15;
  if (dur < 120) return 25;
  if (dur < 180) return 35;
  if (dur < 300) return 45;
  if (dur < 600) return 60;
  return 80;
}

function getDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta.format.duration || 0);
    });
  });
}

function extractFrames(videoPath, outDir, count) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const dur = meta.format.duration;
      if (!dur) return reject(new Error('No duration'));

      const start = Math.min(1, dur * 0.05);
      const end = Math.max(dur - 1, dur * 0.95);
      const range = end - start;
      const times = [...new Set(Array.from({ length: count }, (_, i) =>
        Math.floor(start + (i / (count - 1)) * range)
      ))];

      if (times.length === 0) return resolve([]);

      let done = 0;
      const frames = [];
      const CONCURRENCY_LIMIT = 3;
      let currentIndex = 0;

      const runNext = () => {
        if (done === times.length) {
          return resolve(frames.sort((a, b) => a.timestamp - b.timestamp));
        }

        if (currentIndex < times.length) {
          const i = currentIndex++;
          const t = times[i];
          const out = path.join(outDir, `frame_${String(i).padStart(3, '0')}.jpg`);

          ffmpeg(videoPath)
            .seekInput(t)
            .frames(1)
            .output(out)
            .size('360x640')
            .on('end', () => {
              if (fs.existsSync(out) && fs.statSync(out).size > 500)
                frames.push({ path: out, timestamp: t });
              done++;
              runNext();
            })
            .on('error', (e) => {
              console.log(`⚠️ Frame ${i} error: ${e.message}`);
              done++;
              runNext();
            })
            .run();
        }
      };

      // Start initial batch
      for (let j = 0; j < Math.min(CONCURRENCY_LIMIT, times.length); j++) {
        runNext();
      }
    });
  });
}

async function compareFrames(p1, p2) {
  try {
    const b1 = fs.readFileSync(p1), b2 = fs.readFileSync(p2);
    const sizeDiff = Math.abs(b1.length - b2.length) / Math.max(b1.length, b2.length);
    if (sizeDiff > 0.15) return 0;

    const samples = Math.min(b1.length, b2.length, 5000);
    const step = Math.floor(b1.length / samples);
    let matches = 0;
    for (let i = 0; i < samples; i++) {
      const idx = i * step;
      if (idx < b1.length && idx < b2.length && Math.abs(b1[idx] - b2[idx]) < 20) matches++;
    }
    return (matches / samples) * 100;
  } catch (e) { return 0; }
}

async function filterDuplicates(frames) {
  if (frames.length <= 1) return { unique: frames, removed: 0, freezes: 0 };
  const unique = [frames[0]];
  let removed = 0, freezes = 0, streak = 0;

  for (let i = 1; i < frames.length; i++) {
    const sim = await compareFrames(unique[unique.length - 1].path, frames[i].path);
    if (sim < 85) {
      if (streak > 2) {
        unique[unique.length - 1].frozenDuration =
          Math.round(frames[i - 1].timestamp - unique[unique.length - 1].timestamp);
        freezes++;
      }
      unique.push(frames[i]);
      streak = 0;
    } else { removed++; streak++; }
  }
  if (streak > 2) freezes++;
  return { unique, removed, freezes };
}

async function analyzeBugReport(bugId, videoUrl, deviceStats, bugDescription, apiKey) {
  const tempDir = path.join(__dirname, 'temp-analysis', `bug-${bugId}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log(`\n🤖 ═══ Cloud Analysis: Bug #${bugId} ═══`);

    // Fetch test context
    let testInfo = { app_name: 'Unknown', company_name: 'Unknown', instructions: 'None' };
    try {
      const meta = await db.query(`
        SELECT t.instructions, t.app_name, t.company_name 
        FROM tests t
        JOIN bugs b ON b.test_id = t.id
        WHERE b.id = $1
      `, [bugId]);
      if (meta.rows.length > 0) testInfo = meta.rows[0];
    } catch (dbErr) {
      console.error('⚠️ Could not fetch test context:', dbErr.message);
    }

    // Download video (pass API key if fetching from our own backend)
    const videoPath = path.join(tempDir, 'video.mp4');
    console.log('⬇️ Downloading video...');
    await downloadFile(videoUrl, videoPath, { 'x-api-key': apiKey });
    console.log(`📹 Video downloaded: ${videoPath}`);

    const dur = await getDuration(videoPath);
    const frameCount = getFrameCount(dur);
    const raw = await extractFrames(videoPath, tempDir, frameCount);
    let analysis = null, usedModel = null;

    if (raw.length === 0) {
      console.log('⚠️ No frames extracted, falling back to text-only analysis');
      const dMin = 0, dSec = 0; // Fallback
      const models = ['models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-1.5-flash-latest'];

      for (const modelName of models) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          const prompt = `Review this technical bug report and provide an objective assessment. 
 
App: ${testInfo.app_name}
Audit Context: ${testInfo.instructions}
Description: ${bugDescription || 'General session audit'}
Telemetry: ${deviceStats || 'N/A'}
 
Rules:
- Persona: Senior Technical Architect / Professional Security Auditor.
- Tone: Formal, objective, zero conversational filler.
- DO NOT use introductory phrases (e.g. "As a senior QA...", "I have reviewed...", "Hi there").
- DO NOT use emojis, em-dashes, or standard bullet points.
- START IMMEDIATELY with the first header.
- The "INTERNAL ADMIN VERDICT" section MUST be at the very bottom, preceded by the delimiter.
 
# FORMAL AUDIT TITLE
(A concise, 3-7 word technical title capturing the core discovery)
 
# BUG REPRODUCTION STEPS
# TECHNICAL ROOT CAUSE [HYPOTHESIZED]
# SEVERITY: [LOW/MEDIUM/HIGH/CRITICAL]
 
==== INTERNAL ADMIN VERDICT ====
VERDICT: [APPROVE] or [REJECT]
REASONING: Detailed internal justification for the audit team choice in 2-3 sentences.`;

          console.log(`🤖 ${modelName}: text-only analysis...`);
          const result = await model.generateContent(prompt);
          analysis = result.response.text();
          usedModel = modelName;
          break;
        } catch (e) { console.log(`⚠️ ${modelName}: ${e.message}`); }
      }
    } else {
      // Filter duplicates
      const { unique, removed, freezes } = await filterDuplicates(raw);
      let toSend = unique.length > 50 ? unique.filter((_, i) => i % Math.ceil(unique.length / 50) === 0) : unique;

      const dMin = Math.floor(raw[raw.length - 1].timestamp / 60);
      const dSec = Math.round(raw[raw.length - 1].timestamp % 60);

      // Build timeline
      let timeline = '';
      toSend.forEach((f, i) => {
        const m = Math.floor(f.timestamp / 60), s = Math.round(f.timestamp % 60);
        let line = `Frame ${i + 1} [${m}:${String(s).padStart(2, '0')}]`;
        if (i > 0) {
          const gap = Math.round((f.timestamp - toSend[i - 1].timestamp) * 10) / 10;
          line += ` +${gap}s`;
          if (gap > 10) line += ' ⚠️VERY SLOW';
          else if (gap > 5) line += ' ⚠️SLOW';
        }
        if (f.frozenDuration) line += ` ❄️FROZEN ${f.frozenDuration}s`;
        timeline += line + '\n';
      });

      // Stats
      let statsText = '';
      try {
        const p = JSON.parse(deviceStats);
        statsText = `Battery:${p.batteryStart}%→${p.batteryEnd}% (${p.batteryDrain}%drain) Network:${p.networkType}(${p.networkSpeed}) Device:${p.deviceModel} Android:${p.androidVersion} Duration:${p.testDuration}s Location:${p.city},${p.state}`;
      } catch (e) { statsText = deviceStats || 'N/A'; }

      const models = ['models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-1.5-flash-latest'];
      for (const modelName of models) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          const images = toSend.filter(f => fs.existsSync(f.path)).map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString('base64'), mimeType: 'image/jpeg' }
          }));

          const prompt = `Review the attached video frames and bug report telemetry. Provide a strictly objective technical assessment for the development team.
 
App: ${testInfo.app_name}
Bug Title: ${bugDescription || 'Untitled Audit Session'}
Instructions: ${testInfo.instructions || 'Standard exploration'}
 
Rules:
- Persona: Senior Technical Architect / Professional Security Auditor.
- Tone: Formal, objective, zero conversational filler.
- DO NOT use introductory phrases (e.g. "As a senior QA...", "Based on the video...", "I have analyzed...").
- DO NOT use emojis, em-dashes, or standard bullet points (use numbers or basic hyphens).
- START IMMEDIATELY with the first header.
- The "INTERNAL ADMIN VERDICT" section MUST be at the very bottom, preceded by the exact delimiter.
- Format all headers exactly as shown below:

# FORMAL AUDIT TITLE
(A concise, 3-7 word technical title capturing the core discovery)
 
# BUG REPRODUCTION STEPS
(Detailed technical steps based strictly on visual confirmation in the provided frames)
 
# TECHNICAL ROOT CAUSE [HYPOTHESIZED]
(Root cause analysis based on visual behavior and session telemetry)
 
# TOP 5 FIXES
(Prioritized technical recommendations for the engineering team)
 
# SEVERITY: [LOW/MEDIUM/HIGH/CRITICAL]
(A one-word severity designation followed by a 1-sentence justification)
 
==== INTERNAL ADMIN VERDICT ====
VERDICT: [APPROVE] or [REJECT]
REASONING: Detailed technical explanation of the verdict strictly for BharatQA internal administration.`;
          console.log(`🤖 ${modelName}: ${images.length} frames...`);
          const result = await model.generateContent([prompt, ...images]);
          analysis = result.response.text();
          usedModel = modelName;
          break;
        } catch (e) { console.log(`⚠️ ${modelName}: ${e.message}`); }
      }
    }

    if (analysis) {
      // 0. Preliminary cleanup of old-style headers/preambles
      publicReport = publicReport.replace(/^#?\s*ANALYSIS[:\s]*\n/i, '').trim();
      publicReport = publicReport.replace(/^#?\s*AUDIT REPORT[:\s]*\n/i, '').trim();

      // 1. Broad detection for Formal Title
      let auditTitle = "";
      const titReg = /# (?:FORMAL AUDIT TITLE|AUDIT TITLE|TITLE|ISSUE|TITLE:)\n?([^\n#=]+)/i;
      const titleMatch = publicReport.match(titReg);

      if (titleMatch && titleMatch[1]) {
        auditTitle = titleMatch[1].trim();
        publicReport = publicReport.replace(titReg, "").trim();
      } else {
        // Fallback: If the first line is short and looks like a title
        // Or if it's the first bold line
        const lines = publicReport.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines[0] && lines[0].length < 80) {
          // If it starts with # remove it
          auditTitle = lines[0].replace(/^[#\s\*]+/, '').replace(/[#\s\*]+$/, '').trim();
          // Only remove it from body if we actually took it as a title
          if (auditTitle.length > 3) {
            publicReport = lines.slice(1).join('\n').trim();
          }
        }
      }

      // 2. Split analysis into public and private
      let publicReportFinal = publicReport;
      let adminContext = "";
      if (publicReport.includes("==== INTERNAL ADMIN VERDICT ====")) {
        const parts = publicReport.split("==== INTERNAL ADMIN VERDICT ====");
        publicReportFinal = parts[0].trim();
        adminContext = parts[1].trim();
      }

      await db.query(
        'UPDATE bugs SET ai_analysis=$1, ai_admin_context=$2, ai_model=$3, title=CASE WHEN $4 != \'\' THEN $4 ELSE title END, ai_analyzed_at=NOW() WHERE id=$5',
        [publicReportFinal, adminContext, usedModel, auditTitle, bugId]
      );
      console.log(`✅ Bug #${bugId} titled: ${auditTitle || 'N/A'}`);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: !!analysis, analysis, model: usedModel, error: analysis ? null : 'All models failed' };

  } catch (err) {
    console.error(`❌ Bug #${bugId} failed:`, err.message);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
}

module.exports = { analyzeBugReport };