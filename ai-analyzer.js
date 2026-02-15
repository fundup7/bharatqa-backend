const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

// Point to bundled ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Gemini setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ===== SMART FRAME COUNT =====
function getFrameCount(durationSeconds) {
    if (durationSeconds < 30) return 10;
    if (durationSeconds < 60) return 15;
    if (durationSeconds < 120) return 25;
    if (durationSeconds < 180) return 35;
    if (durationSeconds < 300) return 45;
    if (durationSeconds < 600) return 60;
    return 80;  // Extract more, filter later
}

// ===== GET VIDEO DURATION =====
function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration || 0);
        });
    });
}

// ===== EXTRACT FRAMES =====
function extractFrames(videoPath, outputDir, numFrames) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) return reject(err);

            const duration = metadata.format.duration;
            if (!duration || duration < 1) return reject(new Error('Video too short'));

            // Spread timestamps evenly, skip first/last second
            const startTime = Math.min(1, duration * 0.05);
            const endTime = Math.max(duration - 1, duration * 0.95);
            const usableDuration = endTime - startTime;

            const timestamps = [];
            for (let i = 0; i < numFrames; i++) {
                const time = startTime + (i / (numFrames - 1)) * usableDuration;
                timestamps.push(Math.min(Math.floor(time * 10) / 10, duration - 0.5));
            }

            const uniqueTimestamps = [...new Set(timestamps.map(t => Math.floor(t)))];

            let completed = 0;
            let failed = 0;
            const frameFiles = [];
            const total = uniqueTimestamps.length;

            if (total === 0) return reject(new Error('No timestamps generated'));

            uniqueTimestamps.forEach((time, i) => {
                const outputFile = path.join(outputDir, `frame_${String(i).padStart(3, '0')}.jpg`);

                ffmpeg(videoPath)
                    .seekInput(time)
                    .frames(1)
                    .output(outputFile)
                    .size('360x640')
                    .outputOptions(['-q:v 3'])
                    .on('end', () => {
                        if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
                            frameFiles.push({ path: outputFile, timestamp: time });
                        }
                        completed++;
                        if (completed + failed === total) {
                            const sorted = frameFiles.sort((a, b) => a.timestamp - b.timestamp);
                            resolve(sorted);
                        }
                    })
                    .on('error', () => {
                        failed++;
                        if (completed + failed === total) {
                            const sorted = frameFiles.sort((a, b) => a.timestamp - b.timestamp);
                            resolve(sorted);
                        }
                    })
                    .run();
            });
        });
    });
}

// ===== COMPARE TWO IMAGES — DETECT DUPLICATES =====
async function compareImages(imagePath1, imagePath2) {
    try {
        const img1 = await loadImage(imagePath1);
        const img2 = await loadImage(imagePath2);

        // Resize both to tiny size for fast comparison
        const size = 32;
        const canvas1 = createCanvas(size, size);
        const ctx1 = canvas1.getContext('2d');
        ctx1.drawImage(img1, 0, 0, size, size);

        const canvas2 = createCanvas(size, size);
        const ctx2 = canvas2.getContext('2d');
        ctx2.drawImage(img2, 0, 0, size, size);

        const data1 = ctx1.getImageData(0, 0, size, size).data;
        const data2 = ctx2.getImageData(0, 0, size, size).data;

        // Calculate difference
        let totalDiff = 0;
        const pixelCount = size * size;

        for (let i = 0; i < data1.length; i += 4) {
            // Compare RGB channels (skip alpha)
            const rDiff = Math.abs(data1[i] - data2[i]);
            const gDiff = Math.abs(data1[i + 1] - data2[i + 1]);
            const bDiff = Math.abs(data1[i + 2] - data2[i + 2]);
            totalDiff += (rDiff + gDiff + bDiff) / 3;
        }

        // Average difference per pixel (0-255 scale)
        const avgDiff = totalDiff / pixelCount;

        // Convert to similarity percentage (0-100)
        const similarity = 100 - (avgDiff / 255) * 100;

        return similarity;

    } catch (e) {
        return 0; // If comparison fails, treat as different
    }
}

// ===== FILTER OUT DUPLICATE/FROZEN FRAMES =====
async function filterDuplicateFrames(frameFiles, similarityThreshold = 92) {
    if (frameFiles.length <= 1) return frameFiles;

    console.log(`🔍 Checking ${frameFiles.length} frames for duplicates (threshold: ${similarityThreshold}%)...`);

    const uniqueFrames = [frameFiles[0]];
    let duplicatesRemoved = 0;
    let frozenStreaks = 0;
    let currentStreak = 0;
    let streakStartTime = frameFiles[0].timestamp;

    for (let i = 1; i < frameFiles.length; i++) {
        const similarity = await compareImages(
            uniqueFrames[uniqueFrames.length - 1].path,
            frameFiles[i].path
        );

        if (similarity < similarityThreshold) {
            // Different enough — keep it
            if (currentStreak > 2) {
                // Record how long the screen was frozen
                const frozenDuration = Math.round(frameFiles[i - 1].timestamp - streakStartTime);
                uniqueFrames[uniqueFrames.length - 1].frozenDuration = frozenDuration;
                frozenStreaks++;
                console.log(`   ❄️ Screen frozen for ${frozenDuration}s at ~${Math.round(streakStartTime)}s`);
            }
            uniqueFrames.push(frameFiles[i]);
            currentStreak = 0;
            streakStartTime = frameFiles[i].timestamp;
        } else {
            // Too similar — skip
            duplicatesRemoved++;
            currentStreak++;
        }
    }

    // Check last streak
    if (currentStreak > 2) {
        const frozenDuration = Math.round(frameFiles[frameFiles.length - 1].timestamp - streakStartTime);
        uniqueFrames[uniqueFrames.length - 1].frozenDuration = frozenDuration;
        frozenStreaks++;
        console.log(`   ❄️ Screen frozen for ${frozenDuration}s at end of video`);
    }

    // Always keep last frame
    const lastFrame = frameFiles[frameFiles.length - 1];
    const lastUnique = uniqueFrames[uniqueFrames.length - 1];
    if (lastFrame.path !== lastUnique.path) {
        const sim = await compareImages(lastUnique.path, lastFrame.path);
        if (sim < similarityThreshold) {
            uniqueFrames.push(lastFrame);
        }
    }

    console.log(`📸 Results: ${uniqueFrames.length} unique, ${duplicatesRemoved} duplicates removed, ${frozenStreaks} freezes`);

    return uniqueFrames;
}
// ===== DETECT SPECIFIC FRAME TYPES =====
async function classifyFrame(imagePath) {
    try {
        const img = await loadImage(imagePath);
        const size = 32;
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);

        const data = ctx.getImageData(0, 0, size, size).data;

        let totalR = 0, totalG = 0, totalB = 0;
        let darkPixels = 0;
        let whitePixels = 0;
        const pixelCount = size * size;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            totalR += r; totalG += g; totalB += b;

            const brightness = (r + g + b) / 3;
            if (brightness < 20) darkPixels++;
            if (brightness > 240) whitePixels++;
        }

        const avgBrightness = (totalR + totalG + totalB) / (3 * pixelCount);
        const darkRatio = darkPixels / pixelCount;
        const whiteRatio = whitePixels / pixelCount;

        if (darkRatio > 0.9) return 'black_screen';
        if (whiteRatio > 0.9) return 'white_screen';
        if (avgBrightness < 15) return 'nearly_black';
        return 'normal';

    } catch (e) {
        return 'normal';
    }
}

// ===== ANALYZE WITH GEMINI =====
async function analyzeWithGemini(frameData, deviceStats, bugDescription, videoInfo) {
    if (!GEMINI_API_KEY) {
        return { success: false, error: 'No Gemini API key configured' };
    }

    const models = [
        'models/gemini-2.5-flash',
        'models/gemini-2.5-flash-lite',
        'models/gemini-1.5-flash-latest',
        'models/gemini-1.5-flash-8b',
        'models/gemini-pro-vision'
    ];

    let lastError = '';

    for (const modelName of models) {
        try {
            console.log(`🤖 Trying model: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });

            // Prepare images
            const imageParts = [];
            for (const frame of frameData) {
                if (fs.existsSync(frame.path)) {
                    const imageData = fs.readFileSync(frame.path);
                    imageParts.push({
                        inlineData: {
                            data: imageData.toString('base64'),
                            mimeType: 'image/jpeg'
                        }
                    });
                }
            }

            if (imageParts.length === 0) {
                return { success: false, error: 'No frames to analyze' };
            }

            // Parse device stats
            let statsText = 'Not available';
            try {
                if (deviceStats) {
                    const parsed = JSON.parse(deviceStats);
                    statsText = `
Battery: ${parsed.batteryStart}% → ${parsed.batteryEnd}% (${parsed.batteryDrain}% drain)
Network: ${parsed.networkType} (${parsed.networkSpeed})
Device: ${parsed.deviceModel}
Android: ${parsed.androidVersion}
Screen: ${parsed.screenResolution}
Duration: ${parsed.testDuration} seconds
Location: ${parsed.city}, ${parsed.state}
Crash Detected: ${parsed.crashDetected ? 'YES - ' + parsed.crashInfo : 'No'}`;
                }
            } catch (e) {
                statsText = deviceStats || 'Not available';
            }

            // ===== BUILD DETAILED FRAME TIMELINE =====
            let frameTimeline = '📊 FRAME TIMELINE WITH TIMING DATA:\n';
            frameTimeline += '─'.repeat(60) + '\n';

            let slowTransitions = 0;
            let verySlowTransitions = 0;
            let totalTransitionTime = 0;

            frameData.forEach((frame, i) => {
                const mins = Math.floor(frame.timestamp / 60);
                const secs = Math.round(frame.timestamp % 60);
                const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

                let line = `  Frame ${i + 1} [${timeStr}]`;

                // Calculate time since previous frame
                if (i > 0) {
                    const gap = frame.timestamp - frameData[i - 1].timestamp;
                    const gapRounded = Math.round(gap * 10) / 10;
                    totalTransitionTime += gap;

                    line += ` — ${gapRounded}s since previous`;

                    if (gap > 10) {
                        line += ' ⚠️ VERY SLOW (possible freeze/long load)';
                        verySlowTransitions++;
                    } else if (gap > 5) {
                        line += ' ⚠️ SLOW TRANSITION';
                        slowTransitions++;
                    } else if (gap < 1) {
                        line += ' ⚡ rapid change';
                    }
                } else {
                    line += ` — test start`;
                }

                // Frame type info
                if (frame.type && frame.type !== 'normal') {
                    line += ` [${frame.type.toUpperCase()}]`;
                }

                // Frozen frame info
                if (frame.frozenDuration) {
                    line += ` ❄️ FROZEN for ${frame.frozenDuration}s`;
                }

                frameTimeline += line + '\n';
            });

            frameTimeline += '─'.repeat(60) + '\n';

            // Add timing summary
            const avgGap = frameData.length > 1
                ? Math.round(totalTransitionTime / (frameData.length - 1) * 10) / 10
                : 0;

            let timingSummary = '\n⏱️ TIMING SUMMARY:\n';
            timingSummary += `  Total test duration: ${videoInfo.durationFormatted}\n`;
            timingSummary += `  Unique screen changes: ${frameData.length}\n`;
            timingSummary += `  Average time per screen: ${avgGap}s\n`;
            timingSummary += `  Slow transitions (>5s): ${slowTransitions}\n`;
            timingSummary += `  Very slow / possible freezes (>10s): ${verySlowTransitions}\n`;

            if (videoInfo.frozenScreens > 0) {
                timingSummary += `  ❄️ Frozen screen events: ${videoInfo.frozenScreens}\n`;
            }
            if (videoInfo.blackScreensRemoved > 0) {
                timingSummary += `  ⬛ Black screens detected: ${videoInfo.blackScreensRemoved} (removed from analysis)\n`;
            }
            if (videoInfo.duplicatesRemoved > 0) {
                timingSummary += `  🔄 Duplicate frames removed: ${videoInfo.duplicatesRemoved}\n`;
            }

            // Performance flags
            let performanceFlags = '';
            if (verySlowTransitions > 0) {
                performanceFlags += '\n🚨 PERFORMANCE ALERT: App has very slow transitions (>10s). Check for:\n';
                performanceFlags += '  - Heavy API calls blocking UI\n';
                performanceFlags += '  - Large images loading\n';
                performanceFlags += '  - Database queries on main thread\n';
                performanceFlags += '  - Memory leaks causing slowdown\n';
            }
            if (videoInfo.frozenScreens > 1) {
                performanceFlags += '\n🚨 FREEZE ALERT: App appeared to freeze multiple times.\n';
            }

            // ===== THE PROMPT =====
            const prompt = `You are a senior QA testing expert and performance analyst. Analyze this mobile app test session.

These are ${imageParts.length} UNIQUE screenshots extracted from a ${videoInfo.durationFormatted} screen recording.
Each frame represents a DIFFERENT screen state. Duplicate and frozen frames have been removed.

${frameTimeline}
${timingSummary}
${performanceFlags}

TESTER'S REPORT:
${bugDescription || 'No description'}

DEVICE STATS:
${statsText}

Please analyze and provide a DETAILED report:

## 🔍 App Overview
What app is this? What screens/features are visible?

## 📱 User Flow (with timestamps)
What did the tester do? Step by step.
For each step, mention:
- Which frame number
- The timestamp
- What action the user took
- How long the transition took
Example: "Frame 3 (0:15) → Frame 4 (0:28): User tapped login. Page took 13 seconds to load — this is too slow."

## 🐛 Bugs Found
List every issue:
- UI bugs (layout, alignment, overlapping, cut-off text)
- Visual bugs (wrong colors, missing images, broken icons)
- Error screens or crash dialogs
- Loading issues (spinners stuck, blank screens)
- Accessibility issues (small text, poor contrast)
For each bug, reference the FRAME NUMBER and TIMESTAMP.

## ⏱️ Performance Analysis
This is critical. Analyze the timing data:
- Which screen transitions are too slow? (anything >3s is concerning, >5s is bad, >10s is critical)
- Are there loading screens that lasted too long?
- Did the app freeze at any point?
- Is the app responsive to user input?
- Compare load times to industry standards (most screens should load in <2s)
${verySlowTransitions > 0 ? '- IMPORTANT: ' + verySlowTransitions + ' very slow transitions detected. Analyze each one.' : ''}
${videoInfo.frozenScreens > 0 ? '- IMPORTANT: ' + videoInfo.frozenScreens + ' freeze events detected. This is a serious issue.' : ''}

Rate performance: 
- ⚡ FAST (most transitions <2s)
- ✅ ACCEPTABLE (most transitions <3s)
- ⚠️ SLOW (multiple transitions >5s)
- 🐌 VERY SLOW (transitions >10s)
- ❄️ FREEZING (app becomes unresponsive)

## 🔋 Battery & Resource Assessment
Based on device stats:
- Battery drain rate (drain% / duration)
- Is drain normal for this type of app?
- Network usage impact

## 🎯 Overall Severity Rating
Rate: CRITICAL / HIGH / MEDIUM / LOW
Consider both bugs AND performance.

## 💡 Top 5 Fixes (Prioritized)
What should the developer fix first? Include:
1. Performance fixes (slow loads, freezes)
2. Bug fixes (UI issues, errors)
3. UX improvements

Be specific. Reference frame numbers, timestamps, and exact timing data.`;

            console.log(`🤖 Sending ${imageParts.length} unique frames to ${modelName}...`);

            const result = await model.generateContent([prompt, ...imageParts]);
            const response = await result.response;
            const analysis = response.text();

            console.log(`✅ Analysis complete with ${modelName} (${analysis.length} chars)`);

            return {
                success: true,
                analysis: analysis,
                framesAnalyzed: imageParts.length,
                model: modelName
            };

        } catch (error) {
            lastError = error.message;
            console.log(`⚠️ ${modelName} failed: ${error.message}`);
            continue;
        }
    }

    console.error('❌ All models failed. Last error:', lastError);
    return { success: false, error: 'All models failed: ' + lastError };
}
// ===== MAIN FUNCTION =====
async function analyzeBugReport(videoPath, deviceStats, bugDescription) {
    const videoFullPath = path.join(__dirname, 'uploads', videoPath);

    if (!fs.existsSync(videoFullPath)) {
        return { success: false, error: 'Video file not found: ' + videoPath };
    }

    console.log(`\n🤖 ═══════════════════════════════════════`);
    console.log(`🤖 Smart Analysis: ${videoPath}`);
    console.log(`🤖 ═══════════════════════════════════════`);

    // Step 1: Get duration
    let duration = 0;
    try {
        duration = await getVideoDuration(videoFullPath);
    } catch (err) {
        console.error('Could not get duration:', err.message);
        duration = 60;
    }

    const durationMin = Math.floor(duration / 60);
    const durationSec = Math.round(duration % 60);
    const durationFormatted = `${durationMin}m ${durationSec}s`;
    const numFrames = getFrameCount(duration);
    console.log(`📹 Duration: ${durationFormatted} → Extracting ${numFrames} raw frames`);

    // Step 2: Extract frames
    const framesDir = path.join(__dirname, 'uploads', 'frames', path.parse(videoPath).name);
    let rawFrames;
    try {
        rawFrames = await extractFrames(videoFullPath, framesDir, numFrames);
    } catch (err) {
        console.error('Frame extraction failed:', err.message);
        return { success: false, error: 'Frame extraction failed: ' + err.message };
    }

    if (rawFrames.length === 0) {
        return { success: false, error: 'No frames extracted' };
    }

    console.log(`📸 Extracted ${rawFrames.length} raw frames`);

    // Step 3: Classify frames (detect black/white screens)
    for (const frame of rawFrames) {
        frame.type = await classifyFrame(frame.path);
    }

    const blackScreens = rawFrames.filter(f => f.type === 'black_screen' || f.type === 'nearly_black').length;
    const whiteScreens = rawFrames.filter(f => f.type === 'white_screen').length;
    if (blackScreens > 0) console.log(`   ⬛ ${blackScreens} black/dark screens detected`);
    if (whiteScreens > 0) console.log(`   ⬜ ${whiteScreens} white/blank screens detected`);

    // Remove pure black screens (usually screen off or transition)
    const nonBlackFrames = rawFrames.filter(f => f.type !== 'black_screen' && f.type !== 'nearly_black');
    if (nonBlackFrames.length < rawFrames.length) {
        console.log(`   🗑️ Removed ${rawFrames.length - nonBlackFrames.length} black screens`);
    }

    // Step 4: Filter duplicate/frozen frames
    const uniqueFrames = await filterDuplicateFrames(nonBlackFrames, 92);
    const duplicatesRemoved = nonBlackFrames.length - uniqueFrames.length;

    // Count frozen streaks for the report
    let frozenScreens = 0;
    let streak = 0;
    for (let i = 1; i < nonBlackFrames.length; i++) {
        if (!uniqueFrames.includes(nonBlackFrames[i])) {
            streak++;
        } else {
            if (streak > 2) frozenScreens++;
            streak = 0;
        }
    }

    // Step 5: Cap at 50 for API limits
    let framesToSend = uniqueFrames;
    if (uniqueFrames.length > 50) {
        const step = Math.ceil(uniqueFrames.length / 50);
        framesToSend = uniqueFrames.filter((_, i) => i % step === 0);
        console.log(`📸 Capped to ${framesToSend.length} frames for API limit`);
    }

    // Make sure we have at least 3 frames
    if (framesToSend.length < 3 && rawFrames.length >= 3) {
        console.log(`⚠️ Too few unique frames. Using raw frames instead.`);
        framesToSend = rawFrames.slice(0, Math.min(rawFrames.length, 20));
    }

    const videoInfo = {
        duration: Math.round(duration),
        durationFormatted,
        rawFrames: rawFrames.length,
        uniqueFrames: framesToSend.length,
        duplicatesRemoved,
        blackScreensRemoved: blackScreens,
        frozenScreens
    };

    console.log(`\n📊 Frame Summary:`);
    console.log(`   Raw extracted:    ${rawFrames.length}`);
    console.log(`   Black removed:    ${blackScreens}`);
    console.log(`   Duplicates removed: ${duplicatesRemoved}`);
    console.log(`   Unique to analyze: ${framesToSend.length}`);
    console.log(`   Frozen screens:   ${frozenScreens}`);
    console.log(`   Tokens saved:     ~${duplicatesRemoved * 400} tokens\n`);

    // Step 6: Analyze with AI
    const result = await analyzeWithGemini(framesToSend, deviceStats, bugDescription, videoInfo);

    if (result.success) {
        result.videoInfo = videoInfo;
    }

    // Step 7: Cleanup
    try {
        fs.rmSync(framesDir, { recursive: true, force: true });
        console.log('🧹 Cleaned up frames');
    } catch (e) { }

    return result;
}

module.exports = { analyzeBugReport };