require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Helper: run a shell command with properly quoted args (Windows-safe)
function shellRun(cmd, args = [], opts = {}) {
  const quoted = args.map(a => {
    if (/[\s&|<>^"!%]/.test(a)) return `"${a}"`;
    return a;
  });
  const fullCmd = [cmd, ...quoted].join(' ');
  return execAsync(fullCmd, opts);
}
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'storage', 'uploads');
const CLIP_DIR = path.join(ROOT, 'storage', 'clips');
const TRANSCRIPT_DIR = path.join(ROOT, 'storage', 'transcripts');
const DB_FILE = path.join(ROOT, 'storage', 'db.json');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

for (const dir of [UPLOAD_DIR, CLIP_DIR, TRANSCRIPT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ videos: [], clips: [], transcripts: [], highlights: [] }, null, 2));
}

function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!db.transcripts) db.transcripts = [];
  if (!db.highlights) db.highlights = [];
  return db;
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- OpenAI setup ---
let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

// --- Upload setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage });

app.use(express.json({ limit: '50gb' }));
app.use(express.urlencoded({ limit: '50gb', extended: true }));
app.use('/static/uploads', express.static(UPLOAD_DIR));
app.use('/static/clips', express.static(CLIP_DIR));
app.use('/static/transcripts', express.static(TRANSCRIPT_DIR));
app.use('/landing', express.static(path.join(ROOT, 'LANDINGPAGE +DEPLOY', 'stitch_rapidsub_service_landing')));
app.use(express.static(path.join(ROOT, 'public')));

// --- yt-dlp availability check ---
let ytDlpAvailable = null;
async function checkYtDlp() {
  try {
    await shellRun('yt-dlp', ['--version']);
    ytDlpAvailable = true;
  } catch {
    ytDlpAvailable = false;
    console.warn('[warn] yt-dlp tidak ditemukan di PATH');
  }
}
checkYtDlp();

// --- NVENC (GPU) availability check ---
let nvencAvailable = null;
async function checkNvenc() {
  try {
    await shellRun('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10000 })
      .then(({ stdout }) => {
        if (stdout.includes('h264_nvenc')) {
          nvencAvailable = true;
          console.log('[info] NVIDIA NVENC encoder terdeteksi ✓ — export akan menggunakan GPU');
        } else {
          nvencAvailable = false;
          console.log('[info] NVENC tidak tersedia — export menggunakan CPU (libx264)');
        }
      });
  } catch {
    nvencAvailable = false;
    console.log('[info] NVENC tidak tersedia — export menggunakan CPU (libx264)');
  }
}
checkNvenc();

// --- Whisper availability check ---
let whisperAvailable = null;
let pythonCmd = null;

async function checkWhisper() {
  for (const cmd of ['python', 'python3']) {
    try {
      await shellRun(cmd, ['-c', 'import faster_whisper; print(1)'], { timeout: 15000 });
      pythonCmd = cmd;
      whisperAvailable = true;
      console.log(`[info] whisper engine tersedia: faster-whisper (via ${cmd})`);
      return;
    } catch {
      try {
        await shellRun(cmd, ['-c', 'import whisper; print(1)'], { timeout: 15000 });
        pythonCmd = cmd;
        whisperAvailable = true;
        console.log(`[info] whisper engine tersedia: openai-whisper (via ${cmd})`);
        return;
      } catch {}
    }
  }
  whisperAvailable = false;
  console.warn('[warn] whisper tidak ditemukan');
}
checkWhisper();

// --- Helpers ---
async function probeDuration(filePath) {
  try {
    const { stdout } = await shellRun('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    return parseFloat(stdout.trim());
  } catch (err) {
    console.error('ffprobe error:', err.message);
    return null;
  }
}

// --- Probe embedded subtitle streams ---
async function probeSubtitleStreams(filePath) {
  try {
    const { stdout } = await shellRun('ffprobe', [
      '-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name,codec_type',
      '-show_entries', 'stream_tags=language,title',
      '-of', 'json', filePath
    ]);
    const data = JSON.parse(stdout);
    return (data.streams || []).filter(s => s.codec_type === 'subtitle');
  } catch (err) {
    console.error('ffprobe subtitle probe error:', err.message);
    return [];
  }
}

// --- Extract embedded subtitle from video ---
async function extractEmbeddedSubtitle(videoPath, streamIndex, outputSrtPath) {
  try {
    await shellRun('ffmpeg', [
      '-y', '-i', videoPath,
      '-map', `0:${streamIndex}`,
      '-c:s', 'srt',
      outputSrtPath
    ]);
    if (fs.existsSync(outputSrtPath)) {
      const content = fs.readFileSync(outputSrtPath, 'utf-8').trim();
      return content.length > 10; // valid if has meaningful content
    }
    return false;
  } catch (err) {
    console.error('ffmpeg subtitle extract error:', err.message);
    return false;
  }
}

// --- Build raw text from SRT content ---
function extractRawTextFromSrt(srtContent) {
  const blocks = srtContent.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
  const parts = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 3) {
      parts.push(lines.slice(2).join(' ').trim());
    }
  }
  return parts.join(' ');
}

// --- Detect language from SRT content (basic heuristic) ---
function detectLanguageFromSrt(srtContent) {
  // Simple heuristic: check for common Indonesian/English words
  const text = srtContent.toLowerCase();
  const idWords = ['dan', 'yang', 'untuk', 'dengan', 'ini', 'itu', 'tidak', 'akan', 'ada', 'dari'];
  const enWords = ['the', 'and', 'for', 'with', 'this', 'that', 'not', 'will', 'have', 'from'];
  let idScore = 0, enScore = 0;
  for (const w of idWords) { if (text.includes(` ${w} `)) idScore++; }
  for (const w of enWords) { if (text.includes(` ${w} `)) enScore++; }
  if (idScore > enScore) return 'id';
  if (enScore > idScore) return 'en';
  return 'unknown';
}

function buildFfmpegSubtitleArgs(srtPath) {
  const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const subtitleStyle = [
    'FontName=Arial', 'FontSize=22', 'Bold=1',
    'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H40000000',
    'BackColour=&H80000000', 'BorderStyle=4',
    'Outline=1', 'Shadow=0', 'MarginV=35', 'Alignment=2',
  ].join(',');
  return ['-vf', `subtitles='${escapedSrtPath}':force_style='${subtitleStyle}'`];
}

// =============================================
// === ROUTES: Video Management ================
// =============================================

// Upload video (with auto-detect embedded subtitle)
app.post('/api/videos', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file video yang diupload' });
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  const duration = await probeDuration(filePath);
  const db = readDB();
  const videoId = uuidv4();
  const video = {
    id: videoId, original_name: req.file.originalname,
    filename: req.file.filename, duration_seconds: duration,
    status: 'ready', created_at: new Date().toISOString()
  };
  db.videos.unshift(video);
  writeDB(db);
  res.json(video);

  // Background: check for embedded subtitles
  try {
    const subStreams = await probeSubtitleStreams(filePath);
    if (subStreams.length > 0) {
      console.log(`[info] Video ${videoId}: ${subStreams.length} embedded subtitle stream(s) detected`);
      const srtFilename = `${videoId}.srt`;
      const srtPath = path.join(TRANSCRIPT_DIR, srtFilename);
      const extracted = await extractEmbeddedSubtitle(filePath, subStreams[0].index, srtPath);
      if (extracted) {
        const srtContent = fs.readFileSync(srtPath, 'utf-8');
        const rawText = extractRawTextFromSrt(srtContent);
        const lang = subStreams[0].tags?.language || detectLanguageFromSrt(srtContent);
        const db2 = readDB();
        const v = db2.videos.find(v => v.id === videoId);
        if (v) {
          v.status = 'transcribed';
          const transcriptId = uuidv4();
          db2.transcripts.unshift({
            id: transcriptId, video_id: videoId, srt_filename: srtFilename,
            raw_text: rawText, language: lang, status: 'done', error: null,
            source: 'embedded', created_at: new Date().toISOString()
          });
          writeDB(db2);
          console.log(`[info] Embedded subtitle extracted for video ${videoId} (lang: ${lang})`);
        }
      }
    }
  } catch (err) {
    console.error('Embedded subtitle detection error:', err.message);
  }
});

// Download video from URL (yt-dlp)
app.post('/api/videos/from-url', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL tidak valid' });
  }
  if (ytDlpAvailable === false) {
    return res.status(503).json({ error: 'yt-dlp tidak terinstall' });
  }
  const id = uuidv4();
  const outputTemplate = path.join(UPLOAD_DIR, `${id}.%(ext)s`);
  const video = {
    id, original_name: url, filename: null, duration_seconds: null,
    status: 'downloading', source_url: url, error: null,
    created_at: new Date().toISOString()
  };
  const db = readDB();
  db.videos.unshift(video);
  writeDB(db);
  res.json(video);

  try {
    // Download video + auto-download subtitles/captions
    await shellRun('yt-dlp', [
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
      '--merge-output-format', 'mp4', '--no-playlist',
      '--write-subs', '--write-auto-subs', '--sub-lang', 'en,id,ja,ko',
      '--convert-subs', 'srt',
      '-o', outputTemplate, url
    ], { maxBuffer: 1024 * 1024 * 20 });
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith(id + '.'));
    const videoFiles = files.filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f));
    const srtFiles = files.filter(f => /\.srt$/i.test(f));
    if (videoFiles.length === 0) throw new Error('File hasil download tidak ditemukan');
    const finalFilename = videoFiles[0];
    const finalPath = path.join(UPLOAD_DIR, finalFilename);
    const duration = await probeDuration(finalPath);
    const db2 = readDB();
    const v = db2.videos.find(v => v.id === id);
    v.filename = finalFilename;
    v.duration_seconds = duration;
    v.status = 'ready';
    writeDB(db2);

    // If yt-dlp downloaded subtitle files, auto-import the first one
    if (srtFiles.length > 0) {
      console.log(`[info] yt-dlp downloaded ${srtFiles.length} subtitle file(s): ${srtFiles.join(', ')}`);
      const srcSrtPath = path.join(UPLOAD_DIR, srtFiles[0]);
      const destSrtFilename = `${id}.srt`;
      const destSrtPath = path.join(TRANSCRIPT_DIR, destSrtFilename);
      fs.copyFileSync(srcSrtPath, destSrtPath);
      const srtContent = fs.readFileSync(destSrtPath, 'utf-8');
      const rawText = extractRawTextFromSrt(srtContent);
      // Detect language from filename (e.g. id.en.srt => en)
      const langMatch = srtFiles[0].match(/\.([a-z]{2})\.srt$/i);
      const lang = langMatch ? langMatch[1] : detectLanguageFromSrt(srtContent);

      const db3 = readDB();
      const v2 = db3.videos.find(v => v.id === id);
      if (v2) {
        v2.status = 'transcribed';
        const transcriptId = uuidv4();
        db3.transcripts.unshift({
          id: transcriptId, video_id: id, srt_filename: destSrtFilename,
          raw_text: rawText, language: lang, status: 'done', error: null,
          source: 'yt-dlp', created_at: new Date().toISOString()
        });
        writeDB(db3);
        console.log(`[info] Auto-imported yt-dlp subtitle for video ${id} (lang: ${lang})`);
      }
      // Clean up downloaded srt files from uploads dir
      for (const sf of srtFiles) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, sf)); } catch {}
      }
    }
  } catch (err) {
    console.error('yt-dlp download error:', err.message);
    const db2 = readDB();
    const v = db2.videos.find(v => v.id === id);
    if (v) { v.status = 'failed'; v.error = err.message.slice(0, 500); }
    writeDB(db2);
  }
});

// List videos
app.get('/api/videos', (req, res) => {
  res.json(readDB().videos);
});

// Get single video
app.get('/api/videos/:id', (req, res) => {
  const video = readDB().videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  res.json(video);
});

// Delete video (+ associated transcripts, clips, highlights)
app.delete('/api/videos/:id', (req, res) => {
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  if (video.filename) {
    const filePath = path.join(UPLOAD_DIR, video.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const transcript = db.transcripts.find(t => t.video_id === video.id);
  if (transcript && transcript.srt_filename) {
    const srtPath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
  }
  db.videos = db.videos.filter(v => v.id !== req.params.id);
  db.clips = db.clips.filter(c => c.video_id !== req.params.id);
  db.transcripts = db.transcripts.filter(t => t.video_id !== req.params.id);
  db.highlights = db.highlights.filter(h => h.video_id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// =============================================
// === ROUTES: Transcription (MVP-3) ===========
// =============================================

app.post('/api/videos/:id/transcribe', async (req, res) => {
  if (whisperAvailable === false) {
    return res.status(503).json({ error: 'faster-whisper tidak terinstall. Install dengan: pip install faster-whisper' });
  }
  if (whisperAvailable === null) {
    return res.status(503).json({ error: 'Sedang mengecek ketersediaan whisper, coba lagi sebentar...' });
  }
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  if (video.status !== 'ready' && video.status !== 'transcribed') {
    return res.status(400).json({ error: `Video belum ready (status: ${video.status})` });
  }
  const existing = db.transcripts.find(t => t.video_id === video.id && t.status === 'processing');
  if (existing) {
    return res.status(409).json({ error: 'Video ini sedang di-transcribe', transcript: existing });
  }
  // Remove old transcript if re-transcribing
  const oldTranscript = db.transcripts.find(t => t.video_id === video.id);
  if (oldTranscript) {
    const oldSrtPath = path.join(TRANSCRIPT_DIR, oldTranscript.srt_filename);
    if (fs.existsSync(oldSrtPath)) fs.unlinkSync(oldSrtPath);
    db.transcripts = db.transcripts.filter(t => t.video_id !== video.id);
  }
  const transcriptId = uuidv4();
  const srtFilename = `${video.id}.srt`;
  const srtPath = path.join(TRANSCRIPT_DIR, srtFilename);
  const transcript = {
    id: transcriptId, video_id: video.id, srt_filename: srtFilename,
    raw_text: null, language: null, status: 'processing', error: null,
    created_at: new Date().toISOString()
  };
  video.status = 'transcribing';
  db.transcripts.unshift(transcript);
  writeDB(db);
  res.json(transcript);

  // Background transcription
  const inputPath = path.join(UPLOAD_DIR, video.filename);
  const scriptPath = path.join(SCRIPTS_DIR, 'transcribe.py');
  const glossary = req.body.glossary || '';
  try {
    const args = [scriptPath, inputPath, srtPath];
    if (glossary.trim()) args.push(glossary.trim());
    const { stdout, stderr } = await shellRun(pythonCmd, args, {
      maxBuffer: 1024 * 1024 * 50, timeout: 24 * 60 * 60 * 1000
    }); // 50MB buffer, 24 hours timeout
    if (stderr) console.log(stderr.trim());
    let result;
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*"raw_text"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Format JSON tidak ditemukan di stdout: ' + stdout);
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      throw new Error('Gagal parse output: ' + parseErr.message + ' | raw: ' + stdout.slice(0, 200));
    }
    const db2 = readDB();
    const t = db2.transcripts.find(t => t.id === transcriptId);
    const v = db2.videos.find(v => v.id === video.id);
    if (t) { t.raw_text = result.raw_text; t.language = result.language; t.status = 'done'; }
    if (v) { v.status = 'transcribed'; }
    writeDB(db2);
    console.log(`[info] Transcribe selesai untuk video ${video.id}: ${result.segments_count} segments, lang: ${result.language}`);
  } catch (err) {
    console.error('Transcribe error:', err.message);
    const db2 = readDB();
    const t = db2.transcripts.find(t => t.id === transcriptId);
    const v = db2.videos.find(v => v.id === video.id);
    if (t) { t.status = 'failed'; t.error = err.message.slice(0, 500); }
    if (v) { v.status = 'ready'; }
    writeDB(db2);
  }
});

app.get('/api/videos/:id/transcript', (req, res) => {
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const transcript = db.transcripts.find(t => t.video_id === req.params.id);
  if (!transcript) return res.status(404).json({ error: 'Transcript belum ada' });
  let srt_content = null;
  if (transcript.srt_filename) {
    const srtPath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
    if (fs.existsSync(srtPath)) srt_content = fs.readFileSync(srtPath, 'utf-8');
  }
  res.json({ ...transcript, srt_content });
});

app.put('/api/videos/:id/transcript', (req, res) => {
  const { srt_content, raw_text } = req.body;
  if (!srt_content) return res.status(400).json({ error: 'srt_content wajib diisi' });
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const transcript = db.transcripts.find(t => t.video_id === req.params.id);
  if (!transcript) return res.status(404).json({ error: 'Transcript belum ada' });
  try {
    const srtPath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
    fs.writeFileSync(srtPath, srt_content, 'utf-8');
    if (raw_text) transcript.raw_text = raw_text;
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving transcript:', err);
    res.status(500).json({ error: 'Gagal menyimpan transkrip' });
  }
});

app.get('/api/whisper-status', async (req, res) => {
  if (whisperAvailable !== true) await checkWhisper();
  res.json({ available: whisperAvailable === true });
});

// --- Download SRT (transcript) ---
app.get('/api/videos/:id/transcript/download', (req, res) => {
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const transcript = db.transcripts.find(t => t.video_id === req.params.id && t.status === 'done');
  if (!transcript || !transcript.srt_filename) {
    return res.status(404).json({ error: 'Transcript belum ada' });
  }
  const srtPath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'File SRT tidak ditemukan' });
  const baseName = path.basename(video.original_name, path.extname(video.original_name));
  const downloadName = `${baseName}_transcript.srt`;
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Type', 'application/x-subrip');
  res.sendFile(path.resolve(srtPath));
});

// --- Download SRT (translation) ---
app.get('/api/videos/:id/translation/download', (req, res) => {
  const db = readDB();
  if (!db.translations) db.translations = [];
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const translation = db.translations.find(t => t.video_id === req.params.id && t.status === 'done');
  if (!translation || !translation.srt_filename) {
    return res.status(404).json({ error: 'Translation belum ada' });
  }
  const srtPath = path.join(TRANSCRIPT_DIR, translation.srt_filename);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'File SRT tidak ditemukan' });
  const baseName = path.basename(video.original_name, path.extname(video.original_name));
  const langSlug = (translation.target_language || 'translated').toLowerCase().replace(/\s+/g, '_');
  const downloadName = `${baseName}_${langSlug}.srt`;
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Type', 'application/x-subrip');
  res.sendFile(path.resolve(srtPath));
});

// --- Upload SRT file (manual) ---
const srtUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TRANSCRIPT_DIR),
    filename: (req, file, cb) => {
      const videoId = req.params.id;
      cb(null, `${videoId}.srt`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.srt', '.vtt', '.sub', '.ass', '.ssa'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan .srt, .vtt, .ass, atau .sub'));
    }
  }
});

app.post('/api/videos/:id/transcript/upload', srtUpload.single('subtitle'), async (req, res) => {
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file subtitle yang diupload' });

  const srtFilename = `${video.id}.srt`;
  const srtPath = path.join(TRANSCRIPT_DIR, srtFilename);

  // If uploaded file is not .srt, try to convert with ffmpeg
  const uploadedExt = path.extname(req.file.originalname).toLowerCase();
  if (uploadedExt !== '.srt') {
    const tempPath = path.join(TRANSCRIPT_DIR, `${video.id}_temp${uploadedExt}`);
    fs.renameSync(srtPath, tempPath);
    try {
      await shellRun('ffmpeg', ['-y', '-i', tempPath, '-c:s', 'srt', srtPath]);
      fs.unlinkSync(tempPath);
    } catch (err) {
      // If conversion fails, try to use raw content
      if (fs.existsSync(tempPath)) {
        fs.renameSync(tempPath, srtPath);
      }
      console.error('Subtitle conversion error:', err.message);
    }
  }

  const srtContent = fs.readFileSync(srtPath, 'utf-8');
  const rawText = extractRawTextFromSrt(srtContent);
  const lang = detectLanguageFromSrt(srtContent);

  // Remove old transcript
  const oldTranscript = db.transcripts.find(t => t.video_id === video.id);
  if (oldTranscript && oldTranscript.srt_filename && oldTranscript.srt_filename !== srtFilename) {
    const oldPath = path.join(TRANSCRIPT_DIR, oldTranscript.srt_filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.transcripts = db.transcripts.filter(t => t.video_id !== video.id);

  const transcriptId = uuidv4();
  db.transcripts.unshift({
    id: transcriptId, video_id: video.id, srt_filename: srtFilename,
    raw_text: rawText, language: lang, status: 'done', error: null,
    source: 'upload', created_at: new Date().toISOString()
  });
  video.status = 'transcribed';
  writeDB(db);
  console.log(`[info] Manual SRT uploaded for video ${video.id} (lang: ${lang})`);
  res.json({ success: true, language: lang, segments: srtContent.replace(/\r\n/g, '\n').trim().split(/\n\n+/).length });
});

// =============================================
// === ROUTES: Clip Export =====================
// =============================================

app.post('/api/videos/:id/export', async (req, res) => {
  const { start, end, label, burn_subtitle } = req.body;
  if (start === undefined || end === undefined) {
    return res.status(400).json({ error: 'start dan end wajib diisi' });
  }
  const s = parseFloat(start);
  const e = parseFloat(end);
  if (isNaN(s) || isNaN(e) || e <= s) {
    return res.status(400).json({ error: 'Rentang waktu tidak valid' });
  }
  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });

  const inputPath = path.join(UPLOAD_DIR, video.filename);
  const clipId = uuidv4();
  const outFilename = `${clipId}.mp4`;
  const outPath = path.join(CLIP_DIR, outFilename);
  const durationArg = (e - s).toFixed(2);

  let srtPath = null;
  if (burn_subtitle) {
    if (req.body.subtitle_source === 'translated') {
      const translation = db.translations?.find(t => t.video_id === video.id && t.status === 'done');
      if (translation && translation.srt_filename) {
        const candidatePath = path.join(TRANSCRIPT_DIR, translation.srt_filename);
        if (fs.existsSync(candidatePath)) srtPath = candidatePath;
      }
    } else {
      const transcript = db.transcripts.find(t => t.video_id === video.id && t.status === 'done');
      if (transcript && transcript.srt_filename) {
        const candidatePath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
        if (fs.existsSync(candidatePath)) srtPath = candidatePath;
      }
    }
  }

  const clip = {
    id: clipId, video_id: video.id,
    label: label || `Clip ${db.clips.length + 1}`,
    start, end, has_subtitle: !!srtPath,
    filename: outFilename, status: 'processing',
    created_at: new Date().toISOString()
  };
  db.clips.unshift(clip);
  writeDB(db);

  try {
    const ffArgs = ['-y', '-ss', String(s), '-i', inputPath, '-t', durationArg];
    if (srtPath) {
      ffArgs.push(...buildFfmpegSubtitleArgs(srtPath));
      if (nvencAvailable) {
        // GPU encoding (NVIDIA NVENC) — fast & efficient
        ffArgs.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-c:a', 'aac', '-b:a', '192k', outPath);
      } else {
        // CPU fallback — medium preset for good compression
        ffArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', outPath);
      }
    } else {
      ffArgs.push('-c:v', 'copy', '-c:a', 'copy', outPath);
    }
    await shellRun('ffmpeg', ffArgs);
    const db2 = readDB();
    const c = db2.clips.find(c => c.id === clipId);
    c.status = 'done';
    writeDB(db2);
    res.json(c);
  } catch (err) {
    console.error('ffmpeg export error:', err.message);
    const db2 = readDB();
    const c = db2.clips.find(c => c.id === clipId);
    c.status = 'failed';
    writeDB(db2);
    res.status(500).json({ error: 'Gagal export clip', detail: err.message });
  }
});

app.get('/api/clips', (req, res) => {
  const db = readDB();
  let clips = db.clips;
  if (req.query.video_id) clips = clips.filter(c => c.video_id === req.query.video_id);
  res.json(clips);
});

app.delete('/api/clips/:id', (req, res) => {
  const db = readDB();
  const clip = db.clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip tidak ditemukan' });
  const filePath = path.join(CLIP_DIR, clip.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.clips = db.clips.filter(c => c.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// =============================================
// === Auto Subtitle Translation ===============
// =============================================

const SUPPORTED_LANGUAGES = [
  'English', 'Indonesian', 'Japanese', 'Korean', 'Spanish',
  'French', 'German', 'Mandarin Chinese', 'Portuguese', 'Arabic',
  'Hindi', 'Thai', 'Vietnamese', 'Russian', 'Italian'
];

app.get('/api/openai-status', (req, res) => {
  res.json({ available: !!getOpenAI() });
});

app.get('/api/supported-languages', (req, res) => {
  res.json(SUPPORTED_LANGUAGES);
});

function buildTranslationPrompt(srtContent, targetLanguage, glossary = '') {
  let glossarySection = '';
  if (glossary && glossary.trim()) {
    glossarySection = `\n\nGLOSSARY / CUSTOM TERMS (MUST be used exactly as specified):\n${glossary.trim()}\n\nUse the glossary above to ensure names, brands, slang, and special terms are translated/transliterated correctly.`;
  }
  return {
    system: `You are a professional subtitle translator. Translate subtitle text from the source language to ${targetLanguage}.

CRITICAL RULES:
- Translate ONLY the text lines. NEVER modify index numbers or timestamps.
- Preserve the EXACT SRT format: index number, timestamp line, translated text, blank line.
- Keep translations concise — subtitles must be readable in the available time.
- Use natural, conversational ${targetLanguage} — not overly formal or literal.
- Preserve speaker tone and emotion in the translation.
- If a line contains a proper name (person, brand, place), keep it as-is or transliterate it naturally.
- Pay special attention to slang, idioms, and colloquial expressions — adapt them naturally.
- Fix obvious transcription errors (e.g., misspelled names) if you can infer the correct form.
- Output the complete translated SRT file and NOTHING ELSE. No explanation, no markdown.${glossarySection}`,
    user: srtContent
  };
}

// Translate subtitles using LLM
app.post('/api/videos/:id/translate', async (req, res) => {
  const client = getOpenAI();
  if (!client) {
    return res.status(503).json({ error: 'OPENAI_API_KEY belum di-set.' });
  }
  const { target_language, glossary } = req.body;
  if (!target_language) {
    return res.status(400).json({ error: 'target_language wajib diisi' });
  }

  const db = readDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const transcript = db.transcripts.find(t => t.video_id === video.id && t.status === 'done');
  if (!transcript || !transcript.srt_filename) {
    return res.status(400).json({ error: 'Video ini belum punya transcript. Transcribe dulu.' });
  }

  const originalSrtPath = path.join(TRANSCRIPT_DIR, transcript.srt_filename);
  if (!fs.existsSync(originalSrtPath)) {
    return res.status(400).json({ error: 'File SRT asli tidak ditemukan' });
  }

  // Remove old translation for this video
  if (!db.translations) db.translations = [];
  const oldTranslation = db.translations.find(t => t.video_id === video.id);
  if (oldTranslation && oldTranslation.srt_filename) {
    const oldPath = path.join(TRANSCRIPT_DIR, oldTranslation.srt_filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.translations = db.translations.filter(t => t.video_id !== video.id);

  const translationId = uuidv4();
  const langSlug = target_language.toLowerCase().replace(/\s+/g, '_');
  const translatedSrtFilename = `${video.id}_${langSlug}.srt`;
  const translation = {
    id: translationId,
    video_id: video.id,
    target_language,
    srt_filename: translatedSrtFilename,
    raw_text: null,
    status: 'processing',
    error: null,
    created_at: new Date().toISOString()
  };
  db.translations.push(translation);
  writeDB(db);

  // Respond immediately
  res.json(translation);

  // Background translation
  const srtContent = fs.readFileSync(originalSrtPath, 'utf-8');
  console.log(`[info] Memulai translation untuk video ${video.id} → ${target_language}...`);

  try {
    // Split SRT into chunks if too long (max ~80 segments per chunk)
    const blocks = srtContent.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
    const CHUNK_SIZE = 80;
    const chunks = [];
    for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
      chunks.push(blocks.slice(i, i + CHUNK_SIZE).join('\n\n'));
    }

    let translatedParts = [];

    for (let i = 0; i < chunks.length; i++) {
      const prompt = buildTranslationPrompt(chunks[i], target_language, glossary || '');
      console.log(`[info]   → Translating chunk ${i + 1}/${chunks.length}...`);
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        temperature: 0.3,
        max_tokens: 4000,
      });
      let content = completion.choices[0]?.message?.content || '';
      // Strip markdown code fences if present
      const codeBlockMatch = content.match(/```(?:srt)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) content = codeBlockMatch[1].trim();
      translatedParts.push(content.trim());
    }

    const translatedSrt = translatedParts.join('\n\n') + '\n';
    const translatedSrtPath = path.join(TRANSCRIPT_DIR, translatedSrtFilename);
    fs.writeFileSync(translatedSrtPath, translatedSrt, 'utf-8');

    // Extract raw text from translated SRT
    const rawTextParts = [];
    const translatedBlocks = translatedSrt.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
    for (const block of translatedBlocks) {
      const lines = block.trim().split('\n');
      if (lines.length >= 3) {
        rawTextParts.push(lines.slice(2).join(' ').trim());
      }
    }

    const db2 = readDB();
    const t = db2.translations.find(t => t.id === translationId);
    if (t) {
      t.status = 'done';
      t.raw_text = rawTextParts.join(' ');
    }
    writeDB(db2);
    console.log(`[info] Translation selesai: ${translatedBlocks.length} segments → ${target_language}`);
  } catch (err) {
    console.error('[error] Translation gagal:', err.message);
    const db2 = readDB();
    const t = db2.translations.find(t => t.id === translationId);
    if (t) {
      t.status = 'failed';
      t.error = err.message.slice(0, 500);
    }
    writeDB(db2);
  }
});

// Get translation for a video
app.get('/api/videos/:id/translation', (req, res) => {
  const db = readDB();
  if (!db.translations) db.translations = [];
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const translation = db.translations.find(t => t.video_id === req.params.id);
  if (!translation) return res.status(404).json({ error: 'Translation belum ada' });
  let srt_content = null;
  if (translation.srt_filename) {
    const srtPath = path.join(TRANSCRIPT_DIR, translation.srt_filename);
    if (fs.existsSync(srtPath)) srt_content = fs.readFileSync(srtPath, 'utf-8');
  }
  res.json({ ...translation, srt_content });
});

// Update translation SRT (manual edits)
app.put('/api/videos/:id/translation', (req, res) => {
  const { srt_content, raw_text } = req.body;
  if (!srt_content) return res.status(400).json({ error: 'srt_content wajib diisi' });
  const db = readDB();
  if (!db.translations) db.translations = [];
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video tidak ditemukan' });
  const translation = db.translations.find(t => t.video_id === req.params.id);
  if (!translation) return res.status(404).json({ error: 'Translation belum ada' });
  try {
    const srtPath = path.join(TRANSCRIPT_DIR, translation.srt_filename);
    fs.writeFileSync(srtPath, srt_content, 'utf-8');
    if (raw_text) translation.raw_text = raw_text;
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving translation:', err);
    res.status(500).json({ error: 'Gagal menyimpan terjemahan' });
  }
});

// =============================================
// === Start Server ============================
// =============================================

app.listen(PORT, () => {
  console.log(`Clip Studio jalan di http://localhost:${PORT}`);
  if (getOpenAI()) {
    console.log('[info] OpenAI API key terdeteksi ✓ — highlight detection siap');
  } else {
    console.warn('[warn] OPENAI_API_KEY belum di-set — highlight detection tidak akan jalan. Set dengan: set OPENAI_API_KEY=sk-xxx');
  }
});
