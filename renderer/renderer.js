'use strict';

// ── Known apps for the link modal ─────────────────────────────────────────────
const KNOWN_APPS = [
  { name: 'Messages',        bundleId: 'com.apple.MobileSMS' },
  { name: 'WhatsApp',        bundleId: 'net.whatsapp.WhatsApp' },
  { name: 'Telegram',        bundleId: 'ru.keepcoder.Telegram' },
  { name: 'Slack',           bundleId: 'com.tinyspeck.slackmacgap' },
  { name: 'Zoom',            bundleId: 'us.zoom.xos' },
  { name: 'Mail',            bundleId: 'com.apple.mail' },
  { name: 'FaceTime',        bundleId: 'com.apple.FaceTime' },
  { name: 'Discord',         bundleId: 'com.hnc.Discord' },
  { name: 'Messenger',       bundleId: 'com.facebook.Messenger' },
  { name: 'Microsoft Teams', bundleId: 'com.microsoft.teams2' },
  { name: 'Signal',          bundleId: 'org.whispersystems.signal-desktop' },
  { name: 'Safari',          bundleId: 'com.apple.Safari' },
  { name: 'Google Chrome',   bundleId: 'com.google.Chrome' },
];

const BUNDLE_NAMES = Object.fromEntries(KNOWN_APPS.map(a => [a.bundleId, a.name]));
function displayName(bid) { return BUNDLE_NAMES[bid] || bid; }

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  folders:           [],
  notes:             [],
  activeFolder:      'all',   // 'all' | 'unfiled' | 'trash' | <id>
  activeNote:        null,    // note object
  highlightedNoteId: null,    // list selection after closing editor (for Delete key)
  linkedApps:        [],
  searchQuery:       '',
  aiMessages:        [],
  aiLoading:         false,
  saveTimer:         null,
  config:            {},
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Sidebar
const folderList        = $('folder-list');
const notesPanelTitle   = $('notes-panel-title');
const notesList         = $('notes-list');
const notesEmpty        = $('notes-empty');
const searchInput       = $('search-input');

// Editor
const editorPlaceholder = $('editor-placeholder');
const editorContent     = $('editor-content');
const noteTitleInput    = $('note-title-input');
const noteContentInput  = $('note-content-input');
const noteStatus        = $('note-status');
const appLinksBody      = $('app-links-body');

// AI
const aiPanel           = $('ai-panel');
const aiMessages        = $('ai-messages');
const aiInput           = $('ai-input');
const aiSendBtn         = $('ai-send-btn');

// Modals
const settingsOverlay   = $('settings-overlay');
const addLinkModal      = $('add-link-modal');
const newFolderModal    = $('new-folder-modal');

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  state.config = await window.api.getConfig();
  await loadFolders();
  await loadNotes();
  bindEvents();
  applyConfig();
  showAiPanel({ focusInput: false });
}

function applyConfig() {
  $('surfacing-toggle').checked = state.config.surfacingEnabled !== false;
  $('cooldown-input').value     = state.config.surfaceCooldownMinutes || 30;
  $('model-input').value        = state.config.model || 'claude-sonnet-4-6';
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadFolders() {
  state.folders = await window.api.getFolders();
  renderFolderList();
}

async function loadNotes(query) {
  if (query !== undefined) state.searchQuery = query;

  if (state.searchQuery) {
    state.notes = await window.api.searchNotes(state.searchQuery);
    notesPanelTitle.textContent = `Search: "${state.searchQuery}"`;
  } else {
    state.notes = await window.api.getNotes(state.activeFolder);
    notesPanelTitle.textContent = folderTitle(state.activeFolder);
  }

  renderNoteList();
}

function folderTitle(f) {
  if (f === 'all')     return 'All Notes';
  if (f === 'unfiled') return 'Unfiled';
  if (f === 'trash')   return 'Recently deleted';
  const folder = state.folders.find(x => x.id === f);
  return folder ? folder.name : 'Notes';
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderFolderList() {
  folderList.innerHTML = '';
  for (const folder of state.folders) {
    const el = document.createElement('div');
    el.className = 'folder-item' + (state.activeFolder === folder.id ? ' active' : '');
    el.dataset.folder = folder.id;
    el.innerHTML = `
      <span class="folder-icon">📁</span>
      <span class="folder-name">${esc(folder.name)}</span>
      <button class="folder-delete" data-folder-id="${folder.id}" title="Delete folder">✕</button>
    `;
    folderList.appendChild(el);
  }
}

function renderNoteList() {
  const container = notesList;

  // Remove old note items
  [...container.querySelectorAll('.note-item')].forEach(el => el.remove());
  notesEmpty.style.display = state.notes.length === 0 ? '' : 'none';

  const focusId = state.activeNote?.id ?? state.highlightedNoteId;
  for (const note of state.notes) {
    const el = document.createElement('div');
    el.className = 'note-item' + (focusId === note.id ? ' active' : '');
    el.dataset.noteId = note.id;
    const snip = (note.content || '').slice(0, 80).replace(/\n/g, ' ');
    const date  = formatDate(note.updated_at);
    el.innerHTML = `
      <div class="note-title">${esc(note.title || 'Untitled')}</div>
      <div class="note-snippet">${esc(snip) || '<em>No content</em>'}</div>
      <div class="note-meta">
        <span>${date}</span>
      </div>
    `;
    container.appendChild(el);
  }
}

function renderAppLinks() {
  appLinksBody.innerHTML = '';
  for (const bid of state.linkedApps) {
    const chip = document.createElement('div');
    chip.className = 'app-chip';
    chip.innerHTML = `<span>${esc(displayName(bid))}</span><button class="chip-remove" data-bundle="${bid}" title="Remove">×</button>`;
    appLinksBody.appendChild(chip);
  }
}

function renderAiMessages() {
  aiMessages.innerHTML = '';
  for (const msg of state.aiMessages) {
    appendAiMsg(msg.role, msg.content);
  }
  if (state.aiMessages.length === 0) {
    appendAiMsg(
      'assistant',
      'Hi! I can help you search, organize, and manage your notes. What would you like to do?\n\nType /help for keyboard shortcuts.'
    );
  }
}

function appendAiMsg(role, content) {
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  div.textContent = content;
  aiMessages.appendChild(div);
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

// ── Note CRUD ─────────────────────────────────────────────────────────────────
async function selectNote(id) {
  const note = await window.api.getNote(id);
  if (!note) return;
  state.activeNote        = note;
  state.highlightedNoteId = id;
  state.linkedApps        = note.linked_bundle_ids || [];

  document.querySelectorAll('.note-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.noteId) === id);
  });

  editorPlaceholder.style.display = 'none';
  editorContent.style.display     = 'flex';
  editorContent.style.flexDirection = 'column';

  noteTitleInput.value   = note.title   || '';
  noteContentInput.value = note.content || '';
  noteStatus.textContent = `Saved ${formatDate(note.updated_at)}`;

  renderAppLinks();
  updateTrashEditorUi();
}

async function createNote() {
  const folderForNew =
    state.activeFolder === 'all' || state.activeFolder === 'unfiled' || state.activeFolder === 'trash'
      ? null
      : state.activeFolder;
  const note = await window.api.createNote({
    title:    'New Note',
    content:  '',
    folderId: folderForNew,
  });
  await loadNotes();
  selectNote(note.id);
}

function updateTrashEditorUi() {
  const banner   = $('editor-trash-banner');
  const appPanel = $('app-links-panel');
  const delBtn   = $('delete-note-btn');
  const trashed  = !!(state.activeNote && state.activeNote.deleted_at);
  if (trashed) {
    banner.classList.remove('hidden');
    appPanel.style.display = 'none';
    delBtn.title = 'Delete forever…';
  } else {
    banner.classList.add('hidden');
    appPanel.style.display = '';
    delBtn.title = 'Move to Recently deleted';
  }
}

async function saveAndExitNote() {
  if (!state.activeNote) return;
  const id = state.activeNote.id;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await saveActiveNote();
  state.activeNote = null;
  state.linkedApps = [];
  state.highlightedNoteId = id;
  editorPlaceholder.style.display = '';
  editorContent.style.display     = 'none';
  document.querySelectorAll('.note-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.noteId) === id);
  });
  await loadNotes();
}

/** After removing `removedId` from `notesBefore`, which note should be selected (next row, else previous). */
function neighborNoteIdAfterRemoval(notesBefore, removedId) {
  const idx = notesBefore.findIndex(n => n.id === removedId);
  if (idx < 0) return null;
  if (idx < notesBefore.length - 1) return notesBefore[idx + 1].id;
  if (idx > 0) return notesBefore[idx - 1].id;
  return null;
}

async function focusNoteAfterListChange(nextId) {
  if (nextId != null && state.notes.some(n => n.id === nextId)) {
    await selectNote(nextId);
    return;
  }
  state.highlightedNoteId = null;
  document.querySelectorAll('.note-item').forEach(el => el.classList.remove('active'));
}

async function trashNoteById(id) {
  const snap   = [...state.notes];
  const nextId = neighborNoteIdAfterRemoval(snap, id);

  await window.api.deleteNote(id);
  if (state.activeNote?.id === id) {
    state.activeNote = null;
    state.linkedApps = [];
    editorPlaceholder.style.display = '';
    editorContent.style.display     = 'none';
    $('editor-trash-banner').classList.add('hidden');
    $('app-links-panel').style.display = '';
  }
  if (state.highlightedNoteId === id) state.highlightedNoteId = null;
  await loadNotes();
  await focusNoteAfterListChange(nextId);
}

async function deleteActiveNote() {
  if (!state.activeNote) return;
  if (state.activeNote.deleted_at) {
    if (!confirm(`Permanently delete "${state.activeNote.title || 'Untitled'}"? This cannot be undone.`)) return;
    const snap   = [...state.notes];
    const rid    = state.activeNote.id;
    const nextId = neighborNoteIdAfterRemoval(snap, rid);
    await window.api.permanentDeleteNote(rid);
    state.activeNote = null;
    state.linkedApps = [];
    if (state.highlightedNoteId === rid) state.highlightedNoteId = null;
    editorPlaceholder.style.display = '';
    editorContent.style.display     = 'none';
    $('editor-trash-banner').classList.add('hidden');
    $('app-links-panel').style.display = '';
    await loadNotes();
    await focusNoteAfterListChange(nextId);
    return;
  }
  if (!confirm(`Move "${state.activeNote.title || 'Untitled'}" to Recently deleted?`)) return;
  await trashNoteById(state.activeNote.id);
}

async function restoreActiveNote() {
  if (!state.activeNote?.deleted_at) return;
  const id = state.activeNote.id;
  await window.api.restoreNote(id);
  await switchFolder('all');
  const refreshed = await window.api.getNote(id);
  if (refreshed) await selectNote(id);
}

async function eraseActiveNoteForever() {
  if (!state.activeNote?.deleted_at) return;
  if (!confirm(`Permanently delete "${state.activeNote.title || 'Untitled'}"? This cannot be undone.`)) return;
  const snap   = [...state.notes];
  const rid    = state.activeNote.id;
  const nextId = neighborNoteIdAfterRemoval(snap, rid);
  await window.api.permanentDeleteNote(rid);
  state.activeNote = null;
  state.linkedApps = [];
  if (state.highlightedNoteId === rid) state.highlightedNoteId = null;
  editorPlaceholder.style.display = '';
  editorContent.style.display     = 'none';
  $('editor-trash-banner').classList.add('hidden');
  $('app-links-panel').style.display = '';
  await loadNotes();
  await focusNoteAfterListChange(nextId);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveActiveNote, 800);
}

async function saveActiveNote() {
  if (!state.activeNote) return;
  const title   = noteTitleInput.value;
  const content = noteContentInput.value;
  const updated = await window.api.updateNote(state.activeNote.id, { title, content });
  if (updated) {
    state.activeNote = { ...state.activeNote, ...updated };
    noteStatus.textContent = `Saved ${formatDate(updated.updated_at)}`;
    // Update list item in-place
    const listEl = document.querySelector(`.note-item[data-note-id="${updated.id}"]`);
    if (listEl) {
      listEl.querySelector('.note-title').textContent = title || 'Untitled';
      listEl.querySelector('.note-snippet').textContent = (content || '').slice(0, 80).replace(/\n/g, ' ');
      listEl.querySelector('.note-meta span').textContent = formatDate(updated.updated_at);
    }
  }
}

/** True when ↑/↓ should move the notes list selection (not e.g. caret in a textarea). */
function shouldUseArrowNoteNav(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target;
  if (t === noteContentInput) return false;
  if (t === searchInput) return false;
  if (t === aiInput) return false;
  if (!addLinkModal.classList.contains('hidden')) return false;
  if (!newFolderModal.classList.contains('hidden')) return false;
  if (!settingsOverlay.classList.contains('hidden')) return false;
  return true;
}

function shouldUseDeleteNoteKey(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (state.activeFolder === 'trash') return false;
  const t = e.target;
  if (t === noteContentInput || t === noteTitleInput) return false;
  if (t === searchInput || t === aiInput) return false;
  if (!addLinkModal.classList.contains('hidden')) return false;
  if (!newFolderModal.classList.contains('hidden')) return false;
  if (!settingsOverlay.classList.contains('hidden')) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return false;
  const id = state.activeNote?.id ?? state.highlightedNoteId;
  return id != null;
}

function getNoteListNavIndex() {
  const items = [...notesList.querySelectorAll('.note-item')];
  if (items.length === 0) return -1;
  const focusId = state.activeNote?.id ?? state.highlightedNoteId;
  const byActive = items.findIndex(el => el.classList.contains('active'));
  if (byActive >= 0) return byActive;
  if (focusId != null) {
    const byId = items.findIndex(el => Number(el.dataset.noteId) === focusId);
    if (byId >= 0) return byId;
  }
  return -1;
}

async function navigateNoteList(delta) {
  const items = [...notesList.querySelectorAll('.note-item')];
  if (items.length === 0) return;

  let i = getNoteListNavIndex();
  if (i < 0) {
    i = delta > 0 ? 0 : items.length - 1;
  } else {
    i = Math.max(0, Math.min(items.length - 1, i + delta));
  }

  const id = Number(items[i].dataset.noteId);
  await selectNote(id);
  items[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Folder CRUD ───────────────────────────────────────────────────────────────
async function createFolder(name) {
  if (!name.trim()) return;
  await window.api.createFolder({ name: name.trim() });
  await loadFolders();
}

async function deleteFolder(id) {
  const folder = state.folders.find(f => f.id === id);
  if (!confirm(`Delete folder "${folder?.name}"? Notes will become unfiled.`)) return;
  await window.api.deleteFolder(id);
  if (state.activeFolder === id) await switchFolder('all');
  else await loadFolders();
}

function openNewFolderModal() {
  $('new-folder-name').value = '';
  newFolderModal.classList.remove('hidden');
  $('new-folder-name').focus();
}

async function switchFolder(folder) {
  state.activeFolder = folder;
  state.searchQuery  = '';
  searchInput.value  = '';

  // Update sidebar active state
  document.querySelectorAll('.folder-item').forEach(el => {
    el.classList.toggle('active', el.dataset.folder === String(folder));
  });

  await loadFolders();
  await loadNotes();
}

// ── App links ─────────────────────────────────────────────────────────────────
async function addAppLink(bundleId) {
  if (!state.activeNote || !bundleId.trim()) return;
  await window.api.linkNoteToApp(state.activeNote.id, bundleId.trim());
  state.linkedApps = await window.api.getLinkedApps(state.activeNote.id);
  renderAppLinks();
  updateNoteLinkedBadge();
}

async function removeAppLink(bundleId) {
  if (!state.activeNote) return;
  await window.api.unlinkNoteFromApp(state.activeNote.id, bundleId);
  state.linkedApps = state.linkedApps.filter(b => b !== bundleId);
  renderAppLinks();
  updateNoteLinkedBadge();
}

function updateNoteLinkedBadge() {
  if (!state.activeNote) return;
  const listEl = document.querySelector(`.note-item[data-note-id="${state.activeNote.id}"]`);
  if (!listEl) return;
  let badge = listEl.querySelector('.note-linked-badge');
  if (state.linkedApps.length > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'note-linked-badge';
      listEl.querySelector('.note-meta').appendChild(badge);
    }
    badge.textContent = `🔗 ${state.linkedApps.length}`;
  } else {
    badge?.remove();
  }
}

// ── AI assistant ──────────────────────────────────────────────────────────────
function showAiPanel(opts) {
  const focusInput = opts?.focusInput !== false;
  aiPanel.classList.remove('hidden');
  $('toggle-ai-btn').classList.add('active');
  renderAiMessages();
  if (focusInput) aiInput.focus();
}

function hideAiPanel() {
  aiPanel.classList.add('hidden');
  $('toggle-ai-btn').classList.remove('active');
}

let _lastAiToggleAt = 0;
function toggleAiPanel() {
  const now = Date.now();
  if (now - _lastAiToggleAt < 80) return;
  _lastAiToggleAt = now;
  if (aiPanel.classList.contains('hidden')) showAiPanel();
  else hideAiPanel();
}

const LOCAL_AI_HELP_REPLY =
  'Keyboard shortcuts (macOS)\n\n' +
  'Global\n' +
  '• ⌘⇧P — Show / hide Proactive Recall\n\n' +
  'In this window\n' +
  '• ⌘N — New note\n' +
  '• ⌘⇧N — New folder\n' +
  '• ⌘⇧F — Focus search\n' +
  '• ⌘⇧A — Toggle AI assistant (Notes menu too)\n' +
  '• ⌘↵ — Send AI message\n' +
  '• ↑ / ↓ — Move through the notes list (skipped in note body, search, or AI field)\n' +
  '• Escape — Close modal; when editing a note, save and return to the list\n' +
  '• Delete / Backspace — Move selected note to Recently deleted (not while typing in inputs; disabled in Recently deleted)';

function isLocalAiSlashCommand(text) {
  const t = text.trim().toLowerCase();
  return t === '/help' || t === '/shortcuts';
}

async function sendAiMessage() {
  const text = aiInput.value.trim();
  if (!text || state.aiLoading) return;

  state.aiMessages.push({ role: 'user', content: text });
  aiInput.value = '';
  aiInput.style.height = '';
  appendAiMsg('user', text);

  if (isLocalAiSlashCommand(text)) {
    state.aiMessages.push({ role: 'assistant', content: LOCAL_AI_HELP_REPLY });
    appendAiMsg('assistant', LOCAL_AI_HELP_REPLY);
    aiInput.focus();
    return;
  }

  state.aiLoading = true;
  aiSendBtn.disabled = true;
  const thinking = document.createElement('div');
  thinking.className = 'ai-msg thinking';
  thinking.textContent = 'Thinking…';
  aiMessages.appendChild(thinking);
  aiMessages.scrollTop = aiMessages.scrollHeight;

  try {
    const result = await window.api.assistantQuery(text, state.aiMessages.slice(0, -1));
    thinking.remove();

    if (result.reply) {
      state.aiMessages.push({ role: 'assistant', content: result.reply });
      appendAiMsg('assistant', result.reply);

      // If assistant mutated notes, refresh
      const mutating = result.toolCalls?.some(t =>
        ['create_note','update_note','delete_note','move_note_to_folder','create_folder','delete_folder',
         'update_folder','link_note_to_app','unlink_note_from_app'].includes(t.name)
      );
      if (mutating) {
        await loadFolders();
        await loadNotes();
        if (state.activeNote) {
          const refreshed = await window.api.getNote(state.activeNote.id);
          if (refreshed) {
            noteTitleInput.value   = refreshed.title;
            noteContentInput.value = refreshed.content;
            state.linkedApps       = refreshed.linked_bundle_ids || [];
            renderAppLinks();
          }
        }
      }
    }
  } catch (err) {
    thinking.remove();
    appendAiMsg('assistant', `Error: ${err.message}`);
  } finally {
    state.aiLoading    = false;
    aiSendBtn.disabled = false;
    aiInput.focus();
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() {
  applyConfig();
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

async function saveSettings() {
  const model    = $('model-input').value.trim() || 'claude-sonnet-4-6';
  const cooldown = parseInt($('cooldown-input').value, 10) || 30;
  const surfacing = $('surfacing-toggle').checked;

  await window.api.saveConfig('model', model);
  await window.api.saveConfig('surfaceCooldownMinutes', cooldown);
  await window.api.saveConfig('surfacingEnabled', surfacing);

  state.config = await window.api.getConfig();
  closeSettings();
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll('.folder-item[data-folder]').forEach(el => {
    el.addEventListener('click', () => {
      const f = el.dataset.folder;
      if (f === 'all') switchFolder('all');
      else if (f === 'unfiled') switchFolder('unfiled');
      else if (f === 'trash') switchFolder('trash');
      else switchFolder(Number(f));
    });
  });

  folderList.addEventListener('click', e => {
    const item = e.target.closest('.folder-item');
    const del  = e.target.closest('.folder-delete');
    if (del) { e.stopPropagation(); deleteFolder(Number(del.dataset.folderId)); return; }
    if (item) switchFolder(Number(item.dataset.folder));
  });

  // New folder
  $('new-folder-btn').addEventListener('click', () => openNewFolderModal());
  $('close-folder-modal-btn').addEventListener('click', () => newFolderModal.classList.add('hidden'));
  $('create-folder-confirm-btn').addEventListener('click', async () => {
    await createFolder($('new-folder-name').value);
    newFolderModal.classList.add('hidden');
  });
  $('new-folder-name').addEventListener('keydown', async e => {
    if (e.key === 'Enter') { await createFolder($('new-folder-name').value); newFolderModal.classList.add('hidden'); }
    if (e.key === 'Escape') newFolderModal.classList.add('hidden');
  });

  // Notes list clicks
  notesList.addEventListener('click', e => {
    const item = e.target.closest('.note-item');
    if (item) selectNote(Number(item.dataset.noteId));
  });

  // New note
  $('new-note-btn').addEventListener('click', createNote);

  // Search
  searchInput.addEventListener('input', () => loadNotes(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchInput.value = ''; loadNotes(''); }
  });

  // Editor autosave
  noteTitleInput.addEventListener('input', scheduleSave);
  noteContentInput.addEventListener('input', scheduleSave);

  $('delete-note-btn').addEventListener('click', deleteActiveNote);
  $('restore-note-btn').addEventListener('click', () => void restoreActiveNote());
  $('erase-note-btn').addEventListener('click', () => void eraseActiveNoteForever());

  // App links panel
  appLinksBody.addEventListener('click', e => {
    const btn = e.target.closest('.chip-remove');
    if (btn) removeAppLink(btn.dataset.bundle);
  });

  $('add-app-link-btn').addEventListener('click', openAddLinkModal);
  $('close-link-modal-btn').addEventListener('click', () => addLinkModal.classList.add('hidden'));
  $('add-custom-link-btn').addEventListener('click', async () => {
    const bid = $('custom-bundle-input').value.trim();
    if (bid) { await addAppLink(bid); addLinkModal.classList.add('hidden'); }
  });
  $('custom-bundle-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const bid = $('custom-bundle-input').value.trim();
      if (bid) { await addAppLink(bid); addLinkModal.classList.add('hidden'); }
    }
  });

  $('toggle-ai-btn').addEventListener('click', () => toggleAiPanel());
  $('ai-close-btn').addEventListener('click', hideAiPanel);
  aiSendBtn.addEventListener('click', sendAiMessage);
  aiInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAiMessage(); }
  });
  aiInput.addEventListener('input', () => {
    aiInput.style.height = '';
    aiInput.style.height = Math.min(aiInput.scrollHeight, 100) + 'px';
  });

  // Settings
  $('settings-btn').addEventListener('click', openSettings);
  $('close-settings-btn').addEventListener('click', closeSettings);
  $('save-settings-btn').addEventListener('click', saveSettings);
  $('save-api-key-btn').addEventListener('click', async () => {
    const key = $('api-key-input').value.trim();
    if (key) {
      await window.api.saveConfig('anthropicApiKey', key);
      $('api-key-input').value = '';
      $('api-key-input').placeholder = '(saved)';
    }
  });
  settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });

  document.addEventListener('keydown', e => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shouldUseArrowNoteNav(e)) {
      e.preventDefault();
      void navigateNoteList(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (shouldUseDeleteNoteKey(e)) {
      e.preventDefault();
      const id = state.activeNote?.id ?? state.highlightedNoteId;
      if (id != null) void trashNoteById(id);
      return;
    }
    if (e.metaKey && e.key === 'n' && !e.shiftKey) { e.preventDefault(); createNote(); }
    if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNewFolderModal(); }
    if (e.metaKey && e.shiftKey && e.key === 'F') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    if (e.key === 'Escape') {
      if (!addLinkModal.classList.contains('hidden')) { addLinkModal.classList.add('hidden'); return; }
      if (!newFolderModal.classList.contains('hidden')) { newFolderModal.classList.add('hidden'); return; }
      if (!settingsOverlay.classList.contains('hidden')) { closeSettings(); return; }
      if (e.target === searchInput) return;
      if (state.activeNote && editorContent.style.display !== 'none') {
        e.preventDefault();
        void saveAndExitNote();
      }
    }
  });

  document.addEventListener(
    'keydown',
    e => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleAiPanel();
      }
    },
    true
  );

  // Main-process events
  window.api.onNewNote(() => createNote());
  window.api.onNewFolder(() => openNewFolderModal());
  window.api.onFocusSearch(() => { searchInput.focus(); searchInput.select(); });
  window.api.onToggleAi(() => toggleAiPanel());
  window.api.onOpenNote(noteId => selectNote(noteId));
  window.api.onSurfacingToggled(enabled => {
    state.config.surfacingEnabled = enabled;
    $('surfacing-toggle').checked = enabled;
  });
}

async function openAddLinkModal() {
  if (!state.activeNote) return;
  $('custom-bundle-input').value = '';

  const knownList = $('known-apps-list');
  knownList.innerHTML = '';

  for (const app of KNOWN_APPS) {
    const btn = document.createElement('button');
    btn.className = 'known-app-btn' + (state.linkedApps.includes(app.bundleId) ? ' linked' : '');
    btn.textContent = (state.linkedApps.includes(app.bundleId) ? '✓ ' : '') + app.name;
    btn.dataset.bundleId = app.bundleId;
    btn.addEventListener('click', async () => {
      if (state.linkedApps.includes(app.bundleId)) {
        await removeAppLink(app.bundleId);
      } else {
        await addAppLink(app.bundleId);
      }
      addLinkModal.classList.add('hidden');
    });
    knownList.appendChild(btn);
  }

  addLinkModal.classList.remove('hidden');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init().catch(err => console.error('[renderer] Init error:', err));
