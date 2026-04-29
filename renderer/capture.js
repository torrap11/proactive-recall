'use strict';

const input = document.getElementById('capture-input');
const appInput = document.getElementById('capture-app-input');
const attachImageBtn = document.getElementById('attach-image-capture-btn');
const attachFileBtn = document.getElementById('attach-file-capture-btn');

const NOTE_FILE_WHITELIST_EXTS = ['pdf', 'md', 'rmd', 'txt'];
let pendingImageDataUrls = [];
let pendingFileAttachments = [];

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

async function attachPendingToNote(noteId) {
  for (const dataUrl of pendingImageDataUrls) {
    await window.mvp.addNoteImageFromDataUrl(noteId, dataUrl);
  }
  for (const file of pendingFileAttachments) {
    await window.mvp.addNoteFileFromDataUrl(noteId, file.dataUrl, file.fileName, file.fileExt);
  }
  pendingImageDataUrls = [];
  pendingFileAttachments = [];
}

async function submit() {
  const text = noteTextWithFallback(input.value);
  if (!text) {
    window.mvp.hideCapture();
    return;
  }
  const appKey = await window.mvp.resolveAppKey(appInput.value);
  const note = await window.mvp.saveCapture(text, appKey);
  if (note?.id) await attachPendingToNote(note.id);
  input.value = '';
  appInput.value = '';
  window.mvp.hideCapture();
}

async function handleEscape() {
  const hasText = input.value.trim().length > 0;
  const hasPending = pendingImageDataUrls.length > 0 || pendingFileAttachments.length > 0;
  if (hasText || hasPending) {
    await submit();
    return;
  }
  input.value = '';
  appInput.value = '';
  window.mvp.hideCapture();
}

input.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await submit();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    await handleEscape();
  }
});

appInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    await submit();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    await handleEscape();
  }
});

window.mvp.onCaptureFocus(() => {
  input.focus();
  input.select();
});

input.focus();

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
  if (imageFiles.length === 0 && fileFiles.length === 0) return;

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
});

attachImageBtn?.addEventListener('click', async () => {
  const text = input.value.trim() || '(attachment)';
  try {
    const appKey = await window.mvp.resolveAppKey(appInput.value);
    const note = await window.mvp.saveCapture(text, appKey);
    if (note?.id) {
      await window.mvp.addNoteImagesFromPicker(note.id);
      await attachPendingToNote(note.id);
    }
  } finally {
    input.value = '';
    appInput.value = '';
    window.mvp.hideCapture();
  }
});

attachFileBtn?.addEventListener('click', async () => {
  try {
    const text = input.value.trim() || '(attachment)';
    const appKey = await window.mvp.resolveAppKey(appInput.value);
    const note = await window.mvp.saveCapture(text, appKey);
    if (note && note.id) {
      await window.mvp.addNoteFilesFromPicker(note.id);
      await attachPendingToNote(note.id);
    }
  } finally {
    input.value = '';
    appInput.value = '';
    window.mvp.hideCapture();
  }
});
