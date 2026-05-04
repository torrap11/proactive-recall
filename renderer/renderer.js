'use strict';

const state = {
  notes: [],
  activeId: null,
  /** Note id highlighted for ↑↓ / Delete (may match activeId when a note is open). */
  listFocusId: null,
  selectedIds: new Set(),
  apps: [],
  folders: [],
  folderFilter: 'all',
  customPrompt: '',
  /** True when the search box is empty and we are rendering the default recent list. */
  isDefaultList: true,
};

const queryInput = document.getElementById('query');
const importDbBtn = document.getElementById('import-db-btn');
const exportDbBtn = document.getElementById('export-db-btn');
const aiKeyAccessStatusEl = document.getElementById('ai-key-access-status');
const aiKeyAccessBtn = document.getElementById('ai-key-access-btn');
const promptInputEl = document.getElementById('prompt-input');
const promptConfirmBtn = document.getElementById('prompt-confirm-btn');
const folderDiagramEl = document.getElementById('folder-diagram');
const bulkActionsEl = document.getElementById('bulk-actions');
const selectedCountEl = document.getElementById('selected-count');
const deleteSelectedBtn = document.getElementById('delete-selected-btn');
const resultsEl = document.getElementById('results');
const editorEl = document.getElementById('editor');
const editorDateEl = document.getElementById('editor-date');
const editorTextEl = document.getElementById('editor-text');
const closeEditorBtn = document.getElementById('close-editor-btn');
const copyBtn = document.getElementById('copy-note-btn');
const attachImageBtn = document.getElementById('attach-image-btn');
const attachFileBtn = document.getElementById('attach-file-btn');
const editorFolderSelect = document.getElementById('editor-folder-select');
const appSelect = document.getElementById('app-select');
const linkBtn = document.getElementById('link-btn');
const linksEl = document.getElementById('links');
const noteImagesEl = document.getElementById('note-images');
const noteFilesEl = document.getElementById('note-files');
const imageLightboxEl = document.getElementById('image-lightbox');
const imageLightboxImg = document.getElementById('image-lightbox-img');
const imageLightboxCloseBtn = document.querySelector('.image-lightbox-close');

let imageLightboxKeydownHandler = null;
const organizePanelEl = document.getElementById('organize-panel');
const organizeMessagesEl = document.getElementById('organize-messages');
const setApiKeyBtn = document.getElementById('set-api-key-btn');
const organizeApiStatusEl = document.getElementById('organize-api-status');
const apiKeyModal = document.getElementById('api-key-modal');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyErrorEl = document.getElementById('api-key-error');
const apiKeySaveBtn = document.getElementById('api-key-save');
const apiKeyCancelBtn = document.getElementById('api-key-cancel');
const anthropicKeyLink = document.getElementById('anthropic-key-link');

let saveTimer = null;
let organizeHistory = [];
const linkHistory = {
  undo: [],
  redo: [],
};
function areSameStringLists(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function resetLinkHistory() {
  linkHistory.undo = [];
  linkHistory.redo = [];
}

function pushLinkHistoryEntry(noteId, before, after) {
  if (!noteId) return;
  if (areSameStringLists(before, after)) return;
  linkHistory.undo.push({ noteId, before: [...before], after: [...after] });
  linkHistory.redo = [];
}

async function applyLinksSnapshot(noteId, targetLinks) {
  if (!noteId) return;
  const currentLinks = await window.mvp.getLinks(noteId);
  const currentSet = new Set(currentLinks);
  const targetSet = new Set(targetLinks);

  for (const appKey of currentSet) {
    if (!targetSet.has(appKey)) await window.mvp.removeLink(noteId, appKey);
  }
  for (const appKey of targetSet) {
    if (!currentSet.has(appKey)) await window.mvp.addLink(noteId, appKey);
  }
}

async function undoLinkChange() {
  if (!state.activeId) return;
  const entry = linkHistory.undo[linkHistory.undo.length - 1];
  if (!entry || entry.noteId !== state.activeId) return;
  linkHistory.undo.pop();
  await applyLinksSnapshot(state.activeId, entry.before);
  linkHistory.redo.push(entry);
  await renderLinks();
}

async function redoLinkChange() {
  if (!state.activeId) return;
  const entry = linkHistory.redo[linkHistory.redo.length - 1];
  if (!entry || entry.noteId !== state.activeId) return;
  linkHistory.redo.pop();
  await applyLinksSnapshot(state.activeId, entry.after);
  linkHistory.undo.push(entry);
  await renderLinks();
}

function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isUndoShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z';
}

function isRedoShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'z';
}

function closeImageLightbox() {
  if (!imageLightboxEl || !imageLightboxImg) return;
  imageLightboxEl.classList.add('hidden');
  imageLightboxImg.removeAttribute('src');
  imageLightboxImg.alt = '';
  if (imageLightboxKeydownHandler) {
    document.removeEventListener('keydown', imageLightboxKeydownHandler);
    imageLightboxKeydownHandler = null;
  }
}

function openImageLightbox(src, alt) {
  if (!imageLightboxEl || !imageLightboxImg || !src) return;
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt || 'Attachment';
  imageLightboxEl.classList.remove('hidden');
  imageLightboxKeydownHandler = (e) => {
    if (e.key === 'Escape') closeImageLightbox();
  };
  document.addEventListener('keydown', imageLightboxKeydownHandler);
}

function closeEditor() {
  clearTimeout(saveTimer);
  closeImageLightbox();
  state.activeId = null;
  resetLinkHistory();
  editorEl.classList.add('hidden');
  editorTextEl.value = '';
  editorFolderSelect.value = 'unfiled';
  linksEl.innerHTML = '';
  noteImagesEl.innerHTML = '';
  noteFilesEl.innerHTML = '';
  renderResults();
  if (state.listFocusId != null) focusListRow(state.listFocusId);
  else queryInput.focus();
}

function focusListRow(noteId) {
  if (noteId == null) return;
  requestAnimationFrame(() => {
    const btn = resultsEl.querySelector(`.result[data-id="${noteId}"]`);
    btn?.focus();
  });
}

function updateBulkActionsUi() {
  const count = state.selectedIds.size;
  selectedCountEl.textContent = `${count} selected`;
  bulkActionsEl.classList.toggle('hidden', count === 0);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTimeOnly(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function localDayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function loadApps() {
  state.apps = await window.mvp.listApps();
}

async function loadFolders() {
  state.folders = await window.mvp.listFolders();
  renderFolderControls();
}

function folderLabel(folderId) {
  if (folderId == null) return 'Unfiled';
  const id = Number(folderId);
  const hit = state.folders.find((f) => Number(f.id) === id);
  return hit ? hit.name : 'Folder';
}

function renderFolderControls() {
  const editorOptions = ['<option value="unfiled">Unfiled</option>'];
  for (const folder of state.folders) {
    const safeName = escapeHtml(folder.name);
    editorOptions.push(`<option value="${folder.id}">${safeName}</option>`);
  }
  editorFolderSelect.innerHTML = editorOptions.join('');
}

function labelForAppKey(bundleId) {
  const hit = state.apps.find((a) => a.bundleId === bundleId);
  return hit ? hit.name : bundleId;
}

function renderFolderDiagramHtml(diagram) {
  const root = String(diagram?.rootLabel || 'All notes');
  const unfiledCount = Number(diagram?.unfiledCount) || 0;
  const folders = Array.isArray(diagram?.folders) ? diagram.folders : [];
  const folderTotal = folders.reduce((sum, folder) => sum + (Number(folder.noteCount) || 0), 0);
  const totalCount = folderTotal + unfiledCount;
  const items = [];
  const rootActive = state.folderFilter === 'all' ? ' active' : '';
  items.push(`
    <button type="button" class="folder-node${rootActive}" data-folder-filter="all">
      <span class="folder-node-prefix">•</span>
      <span class="folder-node-name">${escapeHtml(root)}</span>
      <span class="folder-node-count">(${totalCount})</span>
    </button>
  `);
  if (folders.length === 0) {
    items.push(`
      <div class="folder-node empty">
        <span class="folder-node-prefix">└─</span>
        <span class="folder-node-name">(no folders yet)</span>
      </div>
    `);
  } else {
    folders.forEach((folder, idx) => {
      const branch = idx === folders.length - 1 ? '└─' : '├─';
      const count = Number(folder.noteCount) || 0;
      const active = String(state.folderFilter) === String(folder.id) ? ' active' : '';
      items.push(`
        <button type="button" class="folder-node${active}" data-folder-filter="${folder.id}">
          <span class="folder-node-prefix">${branch}</span>
          <span class="folder-node-name">${escapeHtml(folder.name)}</span>
          <span class="folder-node-count">(${count})</span>
        </button>
      `);
    });
  }
  const unfiledActive = state.folderFilter === 'unfiled' ? ' active' : '';
  items.push(`
    <button type="button" class="folder-node${unfiledActive}" data-folder-filter="unfiled">
      <span class="folder-node-prefix">•</span>
      <span class="folder-node-name">Unfiled</span>
      <span class="folder-node-count">(${unfiledCount})</span>
    </button>
  `);
  return items.join('');
}

async function refreshFolderDiagram() {
  if (!folderDiagramEl) return;
  try {
    const diagram = await window.mvp.getFolderDiagram();
    folderDiagramEl.innerHTML = `
      <div class="folder-diagram-title">Folder structure diagram</div>
      <div class="folder-diagram-tree">${renderFolderDiagramHtml(diagram)}</div>
    `;
    folderDiagramEl.classList.remove('hidden');
  } catch (error) {
    folderDiagramEl.innerHTML = `
      <div class="folder-diagram-title">Folder structure diagram</div>
      <div class="folder-diagram-tree">Unable to load (${escapeHtml(error.message || String(error))})</div>
    `;
    folderDiagramEl.classList.remove('hidden');
  }
}

folderDiagramEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.folder-node[data-folder-filter]');
  if (!btn) return;
  state.folderFilter = btn.dataset.folderFilter || 'all';
  void runQuery(queryInput.value.trim());
});

function tokenizeTopic(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !['about', 'with', 'from', 'that', 'this', 'when'].includes(part));
}

function extractGoalTopic(goal) {
  const lower = String(goal || '').toLowerCase();
  const stopMatch = lower.match(/stopped talking about\s+(.+?)(?:[.?!]|$)/);
  if (stopMatch && stopMatch[1]) return stopMatch[1].trim();
  const aboutMatch = lower.match(/about\s+(.+?)(?:[.?!]|$)/);
  if (aboutMatch && aboutMatch[1]) return aboutMatch[1].trim();
  return '';
}

function applyCustomGoalSort(notes) {
  const goalRaw = String(state.customPrompt || '').trim().toLowerCase();
  let filtered = [...notes];

  // Timeline slicing is intentionally limited (time filtering like "last hour"/"tonight" is removed).
  const wantsTimeline = goalRaw.includes('stopped talking about');

  const topic = extractGoalTopic(goalRaw);
  const keywords = tokenizeTopic(topic);
  if (keywords.length > 0 && wantsTimeline) {
    const asc = filtered
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    let cutoffMs = null;
    for (const note of asc) {
      const text = String(note.text || '').toLowerCase();
      if (keywords.some((keyword) => text.includes(keyword))) {
        cutoffMs = new Date(note.created_at).getTime();
      }
    }
    if (cutoffMs != null) {
      filtered = filtered.filter((note) => {
        const createdMs = new Date(note.created_at).getTime();
        return Number.isFinite(createdMs) && createdMs <= cutoffMs;
      });
    }
  }

  if (wantsTimeline) {
    filtered = filtered.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  return filtered;
}

async function runQuery(text) {
  state.isDefaultList = !text;
  const baseNotes = text
    ? await window.mvp.queryNotes(text, state.folderFilter)
    : await window.mvp.recentNotes(state.folderFilter);
  state.notes = applyCustomGoalSort(baseNotes);
  const validIds = new Set(state.notes.map((n) => n.id));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => validIds.has(id)));
  if (state.listFocusId != null && !state.notes.some((n) => n.id === state.listFocusId)) {
    state.listFocusId = state.notes[0]?.id ?? null;
  }
  renderResults();
  updateBulkActionsUi();
  await refreshFolderDiagram();
}

function renderResults() {
  if (state.notes.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No notes found.</div>';
    return;
  }
  const sameLocalDay = state.notes.every(
    (n) => localDayKey(n.created_at) === localDayKey(state.notes[0].created_at)
  );
  // When not searching, if every visible note shares one local day, show time-only in the list.
  const hideDate = state.isDefaultList && sameLocalDay;

  resultsEl.innerHTML = state.notes
    .map((note) => {
      const preview = note.text.split('\n')[0].slice(0, 120);
      const dateText = hideDate ? formatTimeOnly(note.created_at) : formatDate(note.created_at);
      const folderText = folderLabel(note.folder_id);
      const safeTime = escapeHtml(dateText || 'Unknown');
      const safeFolder = escapeHtml(folderText);
      const active = note.id === state.activeId ? ' active' : '';
      const listFocus = note.id === state.listFocusId ? ' list-focus' : '';
      const selected = state.selectedIds.has(note.id) ? ' checked' : '';
      const tab = note.id === state.listFocusId ? '0' : '-1';
      return `<div class="result-row${active}${listFocus}" data-id="${note.id}">
        <label class="result-select" title="Select note">
          <input type="checkbox" class="result-checkbox" data-id="${note.id}"${selected} />
        </label>
        <button type="button" class="result" data-id="${note.id}" tabindex="${tab}">
          <span class="result-date">
            <span class="meta-value meta-time-value">${safeTime}</span>
            <span class="meta-sep">|</span>
            <span class="meta-value meta-folder-value">${safeFolder}</span>
          </span>
          <span class="result-text">${escapeHtml(preview)}</span>
        </button>
        <button type="button" class="result-delete" data-id="${note.id}" title="Delete note">×</button>
      </div>`;
    })
    .join('');
}

async function openNote(noteId) {
  const note = await window.mvp.getNote(noteId);
  if (!note) return;
  const switchedNotes = state.activeId !== note.id;
  state.activeId = note.id;
  state.listFocusId = note.id;
  if (switchedNotes) resetLinkHistory();
  editorEl.classList.remove('hidden');
  editorDateEl.textContent = formatDate(note.created_at);
  editorTextEl.value = note.text;
  editorFolderSelect.value = note.folder_id == null ? 'unfiled' : String(note.folder_id);
  renderResults();
  await renderLinks();
  await renderNoteImages();
  await renderNoteFiles();
}

async function renderLinks() {
  if (!state.activeId) {
    linksEl.innerHTML = '';
    return;
  }
  const links = await window.mvp.getLinks(state.activeId);
  if (!links.length) {
    linksEl.innerHTML = '';
    return;
  }
  linksEl.innerHTML = links
    .map(
      (appKey) =>
        `<button type="button" class="chip" data-remove="${escapeHtml(appKey)}">${escapeHtml(labelForAppKey(appKey))} ×</button>`
    )
    .join('');
}

async function renderNoteImages() {
  if (!state.activeId) {
    noteImagesEl.innerHTML = '';
    return;
  }
  const images = await window.mvp.listNoteImages(state.activeId);
  if (!Array.isArray(images) || images.length === 0) {
    noteImagesEl.innerHTML = '';
    return;
  }
  noteImagesEl.innerHTML = images
    .map((image) => {
      const src = image.data_url || image.file_url || '';
      return `<div class="note-image-card" role="button" tabindex="0" aria-label="View attachment full size">
        <img src="${escapeAttr(src)}" alt="Attachment" />
        <button type="button" class="note-image-remove" data-image-id="${image.id}" title="Remove image">×</button>
      </div>`;
    })
    .join('');
}

async function renderNoteFiles() {
  if (!state.activeId) {
    noteFilesEl.innerHTML = '';
    return;
  }
  const files = await window.mvp.listNoteFiles(state.activeId);
  if (!Array.isArray(files) || files.length === 0) {
    noteFilesEl.innerHTML = '';
    return;
  }

  noteFilesEl.innerHTML = files
    .map(
      (file) => `<div class="note-file-card">
        <div class="note-file-meta">
          <span class="note-file-name" title="${escapeAttr(file.file_name)}">${escapeHtml(file.file_name)}</span>
          <span class="note-file-ext">${escapeHtml(file.file_ext)}</span>
        </div>
        <button type="button" class="note-file-open" data-file-id="${file.id}" title="Open attached file">Open</button>
        <button type="button" class="note-file-remove" data-file-id="${file.id}" title="Remove file">×</button>
      </div>`
    )
    .join('');
}

async function saveActiveNote() {
  if (!state.activeId) return;
  const value = editorTextEl.value.trim();
  if (!value) return;
  await window.mvp.updateNote(state.activeId, value);
  await runQuery(queryInput.value.trim());
}

async function removeNoteById(id) {
  if (!Number.isFinite(id)) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  const snap = [...state.notes];
  const idx = snap.findIndex((n) => n.id === id);
  const neighbor = idx >= 0 ? (snap[idx + 1] || snap[idx - 1]) : null;
  const ok = await window.mvp.deleteNote(id);
  if (!ok) return;
  if (state.activeId === id) {
    state.activeId = null;
    editorEl.classList.add('hidden');
    editorTextEl.value = '';
    linksEl.innerHTML = '';
  }
  state.selectedIds.delete(id);
  state.listFocusId = null;
  await runQuery(queryInput.value.trim());
  state.listFocusId =
    neighbor && state.notes.some((n) => n.id === neighbor.id) ? neighbor.id : (state.notes[0]?.id ?? null);
  renderResults();
  if (state.listFocusId != null) focusListRow(state.listFocusId);
  else queryInput.focus();
}

async function removeSelectedNotes() {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} selected note${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;

  const deletedCount = await window.mvp.deleteNotes(ids);
  if (!deletedCount) return;

  if (state.activeId != null && ids.includes(state.activeId)) {
    state.activeId = null;
    editorEl.classList.add('hidden');
    editorTextEl.value = '';
    linksEl.innerHTML = '';
  }

  state.selectedIds.clear();
  state.listFocusId = null;
  await runQuery(queryInput.value.trim());
  if (state.notes.length > 0) {
    state.listFocusId = state.notes[0].id;
    renderResults();
    focusListRow(state.listFocusId);
  } else {
    queryInput.focus();
  }
}

queryInput.addEventListener('input', () => {
  runQuery(queryInput.value.trim());
});

importDbBtn?.addEventListener('click', async () => {
  await window.mvp.importDbFromPicker();
});

exportDbBtn?.addEventListener('click', async () => {
  await window.mvp.exportDbFromPicker();
});

promptInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void applyPrompt();
    return;
  }

  if (event.key === 'ArrowDown' && state.notes.length > 0) {
    event.preventDefault();
    if (state.listFocusId == null) state.listFocusId = state.notes[0].id;
    else {
      const i = state.notes.findIndex((n) => n.id === state.listFocusId);
      if (i >= 0 && i < state.notes.length - 1) state.listFocusId = state.notes[i + 1].id;
    }
    renderResults();
    focusListRow(state.listFocusId);
    return;
  }

  if (event.key === 'ArrowUp' && state.notes.length > 0) {
    event.preventDefault();
    if (state.listFocusId == null) return;
    const i = state.notes.findIndex((n) => n.id === state.listFocusId);
    if (i <= 0) {
      state.listFocusId = null;
      renderResults();
      queryInput.focus();
    } else {
      state.listFocusId = state.notes[i - 1].id;
      renderResults();
      focusListRow(state.listFocusId);
    }
  }
});

promptConfirmBtn?.addEventListener('click', () => {
  void applyPrompt();
});

async function applyPrompt() {
  state.customPrompt = String(promptInputEl.value || '').trim();
  await runQuery(queryInput.value.trim());
  if (!state.customPrompt) return;

  const originalLabel = promptConfirmBtn?.textContent || 'Confirm';
  promptConfirmBtn.disabled = true;
  promptInputEl.disabled = true;
  promptConfirmBtn.textContent = 'Working...';
  try {
    await runOrganizerFromPrompt(state.customPrompt);
  } finally {
    promptConfirmBtn.disabled = false;
    promptInputEl.disabled = false;
    promptConfirmBtn.textContent = originalLabel;
  }
}

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.mvp.hideSearch();
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Enter' && state.listFocusId != null) {
    event.preventDefault();
    void openNote(state.listFocusId);
    return;
  }

  if (event.key === 'ArrowDown' && state.notes.length > 0) {
    event.preventDefault();
    if (state.listFocusId == null) state.listFocusId = state.notes[0].id;
    else {
      const i = state.notes.findIndex((n) => n.id === state.listFocusId);
      if (i >= 0 && i < state.notes.length - 1) state.listFocusId = state.notes[i + 1].id;
    }
    renderResults();
    focusListRow(state.listFocusId);
    return;
  }

  if (event.key === 'ArrowUp' && state.notes.length > 0) {
    if (state.listFocusId == null) return;
    event.preventDefault();
    const i = state.notes.findIndex((n) => n.id === state.listFocusId);
    if (i <= 0) {
      state.listFocusId = null;
      renderResults();
    } else {
      state.listFocusId = state.notes[i - 1].id;
      renderResults();
      focusListRow(state.listFocusId);
    }
  }
});

resultsEl.addEventListener('change', (event) => {
  const checkbox = event.target.closest('.result-checkbox');
  if (!checkbox) return;
  const id = Number(checkbox.dataset.id);
  if (checkbox.checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  updateBulkActionsUi();
});

resultsEl.addEventListener('click', (event) => {
  const del = event.target.closest('.result-delete');
  if (del) {
    event.stopPropagation();
    void removeNoteById(Number(del.dataset.id));
    return;
  }
  const button = event.target.closest('.result');
  if (!button) return;
  openNote(Number(button.dataset.id));
});

resultsEl.addEventListener(
  'keydown',
  (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const row = event.target.closest('.result-row');
    if (!row) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const currentId = Number(row.dataset.id);
      const i = state.notes.findIndex((n) => n.id === currentId);
      if (i < 0) return;
      if (event.key === 'ArrowDown') {
        if (i < state.notes.length - 1) {
          state.listFocusId = state.notes[i + 1].id;
          renderResults();
          focusListRow(state.listFocusId);
        }
      } else if (i > 0) {
        state.listFocusId = state.notes[i - 1].id;
        renderResults();
        focusListRow(state.listFocusId);
      } else {
        state.listFocusId = null;
        renderResults();
        queryInput.focus();
      }
      return;
    }

    if (event.key === 'Enter') {
      const openId = Number(row.dataset.id);
      event.preventDefault();
      void openNote(openId);
      return;
    }
  },
  true
);

editorTextEl.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveActiveNote();
  }, 250);
});

editorTextEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeEditor();
  }
});

closeEditorBtn.addEventListener('click', () => {
  closeEditor();
});

attachImageBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  await window.mvp.addNoteImagesFromPicker(state.activeId);
  await renderNoteImages();
});

attachFileBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  await window.mvp.addNoteFilesFromPicker(state.activeId);
  await renderNoteFiles();
});

copyBtn.addEventListener('click', async () => {
  await window.mvp.copyText(editorTextEl.value);
});

deleteSelectedBtn.addEventListener('click', () => {
  void removeSelectedNotes();
});

async function submitAppLink() {
  const appKey = await window.mvp.resolveAppKey(appSelect.value);
  if (!appKey || !state.activeId) return;
  const before = await window.mvp.getLinks(state.activeId);
  await window.mvp.addLink(state.activeId, appKey);
  const after = await window.mvp.getLinks(state.activeId);
  pushLinkHistoryEntry(state.activeId, before, after);
  appSelect.value = '';
  await renderLinks();
  appSelect.focus();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed reading file'));
    reader.readAsDataURL(file);
  });
}

const NOTE_FILE_WHITELIST_EXTS = ['pdf', 'md', 'rmd', 'txt'];

function extFromFileName(fileName) {
  const rawExt = String(fileName || '').toLowerCase().replace(/^.*\./, '');
  if (!rawExt) return null;
  if (!NOTE_FILE_WHITELIST_EXTS.includes(rawExt)) return null;
  return rawExt;
}

linkBtn.addEventListener('click', () => {
  void submitAppLink();
});

appSelect.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  void submitAppLink();
});

editorFolderSelect.addEventListener('change', async () => {
  if (!state.activeId) return;
  const nextFolder = editorFolderSelect.value || 'unfiled';
  const updated = await window.mvp.setNoteFolder(state.activeId, nextFolder);
  if (!updated) return;
  await runQuery(queryInput.value.trim());
});

editorTextEl.addEventListener('paste', async (event) => {
  if (!state.activeId) return;
  const items = [...(event.clipboardData?.items || [])];

  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    files.push(file);
  }

  const imageFiles = files.filter((f) => String(f.type || '').startsWith('image/'));
  const noteFileFiles = files.filter((f) => extFromFileName(f.name));

  if (imageFiles.length === 0 && noteFileFiles.length === 0) return;

  event.preventDefault();

  for (const file of imageFiles) {
    const dataUrl = await fileToDataUrl(file);
    await window.mvp.addNoteImageFromDataUrl(state.activeId, dataUrl);
  }

  for (const file of noteFileFiles) {
    const fileExt = extFromFileName(file.name);
    if (!fileExt) continue;
    const dataUrl = await fileToDataUrl(file);
    await window.mvp.addNoteFileFromDataUrl(state.activeId, dataUrl, file.name || `pasted.${fileExt}`, fileExt);
  }

  await renderNoteImages();
  await renderNoteFiles();
});

linksEl.addEventListener('click', async (event) => {
  const chip = event.target.closest('.chip');
  if (!chip || !state.activeId) return;
  const appKey = chip.dataset.remove;
  const before = await window.mvp.getLinks(state.activeId);
  await window.mvp.removeLink(state.activeId, appKey);
  const after = await window.mvp.getLinks(state.activeId);
  pushLinkHistoryEntry(state.activeId, before, after);
  await renderLinks();
});

noteImagesEl.addEventListener('click', async (event) => {
  const removeBtn = event.target.closest('.note-image-remove');
  if (removeBtn) {
    if (!state.activeId) return;
    const imageId = Number(removeBtn.dataset.imageId);
    if (!Number.isFinite(imageId)) return;
    await window.mvp.removeNoteImage(state.activeId, imageId);
    await renderNoteImages();
    return;
  }

  const card = event.target.closest('.note-image-card');
  if (!card) return;
  const img = card.querySelector('img');
  if (!img || !img.getAttribute('src')) return;
  openImageLightbox(img.currentSrc || img.src, img.alt || 'Attachment');
});

noteImagesEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.note-image-card');
  if (!card || event.target.closest('.note-image-remove')) return;
  event.preventDefault();
  const img = card.querySelector('img');
  if (!img || !img.getAttribute('src')) return;
  openImageLightbox(img.currentSrc || img.src, img.alt || 'Attachment');
});

if (imageLightboxEl && imageLightboxImg) {
  imageLightboxEl.addEventListener('click', (event) => {
    if (event.target === imageLightboxImg) return;
    closeImageLightbox();
  });
}

imageLightboxCloseBtn?.addEventListener('click', () => closeImageLightbox());

noteFilesEl.addEventListener('click', async (event) => {
  if (!state.activeId) return;

  const openBtn = event.target.closest('.note-file-open');
  if (openBtn) {
    const fileId = Number(openBtn.dataset.fileId);
    if (!Number.isFinite(fileId)) return;
    await window.mvp.openNoteFile(state.activeId, fileId);
    return;
  }

  const removeBtn = event.target.closest('.note-file-remove');
  if (removeBtn) {
    const fileId = Number(removeBtn.dataset.fileId);
    if (!Number.isFinite(fileId)) return;
    await window.mvp.removeNoteFile(state.activeId, fileId);
    await renderNoteFiles();
  }
});

function appendOrganizeBubble(role, text, isError) {
  const div = document.createElement('div');
  div.className = `organize-msg ${role}${isError ? ' error' : ''}`;
  div.textContent = text;
  organizeMessagesEl.appendChild(div);
  organizeMessagesEl.scrollTop = organizeMessagesEl.scrollHeight;
}

async function refreshAiKeyStatus() {
  let line = 'API status unavailable';
  try {
    const status = await window.mvp.getAiKeyStatus();
    const hasKey = status && status.hasKey;
    line = hasKey ? 'Anthropic API key is saved on this Mac.' : 'No Anthropic API key yet — set one to use AI organize.';
    if (organizeApiStatusEl) organizeApiStatusEl.textContent = hasKey ? 'API key set' : 'API key not set';
  } catch (_error) {
    if (organizeApiStatusEl) organizeApiStatusEl.textContent = 'API status unavailable';
  }
  if (aiKeyAccessStatusEl) aiKeyAccessStatusEl.textContent = line;
}

function showApiKeyModal() {
  if (!apiKeyModal || !apiKeyInput) return;
  apiKeyErrorEl?.classList.add('hidden');
  if (apiKeyErrorEl) apiKeyErrorEl.textContent = '';
  apiKeyInput.value = '';
  apiKeyModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    apiKeyInput.focus();
    apiKeyInput.select();
  });
}

function hideApiKeyModal() {
  apiKeyModal?.classList.add('hidden');
}

async function saveApiKeyFromModal() {
  if (!apiKeyInput) return;
  const trimmed = apiKeyInput.value.trim();
  if (!trimmed) {
    if (apiKeyErrorEl) {
      apiKeyErrorEl.textContent = 'Enter your API key.';
      apiKeyErrorEl.classList.remove('hidden');
    }
    return;
  }
  if (apiKeySaveBtn) apiKeySaveBtn.disabled = true;
  try {
    const result = await window.mvp.setAiKey(trimmed);
    if (!result || !result.ok) {
      if (apiKeyErrorEl) {
        apiKeyErrorEl.textContent = (result && result.error) || 'Failed to save API key.';
        apiKeyErrorEl.classList.remove('hidden');
      }
      return;
    }
    await refreshAiKeyStatus();
    hideApiKeyModal();
  } catch (e) {
    if (apiKeyErrorEl) {
      apiKeyErrorEl.textContent = e.message || String(e);
      apiKeyErrorEl.classList.remove('hidden');
    }
  } finally {
    if (apiKeySaveBtn) apiKeySaveBtn.disabled = false;
  }
}

async function runOrganizerFromPrompt(promptText) {
  const text = String(promptText || '').trim();
  if (!text) return;
  organizePanelEl.classList.remove('hidden');
  appendOrganizeBubble('user', text, false);
  try {
    const res = await window.mvp.organizeChat({
      userMessage: text,
      history: organizeHistory,
    });
    if (res.error) {
      let detail = res.error;
      if (res.raw) detail += `\n\n---\n${String(res.raw).slice(0, 2000)}`;
      appendOrganizeBubble('assistant', detail, true);
      return;
    }

    organizeHistory.push({ role: 'user', content: text });
    organizeHistory.push({ role: 'assistant', content: res.reply });
    if (organizeHistory.length > 16) organizeHistory.splice(0, organizeHistory.length - 16);

    const hasPlan = Array.isArray(res.plan) && res.plan.length > 0;
    if (!hasPlan) {
      appendOrganizeBubble('assistant', res.reply || 'No organization changes suggested.', false);
      return;
    }

    const result = await window.mvp.applyOrganizePlan(res.plan);
    const summary = [
      result.applied.length ? `Done (${result.applied.length} steps).` : 'No steps applied.',
      result.errors.length ? `Issues: ${result.errors.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    appendOrganizeBubble('assistant', summary, result.errors.length > 0);
    await loadFolders();
    await runQuery(queryInput.value.trim());
    if (state.activeId != null) {
      const note = await window.mvp.getNote(state.activeId);
      if (note) editorFolderSelect.value = note.folder_id == null ? 'unfiled' : String(note.folder_id);
    }
  } catch (e) {
    appendOrganizeBubble('assistant', e.message || String(e), true);
  }
}

document.addEventListener('keydown', (event) => {
  if (!isTypingTarget(event.target) && isUndoShortcut(event)) {
    event.preventDefault();
    void undoLinkChange();
    return;
  }

  if (!isTypingTarget(event.target) && isRedoShortcut(event)) {
    event.preventDefault();
    void redoLinkChange();
    return;
  }

  // Arrow key navigation through note list (prevent default scrolling).
  if (!isTypingTarget(event.target) && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Let the dedicated `#results` keyboard handler run when we're already interacting with a row.
    if (event.target?.closest?.('#results')) return;
    if (state.notes.length > 0) {
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        if (state.listFocusId == null) state.listFocusId = state.notes[0].id;
        else {
          const i = state.notes.findIndex((n) => n.id === state.listFocusId);
          if (i >= 0 && i < state.notes.length - 1) state.listFocusId = state.notes[i + 1].id;
        }
        renderResults();
        focusListRow(state.listFocusId);
      } else if (event.key === 'ArrowUp') {
        if (state.listFocusId == null) return;
        const i = state.notes.findIndex((n) => n.id === state.listFocusId);
        if (i <= 0) {
          state.listFocusId = null;
          renderResults();
          queryInput.focus();
        } else {
          state.listFocusId = state.notes[i - 1].id;
          renderResults();
          focusListRow(state.listFocusId);
        }
      }
      return;
    }
  }

  if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    window.mvp.openCapture();
    return;
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && state.listFocusId != null) {
    if (event.target === editorTextEl || event.target === queryInput) return;
    if (event.target === appSelect) return;
    if (event.target.closest?.('#links')) return;
    if (event.target.closest?.('.editor-actions')) return;
    if (event.target.closest?.('.bulk-actions')) return;
    if (event.target.closest?.('.result-select')) return;
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    void removeNoteById(state.listFocusId);
    return;
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedIds.size > 1) {
    if (event.target === editorTextEl || event.target === queryInput) return;
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    event.preventDefault();
    void removeSelectedNotes();
    return;
  }

  if (event.key === 'Escape') {
    if (apiKeyModal && !apiKeyModal.classList.contains('hidden')) {
      event.preventDefault();
      hideApiKeyModal();
      return;
    }
    event.preventDefault();
    window.mvp.hideSearch();
  }
});

setApiKeyBtn?.addEventListener('click', () => {
  showApiKeyModal();
});

aiKeyAccessBtn?.addEventListener('click', () => {
  showApiKeyModal();
});

apiKeyCancelBtn?.addEventListener('click', () => {
  hideApiKeyModal();
});

apiKeySaveBtn?.addEventListener('click', () => {
  void saveApiKeyFromModal();
});

apiKeyInput?.addEventListener('keydown', (event) => {
  const isPasteShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';
  if (isPasteShortcut) {
    event.preventDefault();
    void (async () => {
      const clip = await window.mvp.readClipboardText();
      if (!clip) return;
      apiKeyInput.value = String(clip);
    })();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    void saveApiKeyFromModal();
  }
});

apiKeyModal?.addEventListener('click', (event) => {
  if (event.target === apiKeyModal) hideApiKeyModal();
});

anthropicKeyLink?.addEventListener('click', (event) => {
  event.preventDefault();
  void window.mvp.openExternalUrl('https://console.anthropic.com/settings/keys');
});

window.mvp.onSearchFocus(async (payload) => {
  await runQuery(queryInput.value.trim());
  queryInput.focus();
  queryInput.select();
  if (payload && payload.openNoteId) await openNote(Number(payload.openNoteId));
});

window.mvp.onNotesChanged(() => {
  void loadFolders();
  void runQuery(queryInput.value.trim());
  if (state.activeId != null) {
    void renderLinks();
    void renderNoteImages();
  }
});

window.mvp.onOpenAiKeyModal(() => {
  showApiKeyModal();
});

async function init() {
  await loadApps();
  await loadFolders();
  await runQuery('');
  await refreshAiKeyStatus();
}

init().catch((error) => {
  resultsEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(error.message || String(error))}</div>`;
});
