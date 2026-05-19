'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onShow: (cb) =>
    ipcRenderer.on('overlay-show', (_e, payload) => {
      cb(payload || {});
    }),
  onDismiss: (cb) => ipcRenderer.on('overlay-dismiss', () => cb()),
  onRemoveCard: (cb) =>
    ipcRenderer.on('overlay-remove-card', (_e, payload) => {
      cb(payload || {});
    }),
  notifyEmpty: () => ipcRenderer.send('overlay-empty'),
  snooze: (noteId, appKey, minutes) => ipcRenderer.send('overlay-snooze', noteId, appKey, minutes),
  complete: (noteId) => ipcRenderer.send('overlay-complete', noteId),
  disable: (noteId, appKey) => ipcRenderer.send('overlay-disable', noteId, appKey),
  openNote: (noteId) => ipcRenderer.send('overlay-open-note', noteId),
  dismissAll: () => ipcRenderer.send('overlay-dismiss-all'),
  runCommand: (payload) => ipcRenderer.invoke('overlay:run-command', payload),
});
