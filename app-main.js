'use strict';

/**
 * Main process: tray-less MVP with three windows (capture, search, overlay) + app watcher.
 * Flows: ⌘P search, ⌘N capture (from search), quick capture save, note CRUD/links, overlay actions,
 * frontmost-app polling → surfaceEngine → overlay.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, screen, clipboard, dialog, shell, Menu } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const db = require('./database');
const watcher = require('./appWatcher');
const surface = require('./surfaceEngine');
const { KNOWN_APPS, BUNDLE_ID_TO_NAME, resolveInputToBundleId } = require('./knownApps');
const aiOrganize = require('./aiOrganize');

const PRELOAD_MAIN = path.join(__dirname, 'preload.js');

let captureWin = null;
let searchWin = null;
let overlayWin = null;
let lastSurfaceAt = 0;
let lastSurfaceAppKey = '';
let isImportingDb = false;

const APP_CONFIG = {
  maxSurfacedNotes: 3,
  minGapMsBetweenSurfacing: 15 * 1000,
  overlayDismissMs: 10000,
  defaultSnoozeMinutes: 30,
};

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Only allow copying a small set of “safe text-ish” file types into note storage.
// This avoids arbitrary binary attachments.
const NOTE_FILE_WHITELIST_EXTS = ['pdf', 'md', 'rmd', 'txt'];

async function ensureAttachmentDir() {
  const dir = path.join(app.getPath('userData'), 'note-images');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureFileAttachmentDir() {
  const dir = path.join(app.getPath('userData'), 'note-files');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function toImagePayload(row) {
  return {
    id: row.id,
    note_id: row.note_id,
    created_at: row.created_at,
    image_path: row.image_path,
    file_url: pathToFileURL(row.image_path).href,
  };
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  const ext = MIME_TO_EXT[mime];
  if (!ext) return null;
  return { mime, ext, buffer: Buffer.from(base64, 'base64') };
}

function parseBase64DataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer || buffer.length === 0) return null;
  return { mime, buffer };
}

function safeExtFromPath(inputPath) {
  const ext = path.extname(String(inputPath || '')).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '.png';
}

function safeNoteFileExtFromPath(inputPath) {
  const rawExt = path.extname(String(inputPath || '')).toLowerCase().replace(/^\./, '');
  if (!rawExt) return null;
  if (!NOTE_FILE_WHITELIST_EXTS.includes(rawExt)) return null;
  return rawExt;
}

function toFilePayload(row) {
  return {
    id: row.id,
    note_id: row.note_id,
    created_at: row.created_at,
    file_name: row.file_name,
    file_ext: row.file_ext,
  };
}

async function saveNoteFileAttachment(noteId, srcPath, fileExt) {
  const dir = await ensureFileAttachmentDir();
  const originalName = path.basename(srcPath);
  const fileName = `note-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`;
  const destPath = path.join(dir, fileName);
  await fs.copyFile(srcPath, destPath);
  const row = db.addNoteFile(noteId, destPath, originalName, fileExt);
  return toFilePayload(row);
}

async function saveNoteFileFromDataUrl(noteId, dataUrl, fileName, fileExt) {
  const dir = await ensureFileAttachmentDir();
  const ext = String(fileExt || '').toLowerCase().replace(/^\./, '');
  if (!NOTE_FILE_WHITELIST_EXTS.includes(ext)) return null;

  const parsed = parseBase64DataUrl(dataUrl);
  if (!parsed || !parsed.buffer || parsed.buffer.length === 0) return null;

  const originalName = String(fileName || `attachment.${ext}`);
  const safeOriginalName = path.basename(originalName);
  const destFileName = `note-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const destPath = path.join(dir, destFileName);
  await fs.writeFile(destPath, parsed.buffer);

  const row = db.addNoteFile(noteId, destPath, safeOriginalName, ext);
  return toFilePayload(row);
}

async function saveImageBuffer(noteId, buffer, ext) {
  const dir = await ensureAttachmentDir();
  const fileName = `note-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, buffer);
  return fullPath;
}

async function cleanupImagePaths(paths) {
  for (const imagePath of paths || []) {
    try {
      await fs.unlink(imagePath);
    } catch (_error) {
      // Ignore missing files or cleanup errors.
    }
  }
}

function rendererWebPreferences() {
  return {
    preload: PRELOAD_MAIN,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    width: 560,
    height: 190,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: rendererWebPreferences(),
  });
  captureWin.on('closed', () => {
    captureWin = null;
  });
  captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
}

function createSearchWindow() {
  searchWin = new BrowserWindow({
    width: 760,
    height: 640,
    show: false,
    title: 'Jot Search',
    webPreferences: rendererWebPreferences(),
  });
  searchWin.on('closed', () => {
    searchWin = null;
  });
  searchWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function getOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin = new BrowserWindow({
    width: 360,
    height: 220,
    x: sw - 375,
    y: sh - 240,
    frame: false,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'pop-up-menu');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
  return overlayWin;
}

function centerWindowOnCursorDisplay(win) {
  if (!win || win.isDestroyed()) return;
  const pointer = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pointer);
  const area = display.workArea;
  const bounds = win.getBounds();
  const x = Math.round(area.x + (area.width - bounds.width) / 2);
  const y = Math.round(area.y + (area.height - bounds.height) / 2);
  win.setPosition(x, y);
}

function showCaptureWindow() {
  if (!captureWin || captureWin.isDestroyed()) createCaptureWindow();

  const present = () => {
    if (!captureWin || captureWin.isDestroyed()) return;
    centerWindowOnCursorDisplay(captureWin);
    captureWin.show();
    captureWin.focus();
    captureWin.webContents.send('capture:focus');
  };

  if (captureWin.webContents.isLoading()) captureWin.webContents.once('did-finish-load', present);
  else present();
}

function hideCaptureWindow() {
  if (captureWin && !captureWin.isDestroyed()) captureWin.hide();
}

function showSearchWindow(payload = {}) {
  if (!searchWin || searchWin.isDestroyed()) createSearchWindow();

  const present = () => {
    if (!searchWin || searchWin.isDestroyed()) return;
    centerWindowOnCursorDisplay(searchWin);
    searchWin.show();
    searchWin.focus();
    searchWin.webContents.send('search:focus', payload);
  };

  if (searchWin.webContents.isLoading()) searchWin.webContents.once('did-finish-load', present);
  else present();
}

function hideSearchWindow() {
  if (searchWin && !searchWin.isDestroyed()) searchWin.hide();
}

function showOverlay(appKey, notes) {
  if (!notes || notes.length === 0) return;
  const now = Date.now();
  if (now - lastSurfaceAt < APP_CONFIG.minGapMsBetweenSurfacing && lastSurfaceAppKey === appKey) return;
  lastSurfaceAt = now;
  lastSurfaceAppKey = appKey;

  const win = getOverlayWindow();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win.setPosition(sw - 375, sh - 240);

  const payload = {
    appKey,
    appName: BUNDLE_ID_TO_NAME[appKey] || appKey,
    notes: notes.map((note) => ({ id: note.id, text: note.text })),
    autoDismissMs: APP_CONFIG.overlayDismissMs,
  };
  const send = () => {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.webContents.send('overlay-show', payload);
    win.showInactive();
    win.moveTop();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+P', () => showSearchWindow());
}

async function importExistingDbFromMenu() {
  if (isImportingDb) return;
  const parentWindow = searchWin || captureWin || null;
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'SQLite DB files', extensions: ['db', 'sqlite', 'sqlite3'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;

  try {
    isImportingDb = true;
    watcher.stopWatcher();
    const importedPath = db.importDbFromFile(result.filePaths[0]);
    if (!importedPath) throw new Error('Could not import selected database file.');
    if (app.isPackaged) {
      await dialog.showMessageBox(parentWindow, {
        type: 'info',
        title: 'Database Imported',
        message: 'Database imported successfully.',
        detail: 'Jot will restart to load the imported database.',
      });
      app.relaunch();
      app.exit(0);
    } else {
      await dialog.showMessageBox(parentWindow, {
        type: 'info',
        title: 'Database Imported',
        message: 'Database imported successfully.',
        detail: 'Data has been reloaded from the selected database.',
      });
      db.listFolders(); // re-open DB immediately after import in dev mode
      notifySearchNotesChanged();
    }
  } catch (error) {
    await dialog.showMessageBox(parentWindow, {
      type: 'error',
      title: 'Import Failed',
      message: 'Could not import database.',
      detail: error && error.message ? error.message : String(error),
    });
  } finally {
    isImportingDb = false;
    startWatcher();
  }
}

async function maybeShowFirstLaunchChoice() {
  if (!db.consumeWasPackagedFirstLaunch()) return;
  const parentWindow = searchWin || captureWin || null;
  const result = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    title: 'Welcome to Jot',
    message: 'How do you want to start?',
    detail: 'Start with a blank database, or import an existing database file now.',
    buttons: ['Start Fresh', 'Import Existing DB...'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response === 1) {
    await importExistingDbFromMenu();
  }
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Existing DB...',
          click: () => {
            void importExistingDbFromMenu();
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }],
    },
  ];
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideothers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function startWatcher() {
  watcher.startWatcher({
    getConfig: () => ({ surfacingEnabled: true }),
    onAppSwitch: (bundleId, appName) => {
      const picked = surface.pickSurfacedNotes({
        bundleId,
        appName,
        db,
        catalog: KNOWN_APPS,
        limit: APP_CONFIG.maxSurfacedNotes,
      });
      if (!picked.appKey || picked.notes.length === 0) return;
      showOverlay(picked.appKey, picked.notes);
    },
  });
}

function notifySearchNotesChanged() {
  if (searchWin && !searchWin.isDestroyed()) {
    searchWin.webContents.send('notes-changed');
  }
}

function registerIpc() {
  ipcMain.handle('ai:key:get-status', async () => {
    const { apiKey } = aiOrganize.readAnthropicCredentials(app.getPath('userData'));
    return { hasKey: apiKey.length > 0 };
  });
  ipcMain.handle('ai:key:set', async (_event, rawKey) => {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'Empty API key' };
    if (!key.startsWith('sk-ant-')) return { ok: false, error: 'Anthropic key should start with sk-ant-' };
    const userDataDir = app.getPath('userData');
    const envPath = path.join(userDataDir, '.env');

    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf8');
    } catch (_error) {
      content = '';
    }
    const lines = content ? content.split(/\r?\n/) : [];
    let replaced = false;
    const nextLines = lines.map((line) => {
      if (/^\s*ANTHROPIC_API_KEY\s*=/.test(line)) {
        replaced = true;
        return `ANTHROPIC_API_KEY=${key}`;
      }
      return line;
    });
    if (!replaced) nextLines.push(`ANTHROPIC_API_KEY=${key}`);
    const nextContent = `${nextLines.filter((line, idx, arr) => !(idx === arr.length - 1 && line === '')).join('\n')}\n`;
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(envPath, nextContent, 'utf8');
    return { ok: true };
  });
  ipcMain.handle('external:open-url', async (_event, targetUrl) => {
    const url = String(targetUrl || '').trim();
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch (_error) {
      return false;
    }
  });

  ipcMain.handle('capture:save', (_event, text, appKey) => {
    const note = db.createNote(text);
    if (note && appKey) db.linkNoteToApp(note.id, appKey);
    if (note) notifySearchNotesChanged();
    return note;
  });
  ipcMain.handle('search:query', (_event, query, folderId) => db.searchNotes(query, 20, folderId));
  ipcMain.handle('notes:recent', (_event, folderId) => db.listRecent(20, folderId));
  ipcMain.handle('note:get', (_event, noteId) => db.getNote(noteId));
  ipcMain.handle('note:update', (_event, noteId, text) => db.updateNote(noteId, text));
  ipcMain.handle('note:set-folder', (_event, noteId, folderId) => {
    const note = db.setNoteFolder(noteId, folderId);
    if (note) notifySearchNotesChanged();
    return note;
  });
  ipcMain.handle('note:delete', (_event, noteId) => {
    const imagePaths = db.getImagePathsForNote(noteId);
    const filePaths = db.getFilePathsForNote(noteId);
    const ok = db.deleteNote(noteId);
    if (ok) {
      void cleanupImagePaths([...imagePaths, ...filePaths]);
      notifySearchNotesChanged();
    }
    return ok;
  });
  ipcMain.handle('note:delete-many', (_event, noteIds) => {
    const imagePaths = db.getImagePathsForNotes(noteIds);
    const filePaths = db.getFilePathsForNotes(noteIds);
    const deletedCount = db.deleteNotes(noteIds);
    if (deletedCount > 0) {
      void cleanupImagePaths([...imagePaths, ...filePaths]);
      notifySearchNotesChanged();
    }
    return deletedCount;
  });

  ipcMain.handle('links:get', (_event, noteId) => db.getLinksForNote(noteId));
  ipcMain.handle('links:add', (_event, noteId, appKey) => {
    db.linkNoteToApp(noteId, appKey);
    notifySearchNotesChanged();
    return db.getLinksForNote(noteId);
  });
  ipcMain.handle('links:remove', (_event, noteId, appKey) => {
    db.unlinkNoteFromApp(noteId, appKey);
    notifySearchNotesChanged();
    return db.getLinksForNote(noteId);
  });
  ipcMain.handle('apps:list', () => KNOWN_APPS.map((entry) => ({ name: entry.name, bundleId: entry.bundleId })));
  ipcMain.handle('db:import-from-picker', async () => {
    await importExistingDbFromMenu();
    return true;
  });
  ipcMain.handle('folders:list', () => db.listFolders());
  ipcMain.handle('folders:diagram', () => db.getFolderDiagram());
  ipcMain.handle('folders:create', (_event, name) => {
    const folder = db.createFolder(name);
    if (folder) notifySearchNotesChanged();
    return folder;
  });
  ipcMain.handle('apps:resolve', (_event, raw) => resolveInputToBundleId(raw));
  ipcMain.handle('clipboard:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('note-images:list', (_event, noteId) => db.listNoteImages(noteId).map(toImagePayload));
  ipcMain.handle('note-images:add-from-data-url', async (_event, noteId, dataUrl) => {
    const note = db.getNote(noteId);
    if (!note) return null;
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed || !parsed.buffer || parsed.buffer.length === 0) return null;
    const savedPath = await saveImageBuffer(noteId, parsed.buffer, parsed.ext);
    const row = db.addNoteImage(noteId, savedPath);
    notifySearchNotesChanged();
    return toImagePayload(row);
  });
  ipcMain.handle('note-images:add-from-picker', async (event, noteId) => {
    const note = db.getNote(noteId);
    if (!note) return [];
    const parentWindow = BrowserWindow.fromWebContents(event.sender) || searchWin || null;
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return [];

    const created = [];
    for (const srcPath of result.filePaths) {
      const ext = safeExtFromPath(srcPath);
      const dir = await ensureAttachmentDir();
      const fileName = `note-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const destPath = path.join(dir, fileName);
      await fs.copyFile(srcPath, destPath);
      const row = db.addNoteImage(noteId, destPath);
      created.push(toImagePayload(row));
    }
    if (created.length > 0) notifySearchNotesChanged();
    return created;
  });
  ipcMain.handle('note-images:remove', async (_event, noteId, imageId) => {
    const removed = db.removeNoteImage(noteId, imageId);
    if (!removed) return false;
    await cleanupImagePaths([removed.image_path]);
    notifySearchNotesChanged();
    return true;
  });

  ipcMain.handle('note-files:list', (_event, noteId) => db.listNoteFiles(noteId).map(toFilePayload));

  ipcMain.handle('note-files:add-from-picker', async (event, noteId) => {
    const note = db.getNote(noteId);
    if (!note) return [];
    const parentWindow = BrowserWindow.fromWebContents(event.sender) || searchWin || null;
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Allowed note files', extensions: NOTE_FILE_WHITELIST_EXTS }],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return [];

    const created = [];
    for (const srcPath of result.filePaths) {
      const fileExt = safeNoteFileExtFromPath(srcPath);
      if (!fileExt) continue;
      const saved = await saveNoteFileAttachment(noteId, srcPath, fileExt);
      created.push(saved);
    }

    if (created.length > 0) notifySearchNotesChanged();
    return created;
  });

  ipcMain.handle('note-files:add-from-data-url', async (_event, noteId, dataUrl, fileName, fileExt) => {
    const note = db.getNote(noteId);
    if (!note) return null;
    const saved = await saveNoteFileFromDataUrl(noteId, dataUrl, fileName, fileExt);
    if (saved) notifySearchNotesChanged();
    return saved;
  });

  ipcMain.handle('note-files:remove', async (_event, noteId, fileId) => {
    const removed = db.removeNoteFile(noteId, fileId);
    if (!removed) return false;
    await cleanupImagePaths([removed.file_path]);
    notifySearchNotesChanged();
    return true;
  });

  ipcMain.handle('note-files:open', async (_event, noteId, fileId) => {
    const row = db.getNoteFile(noteId, fileId);
    if (!row) return false;
    try {
      await shell.openPath(row.file_path);
      return true;
    } catch (_error) {
      return false;
    }
  });

  ipcMain.handle('ai:organize-chat', async (_event, payload) => {
    const userMessage = String((payload && payload.userMessage) || '').trim();
    if (!userMessage) return { error: 'Empty message' };
    const history = Array.isArray(payload && payload.history) ? payload.history : [];
    try {
      return await aiOrganize.organizeChat(db, {
        history,
        userMessage,
        userDataDir: app.getPath('userData'),
      });
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });
  ipcMain.handle('ai:organize-apply', (_event, plan) => {
    const result = aiOrganize.applyOrganizePlan(db, plan);
    const prunedFolders = db.pruneEmptyFolders();
    if (result.applied.length > 0 || prunedFolders > 0) notifySearchNotesChanged();
    return { ...result, prunedFolders };
  });

  ipcMain.on('window:hide-capture', hideCaptureWindow);
  ipcMain.on('window:hide-search', hideSearchWindow);
  ipcMain.on('window:show-search', (_event, payload) => showSearchWindow(payload || {}));
  ipcMain.on('window:show-capture', showCaptureWindow);

  ipcMain.on('overlay-open-note', (_event, noteId) => {
    hideOverlay();
    showSearchWindow({ openNoteId: noteId });
  });
  ipcMain.on('overlay-snooze', (_event, noteId, appKey, minutes) => {
    db.snoozeNote(noteId, appKey, Number(minutes) || APP_CONFIG.defaultSnoozeMinutes);
    hideOverlay();
  });
  ipcMain.on('overlay-complete', (_event, noteId) => {
    db.completeNote(noteId);
    hideOverlay();
    notifySearchNotesChanged();
  });
  ipcMain.on('overlay-disable', (_event, noteId, appKey) => {
    db.dismissNote(noteId, appKey);
    hideOverlay();
  });
  ipcMain.on('overlay-dismiss-all', hideOverlay);
}

app.whenReady().then(async () => {
  // Eagerly open the DB so first launch always creates an initial blank DB file.
  console.log('[app] app.getName():', app.getName());
  console.log('[app] app.getPath(userData):', app.getPath('userData'));
  db.listFolders(); // triggers getDb() → logs path, runs migration if needed
  console.log('[app] DB path:', db.getDbPath());

  createCaptureWindow();
  createSearchWindow();
  buildAppMenu();
  registerShortcuts();
  registerIpc();
  startWatcher();
  await maybeShowFirstLaunchChoice();
});

app.on('will-quit', () => {
  watcher.stopWatcher();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!captureWin || captureWin.isDestroyed()) createCaptureWindow();
  if (!searchWin || searchWin.isDestroyed()) createSearchWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
