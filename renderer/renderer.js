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
  /** True when the search box is empty and we are rendering the default recent list. */
  isDefaultList: true,
};

const queryInput = document.getElementById('query');
const cleanupNotesBtn = document.getElementById('cleanup-notes-btn');
const cleanupStatusEl = document.getElementById('cleanup-status');
const importDbBtn = document.getElementById('import-db-btn');
const exportDbBtn = document.getElementById('export-db-btn');
const aiKeyAccessStatusEl = document.getElementById('ai-key-access-status');
const aiKeyAccessBtn = document.getElementById('ai-key-access-btn');
const folderDiagramEl = document.getElementById('folder-diagram');
const folderDiagramTreeEl = document.getElementById('folder-diagram-tree');
const newFolderBtn = document.getElementById('new-folder-btn');
const newFolderModal = document.getElementById('new-folder-modal');
const newFolderNameInput = document.getElementById('new-folder-name-input');
const newFolderErrorEl = document.getElementById('new-folder-error');
const newFolderCancelBtn = document.getElementById('new-folder-cancel');
const newFolderCreateBtn = document.getElementById('new-folder-create');
const newFolderModalTitleEl = document.getElementById('new-folder-modal-title');
const newFolderModalHintEl = document.getElementById('new-folder-modal-hint');

const FOLDER_DIALOG_HINT_CREATE =
  'Choose a short name. You can move notes into this folder from the note editor.';
const FOLDER_DIALOG_HINT_EDITOR_CREATE =
  'Name the folder. This note will be moved into it when you create it.';
const EDITOR_NEW_FOLDER_VALUE = '__new_folder__';
const FOLDER_DIALOG_HINT_RENAME =
  'Notes stay in this folder. Only the label in the diagram and editor changes.';
const FOLDER_DIALOG_HINT_GROUP =
  'Both notes will move into this folder. You can rename it anytime from the folder tree.';

/** When non-null, the folder name dialog is renaming this folder id instead of creating. */
let folderNameDialogRenameTargetId = null;
/** When non-null, create dialog groups these note ids into a new folder on submit. */
let folderNameDialogGroupNoteIds = null;
/** When true, plain create moves the open note into the new folder. */
let folderNameDialogAssignActiveNote = false;
/** Note id being dragged in the results list (for drop onto another note). */
let dragNoteId = null;
/** Suppress row click right after a drag so dropping does not open a note. */
let suppressNoteRowClick = false;
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
const editorNewFolderBtn = document.getElementById('editor-new-folder-btn');
const appSelect = document.getElementById('app-select');
const linkBtn = document.getElementById('link-btn');
const linksEl = document.getElementById('links');
const noteImagesEl = document.getElementById('note-images');
const noteFilesEl = document.getElementById('note-files');
const imageLightboxEl = document.getElementById('image-lightbox');
const imageLightboxImg = document.getElementById('image-lightbox-img');
const imageLightboxCloseBtn = document.querySelector('.image-lightbox-close');

let imageLightboxKeydownHandler = null;
const apiKeyModal = document.getElementById('api-key-modal');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyErrorEl = document.getElementById('api-key-error');
const apiKeySaveBtn = document.getElementById('api-key-save');
const apiKeyCancelBtn = document.getElementById('api-key-cancel');
const anthropicKeyLink = document.getElementById('anthropic-key-link');

let saveTimer = null;
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
  editorEl.closest('.search-shell')?.classList.remove('editor-open');
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

function getFolderNavButtons() {
  if (!folderDiagramTreeEl) return [];
  return [...folderDiagramTreeEl.querySelectorAll('.folder-node[data-folder-filter]')];
}

function focusFolderNavButton(filterValue) {
  const want = String(filterValue ?? 'all');
  requestAnimationFrame(() => {
    const nodes = getFolderNavButtons();
    if (!nodes.length) return;
    const hit = nodes.find((el) => String(el.dataset.folderFilter || 'all') === want) ?? nodes[0];
    hit.focus();
  });
}

async function applyFolderFilterFromNav(newFilter) {
  state.folderFilter = newFilter;
  await runQuery(queryInput.value.trim());
  focusFolderNavButton(state.folderFilter);
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
  const currentValue = editorFolderSelect?.value || 'unfiled';
  const editorOptions = ['<option value="unfiled">Unfiled</option>'];
  for (const folder of state.folders) {
    const safeName = escapeHtml(folder.name);
    editorOptions.push(`<option value="${folder.id}">${safeName}</option>`);
  }
  editorOptions.push(
    `<option value="${EDITOR_NEW_FOLDER_VALUE}">+ New folder…</option>`
  );
  editorFolderSelect.innerHTML = editorOptions.join('');
  if (currentValue === EDITOR_NEW_FOLDER_VALUE) return;
  const hasOption = [...editorFolderSelect.options].some((o) => o.value === currentValue);
  if (hasOption) editorFolderSelect.value = currentValue;
}

function editorFolderValueForNote(note) {
  return note && note.folder_id != null ? String(note.folder_id) : 'unfiled';
}

function restoreEditorFolderSelectFromActiveNote() {
  if (!state.activeId) {
    editorFolderSelect.value = 'unfiled';
    return;
  }
  const note = state.notes.find((n) => n.id === state.activeId);
  editorFolderSelect.value = editorFolderValueForNote(note);
}

function showNewFolderModalFromEditor() {
  if (!state.activeId) return;
  showNewFolderModal({ assignActiveNote: true });
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
      const deleteTitle = escapeAttr(`Delete folder “${folder.name}”. Notes become Unfiled.`);
      const renameTitle = escapeAttr(`Rename folder “${folder.name}”`);
      items.push(`
        <div class="folder-diagram-row">
          <button type="button" class="folder-node${active}" data-folder-filter="${folder.id}">
            <span class="folder-node-prefix">${branch}</span>
            <span class="folder-node-name">${escapeHtml(folder.name)}</span>
            <span class="folder-node-count">(${count})</span>
          </button>
          <button type="button" class="folder-rename-btn" data-folder-rename="${folder.id}" title="${renameTitle}" aria-label="Rename folder">✎</button>
          <button type="button" class="folder-delete-btn" data-folder-delete="${folder.id}" title="${deleteTitle}" aria-label="Delete folder">×</button>
        </div>
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
  if (!folderDiagramTreeEl || !folderDiagramEl) return;
  try {
    const diagram = await window.mvp.getFolderDiagram();
    folderDiagramTreeEl.innerHTML = renderFolderDiagramHtml(diagram);
    folderDiagramEl.classList.remove('hidden');
  } catch (error) {
    folderDiagramTreeEl.innerHTML = `Unable to load (${escapeHtml(error.message || String(error))})`;
    folderDiagramEl.classList.remove('hidden');
  }
}

async function deleteFolderFromUi(folderId) {
  const id = Number(folderId);
  if (!Number.isFinite(id) || id < 1) return;
  const folder = state.folders.find((f) => Number(f.id) === id);
  const label = folder ? folder.name : 'this folder';
  if (!confirm(`Delete folder “${label}”? Notes inside will move to Unfiled.`)) return;
  const ok = await window.mvp.deleteFolder(id);
  if (!ok) return;
  if (String(state.folderFilter) === String(id)) {
    state.folderFilter = 'all';
  }
  await loadFolders();
  if (state.activeId) {
    const note = await window.mvp.getNote(state.activeId);
    if (note) {
      editorFolderSelect.value = note.folder_id == null ? 'unfiled' : String(note.folder_id);
    }
  }
  await runQuery(queryInput.value.trim());
}

folderDiagramEl?.addEventListener('click', (event) => {
  const renameBtn = event.target.closest('[data-folder-rename]');
  if (renameBtn) {
    event.preventDefault();
    event.stopPropagation();
    const rawId = renameBtn.getAttribute('data-folder-rename');
    showRenameFolderModal(rawId);
    return;
  }
  const delBtn = event.target.closest('[data-folder-delete]');
  if (delBtn) {
    event.preventDefault();
    event.stopPropagation();
    const rawId = delBtn.getAttribute('data-folder-delete');
    void deleteFolderFromUi(rawId);
    return;
  }
  const btn = event.target.closest('.folder-node[data-folder-filter]');
  if (!btn) return;
  state.folderFilter = btn.dataset.folderFilter || 'all';
  void runQuery(queryInput.value.trim());
});

folderDiagramTreeEl?.addEventListener(
  'keydown',
  (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const btn = event.target?.closest?.('.folder-node[data-folder-filter]');
    if (!btn || !folderDiagramTreeEl.contains(btn)) return;
    const nodes = getFolderNavButtons();
    const i = nodes.indexOf(btn);
    if (i < 0) return;
    const j = event.key === 'ArrowDown' ? i + 1 : i - 1;
    if (j < 0 || j >= nodes.length) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowUp' && i === 0) queryInput.focus();
      else if (event.key === 'ArrowDown' && i === nodes.length - 1 && state.notes.length > 0) {
        state.listFocusId = state.notes[0].id;
        renderResults();
        focusListRow(state.listFocusId);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextFilter = nodes[j].dataset.folderFilter || 'all';
    void applyFolderFilterFromNav(nextFilter);
  },
  true
);

function noteSnippetForFolderName(text) {
  const line = String(text || '')
    .split('\n')[0]
    .trim()
    .replace(/\s+/g, ' ');
  if (!line || line === '(attachment)') return '';
  return line.slice(0, 36);
}

function suggestFolderNameFromNotes(noteA, noteB) {
  const a = noteSnippetForFolderName(noteA.text);
  const b = noteSnippetForFolderName(noteB.text);
  if (a && b) return a === b ? a : `${a} & ${b}`.slice(0, 80);
  if (a) return a;
  if (b) return b;
  return 'New folder';
}

function showNewFolderModal(opts = {}) {
  if (!newFolderModal || !newFolderNameInput) return;
  folderNameDialogRenameTargetId = null;
  folderNameDialogGroupNoteIds = null;
  folderNameDialogAssignActiveNote = Boolean(opts.assignActiveNote);
  if (newFolderModalTitleEl) newFolderModalTitleEl.textContent = 'New folder';
  if (newFolderModalHintEl) {
    newFolderModalHintEl.textContent = folderNameDialogAssignActiveNote
      ? FOLDER_DIALOG_HINT_EDITOR_CREATE
      : FOLDER_DIALOG_HINT_CREATE;
  }
  if (newFolderCreateBtn) newFolderCreateBtn.textContent = 'Create';
  newFolderNameInput.placeholder = 'e.g. Work';
  newFolderErrorEl?.classList.add('hidden');
  if (newFolderErrorEl) newFolderErrorEl.textContent = '';
  newFolderNameInput.value = '';
  newFolderModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    newFolderNameInput.focus();
    newFolderNameInput.select();
  });
}

function showGroupNotesFolderModal(sourceId, targetId) {
  if (!newFolderModal || !newFolderNameInput) return;
  const source = state.notes.find((n) => n.id === sourceId);
  const target = state.notes.find((n) => n.id === targetId);
  if (!source || !target) return;
  if (
    source.folder_id != null &&
    source.folder_id === target.folder_id
  ) {
    return;
  }
  folderNameDialogRenameTargetId = null;
  folderNameDialogAssignActiveNote = false;
  folderNameDialogGroupNoteIds = [sourceId, targetId];
  if (newFolderModalTitleEl) newFolderModalTitleEl.textContent = 'Folder from notes';
  if (newFolderModalHintEl) newFolderModalHintEl.textContent = FOLDER_DIALOG_HINT_GROUP;
  if (newFolderCreateBtn) newFolderCreateBtn.textContent = 'Create';
  newFolderNameInput.placeholder = 'e.g. App ideas';
  newFolderErrorEl?.classList.add('hidden');
  if (newFolderErrorEl) newFolderErrorEl.textContent = '';
  newFolderNameInput.value = suggestFolderNameFromNotes(source, target);
  newFolderModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    newFolderNameInput.focus();
    newFolderNameInput.select();
  });
}

function showRenameFolderModal(folderIdRaw) {
  if (!newFolderModal || !newFolderNameInput) return;
  const id = Number(folderIdRaw);
  if (!Number.isFinite(id) || id < 1) return;
  const folder = state.folders.find((f) => Number(f.id) === id);
  if (!folder) return;
  folderNameDialogRenameTargetId = id;
  folderNameDialogGroupNoteIds = null;
  folderNameDialogAssignActiveNote = false;
  if (newFolderModalTitleEl) newFolderModalTitleEl.textContent = 'Rename folder';
  if (newFolderModalHintEl) newFolderModalHintEl.textContent = FOLDER_DIALOG_HINT_RENAME;
  if (newFolderCreateBtn) newFolderCreateBtn.textContent = 'Save';
  newFolderNameInput.placeholder = '';
  newFolderErrorEl?.classList.add('hidden');
  if (newFolderErrorEl) newFolderErrorEl.textContent = '';
  newFolderNameInput.value = folder.name;
  newFolderModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    newFolderNameInput.focus();
    newFolderNameInput.select();
  });
}

function hideNewFolderModal() {
  folderNameDialogRenameTargetId = null;
  folderNameDialogGroupNoteIds = null;
  folderNameDialogAssignActiveNote = false;
  newFolderModal?.classList.add('hidden');
}

async function submitFolderNameDialog() {
  if (!newFolderNameInput) return;
  const trimmed = newFolderNameInput.value.trim();
  if (!trimmed) {
    if (newFolderErrorEl) {
      newFolderErrorEl.textContent = 'Enter a folder name.';
      newFolderErrorEl.classList.remove('hidden');
    }
    return;
  }
  if (newFolderCreateBtn) newFolderCreateBtn.disabled = true;
  const isRename = folderNameDialogRenameTargetId != null;
  const groupNoteIds = folderNameDialogGroupNoteIds;
  try {
    if (isRename) {
      const folder = await window.mvp.renameFolder(folderNameDialogRenameTargetId, trimmed);
      if (!folder) {
        if (newFolderErrorEl) {
          newFolderErrorEl.textContent = 'Could not rename that folder.';
          newFolderErrorEl.classList.remove('hidden');
        }
        return;
      }
    } else if (groupNoteIds) {
      const result = await window.mvp.groupNotesIntoFolder(groupNoteIds, trimmed);
      if (!result || !result.folder) {
        const duplicate = state.folders.some((f) => f.name === trimmed);
        if (newFolderErrorEl) {
          newFolderErrorEl.textContent = duplicate
            ? 'A folder with that name already exists.'
            : 'Could not create that folder.';
          newFolderErrorEl.classList.remove('hidden');
        }
        return;
      }
      state.folderFilter = String(result.folder.id);
    } else {
      const folder = await window.mvp.createFolder(trimmed);
      if (!folder) {
        if (newFolderErrorEl) {
          newFolderErrorEl.textContent = 'Could not create that folder.';
          newFolderErrorEl.classList.remove('hidden');
        }
        return;
      }
      if (folderNameDialogAssignActiveNote && state.activeId) {
        const updated = await window.mvp.setNoteFolder(state.activeId, String(folder.id));
        if (!updated) {
          if (newFolderErrorEl) {
            newFolderErrorEl.textContent = 'Folder created but could not move this note.';
            newFolderErrorEl.classList.remove('hidden');
          }
          await loadFolders();
          return;
        }
      }
    }
    hideNewFolderModal();
    await loadFolders();
    if (state.activeId) {
      const note = await window.mvp.getNote(state.activeId);
      if (note) {
        editorFolderSelect.value = editorFolderValueForNote(note);
      }
    }
    await runQuery(queryInput.value.trim());
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const duplicate = /unique|constraint|SQLITE_CONSTRAINT/i.test(msg);
    if (newFolderErrorEl) {
      newFolderErrorEl.textContent = duplicate
        ? 'A folder with that name already exists.'
        : isRename
          ? 'Could not rename folder.'
          : 'Could not create folder.';
      newFolderErrorEl.classList.remove('hidden');
    }
  } finally {
    if (newFolderCreateBtn) newFolderCreateBtn.disabled = false;
  }
}

newFolderBtn?.addEventListener('click', () => {
  showNewFolderModal();
});

newFolderCancelBtn?.addEventListener('click', () => {
  hideNewFolderModal();
});

newFolderCreateBtn?.addEventListener('click', () => {
  void submitFolderNameDialog();
});

newFolderNameInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void submitFolderNameDialog();
  }
});

newFolderModal?.addEventListener('click', (event) => {
  if (event.target === newFolderModal) hideNewFolderModal();
});

async function runQuery(text) {
  state.isDefaultList = !text;
  state.notes = text
    ? await window.mvp.queryNotes(text, state.folderFilter)
    : await window.mvp.recentNotes(state.folderFilter);
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
      return `<div class="result-row${active}${listFocus}" data-id="${note.id}" draggable="true" title="Drag onto another note to group into a folder">
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

async function startComposeNote() {
  const note = await window.mvp.createNote('');
  if (!note?.id) return;
  await runQuery(queryInput.value.trim());
  await openNote(note.id);
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
  editorEl.closest('.search-shell')?.classList.add('editor-open');
  renderResults();
  await renderLinks();
  await renderNoteImages();
  await renderNoteFiles();
  requestAnimationFrame(() => {
    editorTextEl.focus();
    editorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
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
      const src = image.asset_url || image.data_url || image.file_url || '';
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

let cleanupStatusTimer = null;

function showCleanupStatus(text) {
  if (!cleanupStatusEl) return;
  cleanupStatusEl.textContent = text;
  cleanupStatusEl.classList.remove('cleanup-status--hidden');
  clearTimeout(cleanupStatusTimer);
  cleanupStatusTimer = setTimeout(() => {
    cleanupStatusEl.classList.add('cleanup-status--hidden');
    cleanupStatusEl.textContent = '';
  }, 16000);
}

cleanupNotesBtn?.addEventListener('click', async () => {
  const ok = confirm(
    'Run Clean DB?\n\n• Removes duplicate saves (same text and timestamp).\n• Merges notes whose text only differs by spacing or capital letters.\n• If an Anthropic API key is set, AI may merge overlapping ideas and tidy folders.',
  );
  if (!ok) return;
  cleanupNotesBtn.disabled = true;
  showCleanupStatus('Running Clean DB…');
  try {
    const res = await window.mvp.runNotesCleanup({ useAi: true });
    if (res.error) {
      showCleanupStatus(`Clean DB failed: ${res.error}`);
      return;
    }
    showCleanupStatus(res.summary || 'Clean DB finished.');
    if (state.activeId) {
      const note = await window.mvp.getNote(state.activeId);
      if (!note) closeEditor();
    }
    await runQuery(queryInput.value.trim());
  } catch (e) {
    showCleanupStatus(`Clean DB failed: ${e.message || String(e)}`);
  } finally {
    cleanupNotesBtn.disabled = false;
  }
});

queryInput.addEventListener('input', () => {
  runQuery(queryInput.value.trim());
});

importDbBtn?.addEventListener('click', async () => {
  await window.mvp.importDbFromPicker();
});

exportDbBtn?.addEventListener('click', async () => {
  await window.mvp.exportDbFromPicker();
});

queryInput.addEventListener('keydown', (event) => {
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
      const folderNodes = getFolderNavButtons();
      if (folderNodes.length) focusFolderNavButton(state.folderFilter);
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

function clearNoteDragUi() {
  dragNoteId = null;
  resultsEl.querySelectorAll('.result-row.dragging, .result-row.drop-target').forEach((el) => {
    el.classList.remove('dragging', 'drop-target');
  });
}

resultsEl.addEventListener('dragstart', (event) => {
  if (event.target.closest('.result-select, .result-delete')) {
    event.preventDefault();
    return;
  }
  const row = event.target.closest('.result-row');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (!Number.isFinite(id)) return;
  dragNoteId = id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));
  row.classList.add('dragging');
});

resultsEl.addEventListener('dragend', () => {
  clearNoteDragUi();
  suppressNoteRowClick = true;
  requestAnimationFrame(() => {
    suppressNoteRowClick = false;
  });
});

resultsEl.addEventListener('dragover', (event) => {
  const row = event.target.closest('.result-row');
  if (!row || dragNoteId == null) return;
  const targetId = Number(row.dataset.id);
  if (targetId === dragNoteId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  resultsEl.querySelectorAll('.result-row.drop-target').forEach((el) => {
    if (el !== row) el.classList.remove('drop-target');
  });
  row.classList.add('drop-target');
});

resultsEl.addEventListener('dragleave', (event) => {
  const row = event.target.closest('.result-row');
  if (!row) return;
  const related = event.relatedTarget;
  if (related && row.contains(related)) return;
  row.classList.remove('drop-target');
});

resultsEl.addEventListener('drop', (event) => {
  event.preventDefault();
  const row = event.target.closest('.result-row');
  if (!row || dragNoteId == null) return;
  const targetId = Number(row.dataset.id);
  row.classList.remove('drop-target');
  const sourceId = dragNoteId;
  clearNoteDragUi();
  if (targetId === sourceId) return;
  showGroupNotesFolderModal(sourceId, targetId);
});

resultsEl.addEventListener('click', (event) => {
  if (suppressNoteRowClick) return;
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
        const folderNodes = getFolderNavButtons();
        if (folderNodes.length) focusFolderNavButton(state.folderFilter);
        else queryInput.focus();
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
    event.stopPropagation();
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
  if (nextFolder === EDITOR_NEW_FOLDER_VALUE) {
    restoreEditorFolderSelectFromActiveNote();
    showNewFolderModalFromEditor();
    return;
  }
  const updated = await window.mvp.setNoteFolder(state.activeId, nextFolder);
  if (!updated) {
    restoreEditorFolderSelectFromActiveNote();
    return;
  }
  await runQuery(queryInput.value.trim());
});

editorNewFolderBtn?.addEventListener('click', () => {
  showNewFolderModalFromEditor();
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

async function refreshAiKeyStatus() {
  let line = 'API status unavailable';
  try {
    const status = await window.mvp.getAiKeyStatus();
    const hasKey = status && status.hasKey;
    line = hasKey ? 'Anthropic API key is saved on this Mac.' : 'No Anthropic API key yet — set one to enable AI auto-filing.';
  } catch (_error) {
    // leave line as 'API status unavailable'
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
    // Folder tree uses its own capture handler; if focus is on a folder nav button, do not move the note list.
    if (event.target?.closest?.('#folder-diagram-tree .folder-node[data-folder-filter]')) return;
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
          const folderNodes = getFolderNavButtons();
          if (folderNodes.length) focusFolderNavButton(state.folderFilter);
          else queryInput.focus();
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
    void startComposeNote();
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
    if (newFolderModal && !newFolderModal.classList.contains('hidden')) {
      event.preventDefault();
      hideNewFolderModal();
      return;
    }
    if (apiKeyModal && !apiKeyModal.classList.contains('hidden')) {
      event.preventDefault();
      hideApiKeyModal();
      return;
    }
    if (imageLightboxEl && !imageLightboxEl.classList.contains('hidden')) {
      event.preventDefault();
      closeImageLightbox();
      return;
    }
    if (state.activeId != null && editorEl && !editorEl.classList.contains('hidden')) {
      event.preventDefault();
      closeEditor();
      return;
    }
    event.preventDefault();
    window.mvp.hideSearch();
    return;
  }
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
  if (payload && payload.compose) {
    await startComposeNote();
    return;
  }
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
