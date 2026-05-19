'use strict';

const input = document.getElementById('capture-input');
const appInput = document.getElementById('capture-app-input');
const captureFolderSelect = document.getElementById('capture-folder-select');
const attachImageBtn = document.getElementById('attach-image-capture-btn');
const attachFileBtn = document.getElementById('attach-file-capture-btn');
const pendingImagesEl = document.getElementById('capture-pending-images');
const modeNoteBtn = document.getElementById('capture-mode-note');
const modeReminderBtn = document.getElementById('capture-mode-reminder');
const workflowStatusEl = document.getElementById('capture-workflow-status');

const NOTE_FILE_WHITELIST_EXTS = ['pdf', 'md', 'rmd', 'txt'];
const PLACEHOLDER_NOTE = 'Type a note… Enter saves';
const PLACEHOLDER_REMINDER =
  'Describe the workflow — e.g. remind me to check deploy when i open Cursor';
let pendingImageDataUrls = [];
let pendingFileAttachments = [];
/** @type {'note' | 'reminder'} */
let captureMode = 'note';
/** Prevents overlapping saves (double Enter, key repeat, double button click). */
let captureBusy = false;

function setWorkflowStatus(message, isError = false) {
  if (!workflowStatusEl) return;
  if (!message) {
    workflowStatusEl.textContent = '';
    workflowStatusEl.classList.add('capture-workflow-status--hidden');
    workflowStatusEl.classList.remove('is-error');
    return;
  }
  workflowStatusEl.textContent = message;
  workflowStatusEl.classList.remove('capture-workflow-status--hidden');
  workflowStatusEl.classList.toggle('is-error', isError);
}

function setCaptureMode(mode, { focusInput = true } = {}) {
  captureMode = mode === 'reminder' ? 'reminder' : 'note';
  modeNoteBtn?.classList.toggle('is-active', captureMode === 'note');
  modeReminderBtn?.classList.toggle('is-active', captureMode === 'reminder');
  input.placeholder = captureMode === 'reminder' ? PLACEHOLDER_REMINDER : PLACEHOLDER_NOTE;
  if (captureMode === 'reminder') {
    appInput.placeholder = 'Optional — auto-filled when the workflow names an app';
    setWorkflowStatus('Enter runs the workflow and links the reminder to that app.');
  } else {
    appInput.placeholder = 'Link to app (optional): type app name or bundle id';
    setWorkflowStatus('');
  }
  if (focusInput) {
    input.focus();
    if (captureMode === 'reminder' && !input.value.trim()) {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function enterReminderMode() {
  setCaptureMode('reminder');
}

async function parseWorkflowFromInput(rawInputValue) {
  const trimmed = String(rawInputValue || '').trim();
  if (!trimmed) return null;
  try {
    return await window.mvp.parseRemindWorkflow(trimmed);
  } catch {
    return null;
  }
}

function shouldTryWorkflowParse(rawInputValue) {
  const trimmed = String(rawInputValue || '').trim();
  if (!trimmed) return false;
  return (
    /^remind\s+me\b/i.test(trimmed) ||
    /\bwhen\s+i\s+open\b/i.test(trimmed) ||
    /^surface\s+.+\s+when\s+i\s+open\b/i.test(trimmed)
  );
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function loadCaptureFolders() {
  if (!captureFolderSelect) return;
  let folders = [];
  try {
    folders = await window.mvp.listFolders();
  } catch {
    folders = [];
  }
  const opts = ['<option value="unfiled">Unfiled</option>'];
  for (const f of folders) {
    opts.push(`<option value="${f.id}">${escapeHtml(f.name)}</option>`);
  }
  captureFolderSelect.innerHTML = opts.join('');
}

function renderPendingImages() {
  if (!pendingImagesEl) return;
  if (pendingImageDataUrls.length === 0) {
    pendingImagesEl.classList.add('hidden');
    pendingImagesEl.innerHTML = '';
    return;
  }
  pendingImagesEl.classList.remove('hidden');
  pendingImagesEl.innerHTML = pendingImageDataUrls
    .map(
      (url, i) =>
        `<div class="capture-pending-thumb">
          <img src="${url}" alt="Pending image ${i + 1}" />
          <button type="button" class="capture-pending-thumb-remove" data-index="${i}" title="Remove">&times;</button>
        </div>`
    )
    .join('');
}

function resetCaptureForm() {
  input.value = '';
  appInput.value = '';
  if (captureFolderSelect) captureFolderSelect.value = 'unfiled';
  if (pendingImagesEl) {
    pendingImagesEl.classList.add('hidden');
    pendingImagesEl.innerHTML = '';
  }
  setCaptureMode('note', { focusInput: false });
}

async function applyManualFolder(noteId, folderValue) {
  if (!captureFolderSelect && folderValue === undefined) return;
  const sel =
    folderValue !== undefined ? folderValue : (captureFolderSelect?.value || 'unfiled');
  if (sel === 'unfiled') return;
  await window.mvp.setNoteFolder(noteId, sel);
}

async function maybeAiFileNote(noteId, folderValue) {
  const fv =
    folderValue !== undefined ? folderValue : (captureFolderSelect?.value || 'unfiled');
  if (fv && fv !== 'unfiled') return;
  await fileNoteWithAi(noteId);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed reading file'));
    reader.readAsDataURL(file);
  });
}

function extFromFileName(fileName) {
  const rawExt = String(fileName || '').toLowerCase().replace(/^.*\./, '');
  if (!rawExt) return null;
  if (!NOTE_FILE_WHITELIST_EXTS.includes(rawExt)) return null;
  return rawExt;
}

function noteTextWithFallback(text) {
  const trimmed = String(text || '').trim();
  if (trimmed) return trimmed;
  const hasPending = pendingImageDataUrls.length > 0 || pendingFileAttachments.length > 0;
  return hasPending ? '(attachment)' : '';
}

async function attachPendingArraysToNote(noteId, imageDataUrls, fileAttachments) {
  for (const dataUrl of imageDataUrls) {
    await window.mvp.addNoteImageFromDataUrl(noteId, dataUrl);
  }
  for (const file of fileAttachments) {
    await window.mvp.addNoteFileFromDataUrl(noteId, file.dataUrl, file.fileName, file.fileExt);
  }
}

async function attachPendingToNote(noteId) {
  await attachPendingArraysToNote(noteId, pendingImageDataUrls, pendingFileAttachments);
  pendingImageDataUrls = [];
  pendingFileAttachments = [];
}

/** Use AI to pick a folder for this note only; ignores other moveNote steps in the response. */
async function fileNoteWithAi(noteId) {
  const id = Number(noteId);
  if (!Number.isFinite(id) || id < 1) return;
  const userMessage = [
    `Organize exactly one note: id ${id}. It may be unfiled or new; use its preview text in the snapshot.`,
    'Choose the best matching folder from snapshot.folders, or add one createFolder then move this note there.',
    'Your plan must include exactly one moveNote for this note id and must not move any other note.',
  ].join(' ');
  let res;
  try {
    res = await window.mvp.organizeChat({ userMessage, history: [] });
  } catch {
    return;
  }
  if (!res || res.error || !Array.isArray(res.plan)) return;
  const filtered = res.plan.filter((step) => {
    if (step && step.op === 'createFolder') return true;
    if (step && step.op === 'moveNote' && Number(step.noteId) === id) return true;
    return false;
  });
  if (!filtered.some((s) => s && s.op === 'moveNote')) return;
  try {
    await window.mvp.applyOrganizePlan(filtered);
  } catch {
    /* note stays saved; filing is best-effort */
  }
}

async function buildSavePayloadFromDraft() {
  const text = noteTextWithFallback(input.value);
  if (!text) return null;
  const rawInputValue = String(input.value || '');
  let saveText = text;
  let appRaw = String(appInput.value || '');

  let parsed = null;
  if (shouldTryWorkflowParse(rawInputValue)) {
    parsed = await parseWorkflowFromInput(rawInputValue);
  }

  if (parsed && parsed.reminderText && parsed.appQuery) {
    saveText = parsed.reminderText;
    appRaw = parsed.appQuery;
    appInput.value = appRaw;
  }

  const folderValue = captureFolderSelect?.value || 'unfiled';
  return {
    saveText,
    appRaw,
    folderValue,
    images: [...pendingImageDataUrls],
    files: pendingFileAttachments.map((f) => ({
      dataUrl: f.dataUrl,
      fileName: f.fileName,
      fileExt: f.fileExt,
    })),
  };
}

async function runCaptureSavePipeline(payload) {
  const appKey = await window.mvp.resolveAppKey(payload.appRaw);
  const note = await window.mvp.saveCapture(payload.saveText, appKey);
  if (!note?.id) return;
  await attachPendingArraysToNote(note.id, payload.images, payload.files);
  await applyManualFolder(note.id, payload.folderValue);
  await maybeAiFileNote(note.id, payload.folderValue);
}

async function submitReminderWorkflow() {
  const text = input.value.trim();
  if (!text) {
    setWorkflowStatus('Type what the reminder should do.', true);
    return;
  }
  captureBusy = true;
  setWorkflowStatus('Running workflow…');
  try {
    const result = await window.mvp.runCaptureWorkflow(text);
    if (!result || result.error) {
      setWorkflowStatus(result?.error || 'Workflow failed.', true);
      return;
    }
    const noteId = result.note?.id;
    if (noteId) {
      const folderValue = captureFolderSelect?.value || 'unfiled';
      await applyManualFolder(noteId, folderValue);
      await maybeAiFileNote(noteId, folderValue);
      if (result.appQuery) appInput.value = result.appQuery;
    }
    resetCaptureForm();
    setCaptureMode('note', { focusInput: false });
    pendingImageDataUrls = [];
    pendingFileAttachments = [];
    window.mvp.hideCapture();
  } finally {
    captureBusy = false;
  }
}

async function submit() {
  if (captureBusy) return;
  if (captureMode === 'reminder') {
    await submitReminderWorkflow();
    return;
  }
  const payload = await buildSavePayloadFromDraft();
  if (!payload) {
    window.mvp.hideCapture();
    return;
  }
  captureBusy = true;
  try {
    await runCaptureSavePipeline(payload);
    resetCaptureForm();
    pendingImageDataUrls = [];
    pendingFileAttachments = [];
    window.mvp.hideCapture();
  } finally {
    captureBusy = false;
  }
}

async function handleEscape() {
  if (captureMode === 'reminder') {
    resetCaptureForm();
    window.mvp.hideCapture();
    return;
  }
  const hasText = input.value.trim().length > 0;
  const hasPending = pendingImageDataUrls.length > 0 || pendingFileAttachments.length > 0;
  if (!hasText && !hasPending) {
    resetCaptureForm();
    window.mvp.hideCapture();
    return;
  }
  if (captureBusy) return;
  const payload = await buildSavePayloadFromDraft();
  if (!payload) {
    resetCaptureForm();
    pendingImageDataUrls = [];
    pendingFileAttachments = [];
    window.mvp.hideCapture();
    return;
  }
  pendingImageDataUrls = [];
  pendingFileAttachments = [];
  resetCaptureForm();
  window.mvp.hideCapture();
  void runCaptureSavePipeline(payload).catch(() => {});
}

document.addEventListener('keydown', async (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  event.preventDefault();
  await handleEscape();
});

input.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    await submit();
  }
});

appInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    await submit();
  }
});

modeNoteBtn?.addEventListener('click', () => setCaptureMode('note'));
modeReminderBtn?.addEventListener('click', () => enterReminderMode());
modeReminderBtn?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  enterReminderMode();
});

window.mvp.onCaptureFocus(() => {
  void loadCaptureFolders();
  if (captureMode === 'note') {
    input.focus();
    input.select();
  } else {
    input.focus();
  }
});

void loadCaptureFolders();
setCaptureMode('note', { focusInput: true });

input.addEventListener('paste', async (event) => {
  const items = [...(event.clipboardData?.items || [])];
  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (!f) continue;
    files.push(f);
  }

  const imageFiles = files.filter((f) => String(f.type || '').startsWith('image/'));
  const fileFiles = files.filter((f) => extFromFileName(f.name));

  if (imageFiles.length === 0 && fileFiles.length === 0) {
    // Fall back to Electron's native clipboard for screenshots and browser-copied images
    const dataUrl = await window.mvp.readClipboardImage().catch(() => null);
    if (dataUrl) {
      event.preventDefault();
      pendingImageDataUrls.push(dataUrl);
      renderPendingImages();
    }
    return;
  }

  event.preventDefault();

  for (const f of imageFiles) {
    const dataUrl = await fileToDataUrl(f);
    pendingImageDataUrls.push(dataUrl);
  }
  for (const f of fileFiles) {
    const fileExt = extFromFileName(f.name);
    if (!fileExt) continue;
    const dataUrl = await fileToDataUrl(f);
    pendingFileAttachments.push({
      dataUrl,
      fileName: f.name || `pasted.${fileExt}`,
      fileExt,
    });
  }
  renderPendingImages();
});

pendingImagesEl?.addEventListener('click', (event) => {
  const btn = event.target.closest('.capture-pending-thumb-remove');
  if (!btn) return;
  const idx = Number(btn.dataset.index);
  if (!Number.isFinite(idx)) return;
  pendingImageDataUrls.splice(idx, 1);
  renderPendingImages();
});

attachImageBtn?.addEventListener('click', async () => {
  if (captureBusy) return;
  const rawInputValue = String(input.value || '');
  let text = input.value.trim() || '(attachment)';
  let appRaw = String(appInput.value || '');
  if (shouldTryWorkflowParse(rawInputValue)) {
    const parsed = await parseWorkflowFromInput(rawInputValue);
    if (parsed && parsed.reminderText && parsed.appQuery) {
      text = parsed.reminderText;
      appRaw = parsed.appQuery;
      appInput.value = appRaw;
    }
  }
  captureBusy = true;
  try {
    const appKey = await window.mvp.resolveAppKey(appRaw);
    const note = await window.mvp.saveCapture(text, appKey);
    if (note?.id) {
      await window.mvp.addNoteImagesFromPicker(note.id);
      await attachPendingToNote(note.id);
      await applyManualFolder(note.id);
      await maybeAiFileNote(note.id);
    }
  } finally {
    captureBusy = false;
    resetCaptureForm();
    window.mvp.hideCapture();
  }
});

attachFileBtn?.addEventListener('click', async () => {
  if (captureBusy) return;
  captureBusy = true;
  try {
    const rawInputValue = String(input.value || '');
    let text = input.value.trim() || '(attachment)';
    let appRaw = String(appInput.value || '');
    if (shouldTryWorkflowParse(rawInputValue)) {
      const parsed = await parseWorkflowFromInput(rawInputValue);
      if (parsed && parsed.reminderText && parsed.appQuery) {
        text = parsed.reminderText;
        appRaw = parsed.appQuery;
        appInput.value = appRaw;
      }
    }
    const appKey = await window.mvp.resolveAppKey(appRaw);
    const note = await window.mvp.saveCapture(text, appKey);
    if (note && note.id) {
      await window.mvp.addNoteFilesFromPicker(note.id);
      await attachPendingToNote(note.id);
      await applyManualFolder(note.id);
      await maybeAiFileNote(note.id);
    }
  } finally {
    captureBusy = false;
    resetCaptureForm();
    window.mvp.hideCapture();
  }
});
