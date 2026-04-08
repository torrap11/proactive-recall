'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Notes ────────────────────────────────────────────────────────────────
  getNotes:          (folderId)        => ipcRenderer.invoke('get-notes', folderId),
  getNote:           (id)              => ipcRenderer.invoke('get-note', id),
  searchNotes:       (query)           => ipcRenderer.invoke('search-notes', query),
  createNote:        (data)            => ipcRenderer.invoke('create-note', data),
  updateNote:        (id, data)        => ipcRenderer.invoke('update-note', id, data),
  deleteNote:        (id)              => ipcRenderer.invoke('delete-note', id),
  restoreNote:       (id)              => ipcRenderer.invoke('restore-note', id),
  permanentDeleteNote:(id)             => ipcRenderer.invoke('permanent-delete-note', id),
  moveNote:          (noteId, folderId)=> ipcRenderer.invoke('move-note', noteId, folderId),

  // ── Surface lifecycle ────────────────────────────────────────────────────
  snoozeNote:        (id, minutes)     => ipcRenderer.invoke('snooze-note', id, minutes),
  disableNoteSurface:(id)              => ipcRenderer.invoke('disable-note-surface', id),
  enableNoteSurface: (id)              => ipcRenderer.invoke('enable-note-surface', id),

  // ── App links ────────────────────────────────────────────────────────────
  getLinkedApps:     (noteId)          => ipcRenderer.invoke('get-linked-apps', noteId),
  linkNoteToApp:     (noteId, bundleId)=> ipcRenderer.invoke('link-note-to-app', noteId, bundleId),
  unlinkNoteFromApp: (noteId, bundleId)=> ipcRenderer.invoke('unlink-note-from-app', noteId, bundleId),

  // ── Folders ──────────────────────────────────────────────────────────────
  getFolders:        ()                => ipcRenderer.invoke('get-folders'),
  createFolder:      (data)            => ipcRenderer.invoke('create-folder', data),
  updateFolder:      (id, data)        => ipcRenderer.invoke('update-folder', id, data),
  deleteFolder:      (id)              => ipcRenderer.invoke('delete-folder', id),

  // ── AI Assistant ─────────────────────────────────────────────────────────
  assistantQuery:    (msg, history)    => ipcRenderer.invoke('assistant-query', msg, history),

  // ── Config ───────────────────────────────────────────────────────────────
  getConfig:         ()                => ipcRenderer.invoke('get-config'),
  saveConfig:        (key, value)      => ipcRenderer.invoke('save-config', key, value),

  // ── Events from main ─────────────────────────────────────────────────────
  onNewNote:         (cb) => ipcRenderer.on('new-note', () => cb()),
  onNewFolder:       (cb) => ipcRenderer.on('new-folder', () => cb()),
  onFocusSearch:     (cb) => ipcRenderer.on('focus-search', () => cb()),
  onToggleAi:        (cb) => ipcRenderer.on('toggle-ai', () => cb()),
  onOpenNote:        (cb) => ipcRenderer.on('open-note', (_e, noteId) => cb(noteId)),
  onSurfacingToggled:(cb) => ipcRenderer.on('surfacing-toggled', (_e, enabled) => cb(enabled)),
});
