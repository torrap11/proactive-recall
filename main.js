'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } = require('electron');
const path = require('path');

// ── Module references (lazy-loaded after app ready) ───────────────────────────
let db, cfg, watcher, surface;

// ── Windows ───────────────────────────────────────────────────────────────────
let mainWin   = null;
let overlayWin = null;

// ── Overlay state ─────────────────────────────────────────────────────────────
let overlayDismissTimer = null;

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialise config path before loading db/cfg
  const { setUserDataPath, getConfig, saveConfigKey } = require('./config');
  setUserDataPath(app.getPath('userData'));
  cfg = { getConfig, saveConfigKey };

  db      = require('./database');
  watcher = require('./appWatcher');
  surface = require('./surfaceEngine');

  createMainWindow();
  registerGlobalShortcuts();
  registerIpcHandlers();
  startAppWatcher();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWin?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher.stopWatcher();
});

// ── Main window ───────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    title: 'Proactive Recall',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Build a minimal native menu (keeps standard shortcuts like Cmd+C working)
  const menu = Menu.buildFromTemplate([
    {
      label: 'Proactive Recall',
      submenu: [
        { label: 'About Proactive Recall', role: 'about' },
        { type: 'separator' },
        { label: 'Hide', accelerator: 'Cmd+H', role: 'hide' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', role: 'quit' },
      ],
    },
    {
      label: 'Notes',
      submenu: [
        { label: 'New Note', accelerator: 'Cmd+N', click: () => mainWin?.webContents.send('new-note') },
        { label: 'New Folder', accelerator: 'Cmd+Shift+N', click: () => mainWin?.webContents.send('new-folder') },
        { label: 'Focus Search', accelerator: 'Cmd+Shift+F', click: () => mainWin?.webContents.send('focus-search') },
        { label: 'Toggle AI Assistant', accelerator: 'Cmd+Shift+A', click: () => mainWin?.webContents.send('toggle-ai') },
      ],
    },
    { label: 'Edit', submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    ]},
  ]);
  Menu.setApplicationMenu(menu);

  mainWin.on('closed', () => { mainWin = null; });
}

// ── Overlay window ────────────────────────────────────────────────────────────

function getOrCreateOverlayWin() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin = new BrowserWindow({
    width: 360,
    height: 200,
    x: sw - 375,
    y: sh - 220,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  return overlayWin;
}

function showOverlay(notes) {
  const win = getOrCreateOverlayWin();
  const config = cfg.getConfig();

  // Reposition in case screen changed
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win.setPosition(sw - 375, sh - 220);

  // Resize to fit content (approx)
  const noteCount = Math.min(notes.length, 3);
  const h = 80 + noteCount * 90;
  win.setSize(360, Math.min(h, 360));

  const payload = { notes, autoDismissMs: config.overlayAutoDismissMs };
  const push = () => {
    win.webContents.send('overlay-show', payload);
    win.showInactive();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', push);
  } else {
    push();
  }

  // Auto-dismiss
  if (overlayDismissTimer) clearTimeout(overlayDismissTimer);
  overlayDismissTimer = setTimeout(() => {
    hideOverlay();
  }, config.overlayAutoDismissMs + 500);
}

function hideOverlay() {
  if (overlayDismissTimer) { clearTimeout(overlayDismissTimer); overlayDismissTimer = null; }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

function registerGlobalShortcuts() {
  // Cmd+Shift+P — show / hide main window
  globalShortcut.register('Command+Shift+P', () => {
    if (!mainWin) { createMainWindow(); return; }
    if (mainWin.isVisible()) mainWin.hide();
    else { mainWin.show(); mainWin.focus(); }
  });
}

// ── App watcher ───────────────────────────────────────────────────────────────

function startAppWatcher() {
  watcher.startWatcher({
    getConfig: cfg.getConfig,
    onAppSwitch: (bundleId, appName) => {
      const config = cfg.getConfig();
      if (!config.surfacingEnabled) return;

      const notes = surface.getEligibleNotes(bundleId, appName, db);
      if (notes.length === 0) return;

      // Auto-snooze surfaced notes
      surface.recordSurfaced(notes, db, config.surfaceCooldownMinutes);

      // Show overlay
      showOverlay(notes.map(n => ({
        id: n.id,
        title: n.title,
        snippet: (n.content || '').slice(0, 200),
      })));
    },
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // Notes
  ipcMain.handle('get-notes',    (_e, folderId) => db.getAllNotes(folderId));
  ipcMain.handle('get-note',     (_e, id)       => {
    const note = db.getNoteById(id);
    if (!note) return null;
    const links = db.getLinkedBundleIds(id);
    return { ...note, linked_bundle_ids: links };
  });
  ipcMain.handle('search-notes', (_e, query)    => db.searchNotes(query));
  ipcMain.handle('create-note',  (_e, data)     => db.createNote(data));
  ipcMain.handle('update-note',  (_e, id, data) => db.updateNote(id, data));
  ipcMain.handle('delete-note', (_e, id) => {
    const ok = db.moveNoteToTrash(id);
    return ok ? { deleted: id, trashed: true } : { deleted: false };
  });
  ipcMain.handle('restore-note', (_e, id) => db.restoreNote(id));
  ipcMain.handle('permanent-delete-note', (_e, id) => {
    const ok = db.permanentDeleteNote(id);
    return ok ? { deleted: id } : { deleted: false };
  });
  ipcMain.handle('move-note',    (_e, noteId, folderId) => db.moveNoteToFolder(noteId, folderId));

  // Surface lifecycle
  ipcMain.handle('snooze-note',          (_e, id, minutes) => { db.snoozeNoteSurface(id, minutes); return true; });
  ipcMain.handle('disable-note-surface', (_e, id)          => { db.disableNoteSurface(id); return true; });
  ipcMain.handle('enable-note-surface',  (_e, id)          => { db.enableNoteSurface(id); return true; });

  // App links
  ipcMain.handle('get-linked-apps',     (_e, noteId)          => db.getLinkedBundleIds(noteId));
  ipcMain.handle('link-note-to-app',    (_e, noteId, bundleId)=> { db.linkNoteToApp(noteId, bundleId); return true; });
  ipcMain.handle('unlink-note-from-app',(_e, noteId, bundleId)=> { db.unlinkNoteFromApp(noteId, bundleId); return true; });

  // Folders
  ipcMain.handle('get-folders',    ()           => db.getAllFolders());
  ipcMain.handle('create-folder',  (_e, data)   => db.createFolder(data));
  ipcMain.handle('update-folder',  (_e, id, data)=> db.updateFolder(id, data));
  ipcMain.handle('delete-folder',  (_e, id)     => { db.deleteFolder(id); return { deleted: id }; });

  // AI assistant
  ipcMain.handle('assistant-query', async (_e, msg, history) => {
    const { runAssistant } = require('./assistant');
    return runAssistant(msg, history || [], db, cfg.getConfig());
  });

  // Config
  ipcMain.handle('get-config',  () => {
    const c = cfg.getConfig();
    // Never expose raw API key to renderer
    return {
      hasApiKey:             !!c.anthropicApiKey,
      model:                 c.model,
      surfacingEnabled:      c.surfacingEnabled,
      surfaceCooldownMinutes:c.surfaceCooldownMinutes,
      overlayAutoDismissMs:  c.overlayAutoDismissMs,
    };
  });
  ipcMain.handle('save-config', (_e, key, value) => {
    cfg.saveConfigKey(key, value);
    // Notify renderer if surfacing toggled
    if (key === 'surfacingEnabled') {
      mainWin?.webContents.send('surfacing-toggled', value);
      watcher.resetSignature();
    }
    return true;
  });

  // Overlay IPC (from overlay renderer)
  ipcMain.on('overlay-snooze',    (_e, noteId, minutes) => {
    db.snoozeNoteSurface(noteId, minutes);
    hideOverlay();
  });
  ipcMain.on('overlay-disable',   (_e, noteId) => {
    db.disableNoteSurface(noteId);
    hideOverlay();
  });
  ipcMain.on('overlay-open-note', (_e, noteId) => {
    hideOverlay();
    if (!mainWin) createMainWindow();
    mainWin?.show();
    mainWin?.focus();
    mainWin?.webContents.send('open-note', noteId);
  });
  ipcMain.on('overlay-dismiss-all', () => hideOverlay());

  // Save API key (special: stored in config file, not returned to renderer)
  ipcMain.handle('save-api-key', (_e, key) => {
    cfg.saveConfigKey('anthropicApiKey', key);
    return true;
  });
}
