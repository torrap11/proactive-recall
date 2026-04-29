'use strict';

/** Preload for capture + search windows (contextBridge API `window.mvp`). */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mvp', {
  saveCapture: (text, appKey) => ipcRenderer.invoke('capture:save', text, appKey),
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
  listApps: () => ipcRenderer.invoke('apps:list'),
  resolveAppKey: (raw) => ipcRenderer.invoke('apps:resolve', raw),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  hideCapture: () => ipcRenderer.send('window:hide-capture'),
  hideSearch: () => ipcRenderer.send('window:hide-search'),
  openSearch: (payload) => ipcRenderer.send('window:show-search', payload),
  openCapture: () => ipcRenderer.send('window:show-capture'),
  onCaptureFocus: (cb) => ipcRenderer.on('capture:focus', () => cb()),
  onSearchFocus: (cb) => ipcRenderer.on('search:focus', (_event, payload) => cb(payload || {})),
  onNotesChanged: (cb) => ipcRenderer.on('notes-changed', () => cb()),
  organizeChat: (payload) => ipcRenderer.invoke('ai:organize-chat', payload),
  applyOrganizePlan: (plan) => ipcRenderer.invoke('ai:organize-apply', plan),
});
