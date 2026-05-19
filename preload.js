'use strict';

/** Preload for capture + search windows (contextBridge API `window.mvp`). */

const { contextBridge, ipcRenderer } = require('electron');

if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.body?.classList.add('jot-mac-chrome');
  });
}

contextBridge.exposeInMainWorld('mvp', {
  saveCapture: (text, appKey) => ipcRenderer.invoke('capture:save', text, appKey),
  createNote: (text) => ipcRenderer.invoke('notes:create', text),
  queryNotes: (query, folderId) => ipcRenderer.invoke('search:query', query, folderId),
  recentNotes: (folderId) => ipcRenderer.invoke('notes:recent', folderId),
  getNote: (noteId) => ipcRenderer.invoke('note:get', noteId),
  updateNote: (noteId, text) => ipcRenderer.invoke('note:update', noteId, text),
  setNoteFolder: (noteId, folderId) => ipcRenderer.invoke('note:set-folder', noteId, folderId),
  deleteNote: (noteId) => ipcRenderer.invoke('note:delete', noteId),
  deleteNotes: (noteIds) => ipcRenderer.invoke('note:delete-many', noteIds),
  getLinks: (noteId) => ipcRenderer.invoke('links:get', noteId),
  addLink: (noteId, appKey) => ipcRenderer.invoke('links:add', noteId, appKey),
  removeLink: (noteId, appKey) => ipcRenderer.invoke('links:remove', noteId, appKey),
  listNoteImages: (noteId) => ipcRenderer.invoke('note-images:list', noteId),
  addNoteImageFromDataUrl: (noteId, dataUrl) => ipcRenderer.invoke('note-images:add-from-data-url', noteId, dataUrl),
  addNoteImagesFromPicker: (noteId) => ipcRenderer.invoke('note-images:add-from-picker', noteId),
  removeNoteImage: (noteId, imageId) => ipcRenderer.invoke('note-images:remove', noteId, imageId),
  listNoteFiles: (noteId) => ipcRenderer.invoke('note-files:list', noteId),
  addNoteFilesFromPicker: (noteId) => ipcRenderer.invoke('note-files:add-from-picker', noteId),
  addNoteFileFromDataUrl: (noteId, dataUrl, fileName, fileExt) =>
    ipcRenderer.invoke('note-files:add-from-data-url', noteId, dataUrl, fileName, fileExt),
  removeNoteFile: (noteId, fileId) => ipcRenderer.invoke('note-files:remove', noteId, fileId),
  openNoteFile: (noteId, fileId) => ipcRenderer.invoke('note-files:open', noteId, fileId),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  getFolderDiagram: () => ipcRenderer.invoke('folders:diagram'),
  createFolder: (name) => ipcRenderer.invoke('folders:create', name),
  groupNotesIntoFolder: (noteIds, folderName) =>
    ipcRenderer.invoke('folders:group-notes', noteIds, folderName),
  renameFolder: (folderId, name) => ipcRenderer.invoke('folders:rename', folderId, name),
  deleteFolder: (folderId) => ipcRenderer.invoke('folders:delete', folderId),
  listApps: () => ipcRenderer.invoke('apps:list'),
  importDbFromPicker: () => ipcRenderer.invoke('db:import-from-picker'),
  exportDbFromPicker: () => ipcRenderer.invoke('db:export-from-picker'),
  resolveAppKey: (raw) => ipcRenderer.invoke('apps:resolve', raw),
  parseRemindWorkflow: (text) => ipcRenderer.invoke('capture:parse-remind-workflow', text),
  runCaptureWorkflow: (text) => ipcRenderer.invoke('capture:run-workflow', text),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read'),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  hideCapture: () => ipcRenderer.send('window:hide-capture'),
  hideSearch: () => ipcRenderer.send('window:hide-search'),
  minimizeCapture: () => ipcRenderer.send('window:minimize-capture'),
  minimizeSearch: () => ipcRenderer.send('window:minimize-search'),
  openSearch: (payload) => ipcRenderer.send('window:show-search', payload),
  openCapture: () => ipcRenderer.send('window:show-capture'),
  onCaptureFocus: (cb) => ipcRenderer.on('capture:focus', () => cb()),
  onSearchFocus: (cb) => ipcRenderer.on('search:focus', (_event, payload) => cb(payload || {})),
  onNotesChanged: (cb) => ipcRenderer.on('notes-changed', () => cb()),
  onOpenAiKeyModal: (cb) => ipcRenderer.on('ai:key:open-modal', () => cb()),
  organizeChat: (payload) => ipcRenderer.invoke('ai:organize-chat', payload),
  applyOrganizePlan: (plan) => ipcRenderer.invoke('ai:organize-apply', plan),
  runNotesCleanup: (options) => ipcRenderer.invoke('notes:cleanup', options || {}),
  getAiKeyStatus: () => ipcRenderer.invoke('ai:key:get-status'),
  setAiKey: (apiKey) => ipcRenderer.invoke('ai:key:set', apiKey),
  openExternalUrl: (url) => ipcRenderer.invoke('external:open-url', url),
  getActiveApp: () => ipcRenderer.invoke('app:get-active'),
  listParticipants: (noteId) => ipcRenderer.invoke('participants:list', noteId),
  addParticipant: (noteId, participant) => ipcRenderer.invoke('participants:add', noteId, participant),
  removeParticipant: (noteId, participant) => ipcRenderer.invoke('participants:remove', noteId, participant),
  quickCaptureMeetingNote: (text, participant) => ipcRenderer.invoke('meeting:quick-capture', text, participant),
});
