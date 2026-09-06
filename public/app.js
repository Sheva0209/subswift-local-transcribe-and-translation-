const state = {
  videos: [],
  clips: [],
  activeVideoId: null,
  inPoint: 0,
  outPoint: 0,
  duration: 0,
  dragging: null,
  transcript: null,
  whisperAvailable: false,
  openaiAvailable: false,
  transcriptCollapsed: false,
  // MVP-4 translation
  translation: null,
  translationCollapsed: false,
  isTranslating: false,
};

const el = {
  fileInput: document.getElementById('fileInput'),
  urlInput: document.getElementById('urlInput'),
  urlDownloadBtn: document.getElementById('urlDownloadBtn'),
  uploadStatus: document.getElementById('uploadStatus'),
  videoList: document.getElementById('videoList'),
  clipList: document.getElementById('clipList'),
  editorEmpty: document.getElementById('editorEmpty'),
  editorActive: document.getElementById('editorActive'),
  preview: document.getElementById('preview'),
  scrubber: document.getElementById('scrubber'),
  scrubberRange: document.getElementById('scrubberRange'),
  handleIn: document.getElementById('handleIn'),
  handleOut: document.getElementById('handleOut'),
  playhead: document.getElementById('playhead'),
  tcIn: document.getElementById('tcIn'),
  tcOut: document.getElementById('tcOut'),
  tcDur: document.getElementById('tcDur'),
  setInBtn: document.getElementById('setInBtn'),
  setOutBtn: document.getElementById('setOutBtn'),
  labelInput: document.getElementById('labelInput'),
  exportBtn: document.getElementById('exportBtn'),
  // MVP-3
  transcribeBtn: document.getElementById('transcribeBtn'),
  transcribeBtnText: document.getElementById('transcribeBtnText'),
  transcriptSection: document.getElementById('transcriptSection'),
  transcriptBody: document.getElementById('transcriptBody'),
  transcriptContent: document.getElementById('transcriptContent'),
  transcriptLang: document.getElementById('transcriptLang'),
  transcriptToggleBtn: document.getElementById('transcriptToggleBtn'),
  burnSubtitleToggle: document.getElementById('burnSubtitleToggle'),
  subtitleToggleWrap: document.getElementById('subtitleToggleWrap'),
  // MVP-4 translation
  targetLangSelect: document.getElementById('targetLangSelect'),
  translateBtn: document.getElementById('translateBtn'),
  translateBtnText: document.getElementById('translateBtnText'),
  translationSection: document.getElementById('translationSection'),
  translationBody: document.getElementById('translationBody'),
  translationContent: document.getElementById('translationContent'),
  translationLangBadge: document.getElementById('translationLangBadge'),
  translationToggleBtn: document.getElementById('translationToggleBtn'),
  saveTranslationToast: document.getElementById('saveTranslationToast'),
  subtitleSourceSelect: document.getElementById('subtitleSourceSelect'),
  // MVP-5 new elements
  downloadTranscriptBtn: document.getElementById('downloadTranscriptBtn'),
  downloadTranslationBtn: document.getElementById('downloadTranslationBtn'),
  srtFileInput: document.getElementById('srtFileInput'),
  uploadSrtLabel: document.getElementById('uploadSrtLabel'),
  glossaryInput: document.getElementById('glossaryInput'),
  glossaryDetails: document.getElementById('glossaryDetails'),
  transcriptSource: document.getElementById('transcriptSource'),
};

async function loadSupportedLanguages() {
  try {
    const langs = await api('/api/supported-languages');
    el.targetLangSelect.innerHTML = langs.map(l => `<option value="${l}">${l}</option>`).join('');
  } catch (err) {
    console.error('Failed to load supported languages', err);
  }
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '00:00.00';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function fmtTimeShort(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---- API helpers ----
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ---- Load data ----
async function loadVideos() {
  state.videos = await api('/api/videos');
  renderVideoList();
}
async function loadClips() {
  state.clips = await api('/api/clips');
  renderClipList();
}

async function checkWhisperStatus() {
  try {
    const res = await api('/api/whisper-status');
    state.whisperAvailable = res.available;
  } catch {
    state.whisperAvailable = false;
  }
  updateTranscribeUI();
}

async function checkOpenAIStatus() {
  try {
    const res = await api('/api/openai-status');
    state.openaiAvailable = res.available;
  } catch {
    state.openaiAvailable = false;
  }
  updateTranslateUI();
}

// ---- Upload ----
el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  el.uploadStatus.textContent = `Mengupload ${file.name}...`;
  const form = new FormData();
  form.append('video', file);
  try {
    const video = await api('/api/videos', { method: 'POST', body: form });
    el.uploadStatus.textContent = `Selesai: ${video.original_name}`;
    await loadVideos();
    selectVideo(video.id);
    setTimeout(() => (el.uploadStatus.textContent = ''), 2500);
  } catch (err) {
    el.uploadStatus.textContent = `Gagal: ${err.message}`;
  }
  el.fileInput.value = '';
});

// ---- Download from URL ----
let pollTimer = null;

el.urlDownloadBtn.addEventListener('click', async () => {
  const url = el.urlInput.value.trim();
  if (!url) return;
  el.urlDownloadBtn.disabled = true;
  el.uploadStatus.textContent = 'Memulai download...';
  try {
    await api('/api/videos/from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    el.urlInput.value = '';
    el.uploadStatus.textContent = 'Mendownload dari link... (bisa beberapa menit)';
    await loadVideos();
    startPolling();
  } catch (err) {
    el.uploadStatus.textContent = `Gagal: ${err.message}`;
  }
  el.urlDownloadBtn.disabled = false;
});

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadVideos();
    const stillPending = state.videos.some(v => v.status === 'downloading' || v.status === 'transcribing');
    if (!stillPending) {
      clearInterval(pollTimer);
      pollTimer = null;
      el.uploadStatus.textContent = '';
      if (state.activeVideoId) {
        const video = state.videos.find(v => v.id === state.activeVideoId);
        if (video && video.status === 'transcribed') {
          await loadTranscript(video.id);
        }
      }
    }
  }, 2500);
}

// ---- Video list render ----
function renderVideoList() {
  el.videoList.innerHTML = '';
  if (state.videos.length === 0) {
    el.videoList.innerHTML = '<div class="empty-hint">Belum ada video. Upload dulu.</div>';
    return;
  }
  for (const v of state.videos) {
    const li = document.createElement('li');
    li.className = 'video-item' + (v.id === state.activeVideoId ? ' active' : '');

    let metaHtml;
    if (v.status === 'downloading') {
      metaHtml = `<span class="status-downloading">mendownload...</span>`;
    } else if (v.status === 'transcribing') {
      metaHtml = `<span class="status-badge-transcribing">
        <span class="spinner" style="width:10px;height:10px;border-width:1.5px;display:inline-block;border:1.5px solid var(--line);border-top-color:var(--purple);border-radius:50%;animation:spin 0.8s linear infinite"></span>
        mentranskrip...
      </span>`;
    } else if (v.status === 'failed') {
      metaHtml = `<span class="status-failed">gagal: ${escapeHtml((v.error || '').slice(0, 60))}</span>`;
    } else if (v.status === 'transcribed') {
      metaHtml = `<span class="status-badge-transcribed">${v.duration_seconds ? fmtTime(v.duration_seconds) : '—'} · ✓ subtitle</span>`;
    } else {
      metaHtml = v.duration_seconds ? fmtTime(v.duration_seconds) : '—';
    }

    li.innerHTML = `
      <div class="video-item-name">${escapeHtml(v.original_name)}</div>
      <div class="video-item-meta">${metaHtml}</div>
      <div class="video-item-actions">
        <button class="mini-link danger" data-action="delete-video" data-id="${v.id}">hapus</button>
      </div>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.dataset.action) return;
      if (v.status !== 'ready' && v.status !== 'transcribed') return;
      selectVideo(v.id);
    });
    li.querySelector('[data-action="delete-video"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/videos/${v.id}`, { method: 'DELETE' });
      if (state.activeVideoId === v.id) {
        state.activeVideoId = null;
        state.transcript = null;
        state.translation = null;
        el.editorEmpty.classList.remove('hidden');
        el.editorActive.classList.add('hidden');
      }
      await loadVideos();
      await loadClips();
    });
    el.videoList.appendChild(li);
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---- Select video into editor ----
async function selectVideo(id) {
  const video = state.videos.find(v => v.id === id);
  if (!video) return;
  state.activeVideoId = id;
  state.duration = video.duration_seconds || 0;
  state.inPoint = 0;
  state.outPoint = state.duration;
  state.transcript = null;
  state.translation = null;
  state.isTranslating = false;

  el.preview.src = `/static/uploads/${video.filename}`;
  el.editorEmpty.classList.add('hidden');
  el.editorActive.classList.remove('hidden');
  el.labelInput.value = '';

  renderVideoList();
  updateScrubberUI();
  updateTranscribeUI();
  updateTranslateUI();

  // Load transcript if video is transcribed
  if (video.status === 'transcribed') {
    await loadTranscript(id);
  } else {
    hideTranscript();
  }

  // Load translation if any
  await loadTranslation(id);
}

// ---- Transcript functions ----
async function loadTranscript(videoId) {
  try {
    const transcript = await api(`/api/videos/${videoId}/transcript`);
    state.transcript = transcript;
    renderTranscript();
    updateTranscribeUI();
    updateTranslateUI();
  } catch {
    state.transcript = null;
    hideTranscript();
  }
}

let saveTimeout = null;

function renderTranscript() {
  const t = state.transcript;
  if (!t || t.status !== 'done') {
    hideTranscript();
    return;
  }
  el.transcriptSection.classList.remove('hidden');
  el.transcriptLang.textContent = t.language || '';

  // Show source badge (embedded / yt-dlp / upload / whisper)
  if (el.transcriptSource) {
    const source = t.source || 'whisper';
    const sourceLabels = { embedded: '✨ embedded', 'yt-dlp': '🌐 auto-caption', upload: '📁 uploaded', whisper: '🎙️ whisper' };
    el.transcriptSource.textContent = sourceLabels[source] || source;
    el.transcriptSource.className = 'transcript-source-badge source-' + source;
  }

  // Show/hide download button
  if (el.downloadTranscriptBtn) {
    el.downloadTranscriptBtn.classList.remove('hidden');
  }

  if (t.srt_content) {
    state.transcriptSegments = parseSRT(t.srt_content);
    let html = '';
    for (let i = 0; i < state.transcriptSegments.length; i++) {
      const seg = state.transcriptSegments[i];
      html += `<span class="transcript-segment" data-start="${seg.startSec}" data-end="${seg.endSec}">`;
      html += `<span class="transcript-timestamp" data-time="${seg.startSec}" title="Klik untuk seek ke ${fmtTimeShort(seg.startSec)}">${fmtTimeShort(seg.startSec)}</span>`;
      html += `<span class="transcript-text" contenteditable="true" data-index="${i}">${escapeHtml(seg.text)}</span> `;
      html += `</span>`;
    }
    el.transcriptContent.innerHTML = html;

    el.transcriptContent.querySelectorAll('.transcript-timestamp').forEach(ts => {
      ts.addEventListener('click', (e) => {
        e.stopPropagation();
        const time = parseFloat(ts.dataset.time);
        if (isFinite(time)) {
          el.preview.currentTime = time;
          el.preview.play().catch(() => {});
        }
      });
    });

    el.transcriptContent.querySelectorAll('.transcript-text').forEach(txt => {
      txt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); txt.blur(); }
      });
      txt.addEventListener('blur', () => {
        const i = parseInt(txt.dataset.index);
        const newText = txt.textContent.trim();
        if (state.transcriptSegments[i] && state.transcriptSegments[i].text !== newText) {
          state.transcriptSegments[i].text = newText;
          scheduleSaveTranscript();
        }
      });
    });
  } else if (t.raw_text) {
    el.transcriptContent.textContent = t.raw_text;
  }
  updateSubtitleToggle();
}

function scheduleSaveTranscript() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveTranscript, 1000);
}

async function saveTranscript() {
  if (!state.activeVideoId || !state.transcriptSegments) return;
  const saveToast = document.getElementById('saveToast');
  if (saveToast) saveToast.classList.add('visible');
  const srt_content = buildSRT(state.transcriptSegments);
  const raw_text = state.transcriptSegments.map(s => s.text).join(' ');
  try {
    await api(`/api/videos/${state.activeVideoId}/transcript`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt_content, raw_text })
    });
    if (state.transcript) {
      state.transcript.srt_content = srt_content;
      state.transcript.raw_text = raw_text;
    }
  } catch (err) {
    console.error('Failed to save transcript', err);
    alert('Gagal menyimpan perubahan transkrip');
  } finally {
    if (saveToast) setTimeout(() => saveToast.classList.remove('visible'), 1000);
  }
}

function hideTranscript() {
  el.transcriptSection.classList.add('hidden');
  el.transcriptContent.innerHTML = '';
  if (el.downloadTranscriptBtn) el.downloadTranscriptBtn.classList.add('hidden');
  if (el.transcriptSource) el.transcriptSource.textContent = '';
  updateSubtitleToggle();
}

function parseSRT(srtText) {
  const segments = [];
  const blocks = srtText.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const indexStr = lines[0];
    const timeLine = lines[1];
    const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) continue;
    const startSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
    const endSec = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
    const text = lines.slice(2).join('\n').trim();
    segments.push({ indexStr, timeLine, startSec, endSec, text });
  }
  return segments;
}

function buildSRT(segments) {
  return segments.map(seg => `${seg.indexStr}\n${seg.timeLine}\n${seg.text}\n`).join('\n');
}

// ---- Transcribe UI ----
function updateTranscribeUI() {
  if (!state.activeVideoId) return;
  const video = state.videos.find(v => v.id === state.activeVideoId);
  if (!video) return;
  const isTranscribing = video.status === 'transcribing';
  const isTranscribed = video.status === 'transcribed';
  const canTranscribe = (video.status === 'ready' || isTranscribed) && state.whisperAvailable;

  el.transcribeBtn.disabled = !canTranscribe && !isTranscribing;
  if (isTranscribing) {
    el.transcribeBtn.classList.add('is-transcribing');
    el.transcribeBtn.disabled = true;
    el.transcribeBtnText.textContent = 'Mentranskrip...';
    el.transcriptSection.classList.remove('hidden');
    el.transcriptContent.innerHTML = `
      <div class="transcript-processing">
        <div class="spinner"></div>
        <span>Whisper sedang memproses audio... ini bisa beberapa menit.</span>
      </div>
    `;
  } else if (isTranscribed) {
    el.transcribeBtn.classList.remove('is-transcribing');
    el.transcribeBtnText.textContent = 'Re-transcribe';
  } else {
    el.transcribeBtn.classList.remove('is-transcribing');
    el.transcribeBtnText.textContent = 'Transcribe';
  }

  if (!state.whisperAvailable && !isTranscribing) {
    el.transcribeBtn.title = 'faster-whisper belum terinstall (pip install faster-whisper)';
  } else {
    el.transcribeBtn.title = 'Transcribe video dengan Whisper';
  }
}

function updateSubtitleToggle() {
  const hasTranscript = state.transcript && state.transcript.status === 'done';
  const hasTranslation = state.translation && state.translation.status === 'done';
  if (hasTranscript) {
    el.subtitleToggleWrap.classList.remove('disabled');
    el.burnSubtitleToggle.disabled = false;
  } else {
    el.subtitleToggleWrap.classList.add('disabled');
    el.burnSubtitleToggle.checked = false;
    el.burnSubtitleToggle.disabled = true;
  }
  if (hasTranslation) {
    el.subtitleSourceSelect.classList.remove('hidden');
  } else {
    el.subtitleSourceSelect.classList.add('hidden');
    if (el.subtitleSourceSelect.value === 'translated') {
      el.subtitleSourceSelect.value = 'original';
    }
  }
}

// ---- Transcribe button handler ----
el.transcribeBtn.addEventListener('click', async () => {
  if (!state.activeVideoId) return;
  const video = state.videos.find(v => v.id === state.activeVideoId);
  if (!video) return;
  if (video.status === 'transcribed') {
    if (!confirm('Video ini sudah punya transcript. Mau transcribe ulang?')) return;
  }
  const glossary = el.glossaryInput ? el.glossaryInput.value.trim() : '';
  try {
    await api(`/api/videos/${state.activeVideoId}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glossary }),
    });
    await loadVideos();
    updateTranscribeUI();
    startPolling();
  } catch (err) {
    alert('Gagal transcribe: ' + err.message);
  }
});

// ---- Transcript toggle ----
el.transcriptToggleBtn.addEventListener('click', () => {
  state.transcriptCollapsed = !state.transcriptCollapsed;
  el.transcriptBody.classList.toggle('collapsed', state.transcriptCollapsed);
  el.transcriptToggleBtn.textContent = state.transcriptCollapsed ? '▸' : '▾';
});

// =============================================
// === MVP-4: Translation UI ===================
// =============================================

function updateTranslateUI() {
  if (!state.activeVideoId) return;
  const video = state.videos.find(v => v.id === state.activeVideoId);
  if (!video) return;
  const hasTranscript = state.transcript && state.transcript.status === 'done';
  const canTranslate = hasTranscript && state.openaiAvailable && !state.isTranslating;

  el.translateBtn.disabled = !canTranslate;
  el.targetLangSelect.disabled = !canTranslate;

  if (state.isTranslating) {
    el.translateBtn.classList.add('is-detecting');
    el.translateBtn.disabled = true;
    el.translateBtnText.textContent = 'Translating...';
  } else if (state.translation && state.translation.status === 'done') {
    el.translateBtn.classList.remove('is-detecting');
    el.translateBtnText.textContent = 'Re-translate';
  } else {
    el.translateBtn.classList.remove('is-detecting');
    el.translateBtnText.textContent = 'Translate';
  }

  if (!state.openaiAvailable) {
    el.translateBtn.title = 'OPENAI_API_KEY belum di-set di server';
  } else if (!hasTranscript) {
    el.translateBtn.title = 'Transcribe video dulu sebelum translate';
  } else {
    el.translateBtn.title = 'Translate subtitle menggunakan AI';
  }
}

// Translate button handler
el.translateBtn.addEventListener('click', async () => {
  if (!state.activeVideoId) return;
  const hasTranscript = state.transcript && state.transcript.status === 'done';
  if (!hasTranscript) return;

  if (state.translation) {
    if (!confirm('Terjemahan lama akan dihapus dan di-translate ulang. Lanjutkan?')) return;
  }

  state.isTranslating = true;
  updateTranslateUI();

  // Show detecting animation
  el.translationSection.classList.remove('hidden');
  el.translationLangBadge.textContent = el.targetLangSelect.value;
  el.translationContent.innerHTML = `
    <div class="transcript-processing">
      <div class="spinner"></div>
      <span>AI sedang menerjemahkan subtitle ke ${el.targetLangSelect.value}...</span>
    </div>
  `;

  const glossary = el.glossaryInput ? el.glossaryInput.value.trim() : '';
  try {
    await api(`/api/videos/${state.activeVideoId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_language: el.targetLangSelect.value, glossary })
    });

    // Poll for results
    startTranslationPolling();
  } catch (err) {
    state.isTranslating = false;
    updateTranslateUI();
    el.translationContent.innerHTML = `<div class="empty-hint" style="color:var(--danger)">Gagal: ${escapeHtml(err.message)}</div>`;
  }
});

let translationPollTimer = null;

function startTranslationPolling() {
  if (translationPollTimer) clearInterval(translationPollTimer);
  translationPollTimer = setInterval(async () => {
    if (!state.activeVideoId) {
      clearInterval(translationPollTimer);
      translationPollTimer = null;
      return;
    }
    const translation = await api(`/api/videos/${state.activeVideoId}/translation`).catch(() => null);
    if (translation && translation.status === 'done') {
      clearInterval(translationPollTimer);
      translationPollTimer = null;
      state.isTranslating = false;
      state.translation = translation;
      renderTranslation();
      updateTranslateUI();
    } else if (translation && translation.status === 'failed') {
      clearInterval(translationPollTimer);
      translationPollTimer = null;
      state.isTranslating = false;
      el.translationContent.innerHTML = `<div class="empty-hint" style="color:var(--danger)">Gagal: ${escapeHtml(translation.error)}</div>`;
      updateTranslateUI();
    }
  }, 3000);
}

async function loadTranslation(videoId) {
  try {
    const translation = await api(`/api/videos/${videoId}/translation`);
    state.translation = translation;
    if (translation.status === 'done') {
      renderTranslation();
    } else {
      el.translationSection.classList.add('hidden');
    }
    updateTranslateUI();
  } catch {
    state.translation = null;
    el.translationSection.classList.add('hidden');
  }
}

let saveTranslationTimeout = null;

function renderTranslation() {
  const t = state.translation;
  if (!t || t.status !== 'done') {
    el.translationSection.classList.add('hidden');
    return;
  }
  el.translationSection.classList.remove('hidden');
  el.translationLangBadge.textContent = t.target_language || '';

  if (t.srt_content) {
    state.translationSegments = parseSRT(t.srt_content);
    let html = '';
    for (let i = 0; i < state.translationSegments.length; i++) {
      const seg = state.translationSegments[i];
      html += `<span class="transcript-segment">`;
      html += `<span class="transcript-timestamp" data-time="${seg.startSec}" title="Klik untuk seek ke ${fmtTimeShort(seg.startSec)}">${fmtTimeShort(seg.startSec)}</span>`;
      html += `<span class="transcript-text" contenteditable="true" data-index="${i}">${escapeHtml(seg.text)}</span> `;
      html += `</span>`;
    }
    el.translationContent.innerHTML = html;

    el.translationContent.querySelectorAll('.transcript-timestamp').forEach(ts => {
      ts.addEventListener('click', (e) => {
        e.stopPropagation();
        const time = parseFloat(ts.dataset.time);
        if (isFinite(time)) {
          el.preview.currentTime = time;
          el.preview.play().catch(() => {});
        }
      });
    });

    el.translationContent.querySelectorAll('.transcript-text').forEach(txt => {
      txt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); txt.blur(); }
      });
      txt.addEventListener('blur', () => {
        const i = parseInt(txt.dataset.index);
        const newText = txt.textContent.trim();
        if (state.translationSegments[i] && state.translationSegments[i].text !== newText) {
          state.translationSegments[i].text = newText;
          scheduleSaveTranslation();
        }
      });
    });
  } else if (t.raw_text) {
    el.translationContent.textContent = t.raw_text;
  }
  // Show download button
  if (el.downloadTranslationBtn) {
    el.downloadTranslationBtn.classList.remove('hidden');
  }
  updateSubtitleToggle();
}

function scheduleSaveTranslation() {
  if (saveTranslationTimeout) clearTimeout(saveTranslationTimeout);
  saveTranslationTimeout = setTimeout(saveTranslation, 1000);
}

async function saveTranslation() {
  if (!state.activeVideoId || !state.translationSegments) return;
  const saveToast = el.saveTranslationToast;
  if (saveToast) saveToast.classList.add('visible');
  const srt_content = buildSRT(state.translationSegments);
  const raw_text = state.translationSegments.map(s => s.text).join(' ');
  try {
    await api(`/api/videos/${state.activeVideoId}/translation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt_content, raw_text })
    });
    if (state.translation) {
      state.translation.srt_content = srt_content;
      state.translation.raw_text = raw_text;
    }
  } catch (err) {
    console.error('Failed to save translation', err);
    alert('Gagal menyimpan perubahan terjemahan');
  } finally {
    if (saveToast) setTimeout(() => saveToast.classList.remove('visible'), 1000);
  }
}

// Translation toggle
el.translationToggleBtn.addEventListener('click', () => {
  state.translationCollapsed = !state.translationCollapsed;
  el.translationBody.classList.toggle('collapsed', state.translationCollapsed);
  el.translationToggleBtn.textContent = state.translationCollapsed ? '▸' : '▾';
});

// ---- Scrubber interactions ----
function pctToTime(pct) {
  return Math.min(state.duration, Math.max(0, pct * state.duration));
}
function timeToPct(t) {
  return state.duration ? t / state.duration : 0;
}

function updateScrubberUI() {
  const inPct = timeToPct(state.inPoint) * 100;
  const outPct = timeToPct(state.outPoint) * 100;
  el.handleIn.style.left = inPct + '%';
  el.handleOut.style.left = outPct + '%';
  el.scrubberRange.style.left = inPct + '%';
  el.scrubberRange.style.width = (outPct - inPct) + '%';
  el.tcIn.textContent = fmtTime(state.inPoint);
  el.tcOut.textContent = fmtTime(state.outPoint);
  el.tcDur.textContent = `dur ${(state.outPoint - state.inPoint).toFixed(2)}s`;
  el.exportBtn.disabled = state.outPoint <= state.inPoint;
}

function updatePlayheadUI() {
  const pct = timeToPct(el.preview.currentTime || 0) * 100;
  el.playhead.style.left = pct + '%';
}

el.preview.addEventListener('timeupdate', updatePlayheadUI);
el.preview.addEventListener('loadedmetadata', () => {
  if (!state.duration) {
    state.duration = el.preview.duration;
    state.outPoint = state.duration;
    updateScrubberUI();
  }
});

function scrubberEventToPct(e) {
  const rect = el.scrubber.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

el.handleIn.addEventListener('mousedown', () => (state.dragging = 'in'));
el.handleOut.addEventListener('mousedown', () => (state.dragging = 'out'));

el.scrubber.addEventListener('click', (e) => {
  if (e.target === el.handleIn || e.target === el.handleOut) return;
  const t = pctToTime(scrubberEventToPct(e));
  el.preview.currentTime = t;
});

window.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  const t = pctToTime(scrubberEventToPct(e));
  if (state.dragging === 'in') {
    state.inPoint = Math.min(t, state.outPoint - 0.05);
  } else {
    state.outPoint = Math.max(t, state.inPoint + 0.05);
  }
  updateScrubberUI();
});
window.addEventListener('mouseup', () => (state.dragging = null));

el.setInBtn.addEventListener('click', () => {
  state.inPoint = Math.min(el.preview.currentTime, state.outPoint - 0.05);
  updateScrubberUI();
});
el.setOutBtn.addEventListener('click', () => {
  state.outPoint = Math.max(el.preview.currentTime, state.inPoint + 0.05);
  updateScrubberUI();
});

// ---- Export ----
el.exportBtn.addEventListener('click', async () => {
  if (!state.activeVideoId) return;
  el.exportBtn.disabled = true;
  el.exportBtn.textContent = 'Memproses...';
  try {
    await api(`/api/videos/${state.activeVideoId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: state.inPoint,
        end: state.outPoint,
        label: el.labelInput.value.trim(),
        burn_subtitle: el.burnSubtitleToggle.checked,
        subtitle_source: el.subtitleSourceSelect.value,
      })
    });
    await loadClips();
  } catch (err) {
    alert('Gagal export: ' + err.message);
  }
  el.exportBtn.disabled = false;
  el.exportBtn.textContent = 'Export Clip';
});

// ---- Clip list render ----
function renderClipList() {
  el.clipList.innerHTML = '';
  if (state.clips.length === 0) {
    el.clipList.innerHTML = '<div class="empty-hint">Belum ada clip yang diexport.</div>';
    return;
  }
  for (const c of state.clips) {
    const li = document.createElement('li');
    li.className = 'clip-item';
    const statusClass = `status-${c.status}`;
    const subtitleBadge = c.has_subtitle ? '<span class="subtitle-indicator">CC</span>' : '';
    li.innerHTML = `
      <div class="clip-item-name">${escapeHtml(c.label)} <span class="status-tag ${statusClass}">${c.status}</span>${subtitleBadge}</div>
      <div class="clip-item-meta">${fmtTime(c.end - c.start)} · in ${fmtTime(c.start)}</div>
      <div class="clip-item-actions">
        ${c.status === 'done' ? `<a class="mini-link" href="/static/clips/${c.filename}" download>download</a>` : ''}
        <button class="mini-link danger" data-action="delete-clip" data-id="${c.id}">hapus</button>
      </div>
    `;
    li.querySelector('[data-action="delete-clip"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/clips/${c.id}`, { method: 'DELETE' });
      await loadClips();
    });
    el.clipList.appendChild(li);
  }
}

// ---- Init ----
loadSupportedLanguages();
loadVideos();
loadClips();
checkWhisperStatus();
checkOpenAIStatus();

// =============================================
// === MVP-5: Download SRT, Upload SRT, Highlight
// =============================================

// --- Download SRT buttons ---
if (el.downloadTranscriptBtn) {
  el.downloadTranscriptBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.activeVideoId) return;
    window.open(`/api/videos/${state.activeVideoId}/transcript/download`, '_blank');
  });
}
if (el.downloadTranslationBtn) {
  el.downloadTranslationBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.activeVideoId) return;
    window.open(`/api/videos/${state.activeVideoId}/translation/download`, '_blank');
  });
}

// --- Upload SRT file ---
if (el.srtFileInput) {
  el.srtFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !state.activeVideoId) return;

    const video = state.videos.find(v => v.id === state.activeVideoId);
    if (!video) return;

    if (video.status === 'transcribed') {
      if (!confirm('Video ini sudah punya transcript. Upload akan menggantikannya. Lanjutkan?')) {
        el.srtFileInput.value = '';
        return;
      }
    }

    el.uploadStatus.textContent = `Mengupload ${file.name}...`;
    const form = new FormData();
    form.append('subtitle', file);

    try {
      const result = await api(`/api/videos/${state.activeVideoId}/transcript/upload`, {
        method: 'POST',
        body: form
      });
      el.uploadStatus.textContent = `SRT berhasil diupload (${result.segments} segments, lang: ${result.language})`;
      await loadVideos();
      await loadTranscript(state.activeVideoId);
      updateTranscribeUI();
      updateTranslateUI();
      setTimeout(() => (el.uploadStatus.textContent = ''), 3000);
    } catch (err) {
      el.uploadStatus.textContent = `Gagal upload SRT: ${err.message}`;
    }
    el.srtFileInput.value = '';
  });
}

// --- Dynamic Transcript Highlight during Playback ---
let lastHighlightedIndex = -1;

function highlightActiveSegment(currentTime) {
  if (!state.transcriptSegments || state.transcriptSegments.length === 0) return;

  // Find active segment
  let activeIdx = -1;
  for (let i = 0; i < state.transcriptSegments.length; i++) {
    const seg = state.transcriptSegments[i];
    if (currentTime >= seg.startSec && currentTime <= seg.endSec) {
      activeIdx = i;
      break;
    }
  }

  if (activeIdx === lastHighlightedIndex) return;
  lastHighlightedIndex = activeIdx;

  // Clear all highlights in transcript
  const transcriptSegs = el.transcriptContent.querySelectorAll('.transcript-segment');
  transcriptSegs.forEach(s => s.classList.remove('segment-active'));

  // Clear all highlights in translation
  const translationSegs = el.translationContent.querySelectorAll('.transcript-segment');
  translationSegs.forEach(s => s.classList.remove('segment-active'));

  if (activeIdx >= 0) {
    // Highlight in transcript
    if (transcriptSegs[activeIdx]) {
      transcriptSegs[activeIdx].classList.add('segment-active');
      // Auto-scroll transcript to active segment
      if (!state.transcriptCollapsed) {
        scrollToActiveSegment(el.transcriptBody, transcriptSegs[activeIdx]);
      }
    }
    // Highlight in translation (same index)
    if (translationSegs[activeIdx]) {
      translationSegs[activeIdx].classList.add('segment-active');
      if (!state.translationCollapsed) {
        scrollToActiveSegment(el.translationBody, translationSegs[activeIdx]);
      }
    }
  }
}

function scrollToActiveSegment(container, element) {
  if (!container || !element) return;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const relativeTop = elementRect.top - containerRect.top;
  const containerHeight = container.clientHeight;
  // Scroll if element is not in the visible area
  if (relativeTop < 0 || relativeTop > containerHeight - 30) {
    container.scrollTo({
      top: container.scrollTop + relativeTop - containerHeight / 3,
      behavior: 'smooth'
    });
  }
}

// Hook into video timeupdate for highlight
el.preview.addEventListener('timeupdate', () => {
  highlightActiveSegment(el.preview.currentTime);
});
