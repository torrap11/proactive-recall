'use strict';

/**
 * Main process: tray-less MVP with three windows (capture, search, overlay) + app watcher.
 * Flows: ⌘P search, ⌘N capture (from search), quick capture save, note CRUD/links, overlay actions,
 * frontmost-app polling → surfaceEngine → overlay.
 */

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  clipboard,
  dialog,
  shell,
  Menu,
  protocol,
  session,
} = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const db = require('./database');
const watcher = require('./appWatcher');
const surface = require('./surfaceEngine');
const { KNOWN_APPS, BUNDLE_ID_TO_NAME, resolveInputToBundleId } = require('./knownApps');
const { parseRemindWorkflowText } = require('./remindWorkflowParser');
const aiOrganize = require('./aiOrganize');

const PRELOAD_MAIN = path.join(__dirname, 'preload.js');

let captureWin = null;
let searchWin = null;
let overlayWin = null;
let lastSurfaceAt = 0;
let lastSurfaceAppKey = '';
let isImportingDb = false;

let demoMode = false;
let demoSceneIndex = 0;

const DEMO_SCENES = [
  { appKey: 'com.microsoft.VSCode',       appName: 'Visual Studio Code' },
  { appKey: 'com.tinyspeck.slackmacgap',  appName: 'Slack' },
  { appKey: 'com.google.Chrome',           appName: 'Google Chrome' },
  { appKey: 'us.zoom.xos',                 appName: 'Zoom' },
  { appKey: 'com.apple.mail',              appName: 'Mail' },
];

const APP_CONFIG = {
  maxSurfacedNotes: 3,
  minGapMsBetweenSurfacing: 15 * 1000,
  overlayDismissMs: 12000,
  defaultSnoozeMinutes: 30,
};

/** Lets the search renderer load attachments without file:// or huge data: IPC payloads. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'jot-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  },
]);

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const IMAGE_EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function mimeForImagePath(imagePath) {
  const ext = path.extname(String(imagePath || '')).toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] || 'image/png';
}

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
    /** Prefer this in the UI — works under CSP and avoids giant data URLs in IPC. */
    asset_url: `jot-image://image/${row.id}`,
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
    title: 'Jot',
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
    width: 400,
    height: 260,
    transparent: true,
    backgroundColor: '#00000000',
    x: sw - 375,
    y: sh - 240,
    frame: false,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
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

/**
 * Prefer the display of the frontmost app's focused window (where the user is working).
 * Falls back to the mouse cursor, then primary display, if System Events is unavailable.
 */
function getPlacementAnchorPoint() {
  if (process.platform === 'darwin') {
    try {
      const script = [
        'tell application "System Events"',
        '  tell (first process whose frontmost is true)',
        '    tell window 1',
        '      set px to item 1 of position',
        '      set py to item 2 of position',
        '      set sw to item 1 of size',
        '      set sh to item 2 of size',
        '      return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)',
        '    end tell',
        '  end tell',
        'end tell',
      ].join('\n');
      const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 800 }).trim();
      const parts = out.split(',').map((p) => Number(String(p).trim()));
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [x, y, w, h] = parts;
        return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
      }
    } catch {
      /* Accessibility off, menu bar app with no window, etc. */
    }
  }
  return screen.getCursorScreenPoint();
}

function centerWindowOnContextDisplay(win) {
  if (!win || win.isDestroyed()) return;
  let anchor = getPlacementAnchorPoint();
  let display = screen.getDisplayNearestPoint(anchor);
  if (!display || !display.workArea) {
    display = screen.getPrimaryDisplay();
  }
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
    captureWin.show();
    centerWindowOnContextDisplay(captureWin);
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
    searchWin.show();
    centerWindowOnContextDisplay(searchWin);
    searchWin.focus();
    searchWin.webContents.send('search:focus', payload);
  };

  if (searchWin.webContents.isLoading()) searchWin.webContents.once('did-finish-load', present);
  else present();
}

function hideSearchWindow() {
  if (searchWin && !searchWin.isDestroyed()) searchWin.hide();
}

function triggerDemoScene(index) {
  const scene = DEMO_SCENES[index % DEMO_SCENES.length];
  const picked = surface.pickSurfacedNotes({
    bundleId: scene.appKey,
    appName: scene.appName,
    db,
    catalog: KNOWN_APPS,
    limit: APP_CONFIG.maxSurfacedNotes,
    recentTransitions: [],
  });
  // Bypass the surfacing gap check for demo mode
  lastSurfaceAt = 0;
  lastSurfaceAppKey = '';
  if (picked.notes.length > 0) {
    showOverlay(scene.appKey, picked.notes, scene.appName);
  }
}

function startDemoMode() {
  demoMode = true;
  demoSceneIndex = 0;
  const seeded = db.seedDemoData();
  notifySearchNotesChanged();
  return seeded;
}

function triggerWorkflowDemo(workflowId) {
  const isMeeting = workflowId === 'meeting';
  const scene = isMeeting
    ? { appKey: 'us.zoom.xos', appName: 'Zoom' }
    : { appKey: 'com.microsoft.VSCode', appName: 'Visual Studio Code' };
  const picked = surface.pickSurfacedNotes({
    bundleId: scene.appKey,
    appName: scene.appName,
    db,
    catalog: KNOWN_APPS,
    limit: APP_CONFIG.maxSurfacedNotes,
    recentTransitions: [],
  });
  lastSurfaceAt = 0;
  lastSurfaceAppKey = '';
  if (picked.notes.length > 0) {
    showOverlay(scene.appKey, picked.notes, scene.appName);
  }
  return { workflowId: isMeeting ? 'meeting' : 'engineering', notes: picked.notes.length };
}

function showOverlay(appKey, notes, appNameOverride) {
  if (!notes || notes.length === 0) return;
  const now = Date.now();
  if (now - lastSurfaceAt < APP_CONFIG.minGapMsBetweenSurfacing && lastSurfaceAppKey === appKey) return;
  lastSurfaceAt = now;
  lastSurfaceAppKey = appKey;

  const noteIds = notes.map((n) => n.id);
  db.recordSurfaceEventBatch(noteIds, appKey, 'surfaced');

  const win = getOverlayWindow();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win.setPosition(sw - 395, sh - 260);

  const payload = {
    appKey,
    appName: appNameOverride || BUNDLE_ID_TO_NAME[appKey] || appKey,
    notes: notes.map((note) => ({
      id: note.id,
      text: note.text,
      participants: db.listParticipantsForNote(note.id),
      workflow:
        appKey === 'us.zoom.xos' || appKey === 'com.apple.mail' ? 'meeting' : 'engineering',
    })),
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
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    triggerWorkflowDemo('engineering');
  });
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

async function dedupeNotesFromMenu() {
  const parentWindow = searchWin || captureWin || null;
  try {
    const result = db.deduplicateNotesByTextAndCreatedAt();
    if (result.removed === 0) {
      await dialog.showMessageBox(parentWindow || undefined, {
        type: 'info',
        title: 'No duplicates',
        message: 'No duplicate notes were found (same text and timestamp).',
      });
      return;
    }
    void cleanupImagePaths([...result.imagePaths, ...result.filePaths]);
    notifySearchNotesChanged();
    await dialog.showMessageBox(parentWindow || undefined, {
      type: 'info',
      title: 'Duplicates removed',
      message: `Removed ${result.removed} duplicate note(s) in ${result.groups} group(s). The oldest copy in each group was kept.`,
    });
  } catch (error) {
    await dialog.showMessageBox(parentWindow || undefined, {
      type: 'error',
      title: 'Could not remove duplicates',
      message: error && error.message ? error.message : String(error),
    });
  }
}

async function exportDbFromMenu() {
  const parentWindow = searchWin || captureWin || null;
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(parentWindow, {
    title: 'Export database',
    defaultPath: `jot-backup-${stamp}.db`,
    filters: [
      { name: 'SQLite database', extensions: ['db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return;

  try {
    await db.exportDbToFile(result.filePath);
    await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: 'Database exported',
      message: 'Your database was saved.',
      detail:
        'Use Import DB to load this file later on this Mac or another. Image and file attachments are stored separately in app data; moving to a new computer may require copying those folders too if you need attachments.',
    });
  } catch (error) {
    await dialog.showMessageBox(parentWindow, {
      type: 'error',
      title: 'Export failed',
      message: 'Could not export the database.',
      detail: error && error.message ? error.message : String(error),
    });
  }
}

async function maybeShowFirstLaunchChoice() {
  if (!db.consumeWasPackagedFirstLaunch()) return false;
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
  return true;
}

async function maybePromptFirstLaunchApiKeySetup(hadFirstLaunchOnboarding) {
  if (!hadFirstLaunchOnboarding || !app.isPackaged) return;
  const { apiKey } = aiOrganize.readAnthropicCredentials(app.getPath('userData'));
  if (apiKey) return;
  const parentWindow = searchWin || captureWin || null;
  const result = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    title: 'Set up AI auto-filing',
    message: 'Do you want to set your Anthropic API key now?',
    detail: 'Jot uses it to automatically file new notes into folders. You can skip this and add it later using “Set or update API key…” or File → Anthropic API Key…',
    buttons: ['Set API Key Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) return;
  showSearchWindow();
  if (searchWin && !searchWin.isDestroyed()) {
    searchWin.webContents.send('ai:key:open-modal');
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
        {
          label: 'Export Database…',
          click: () => {
            void exportDbFromMenu();
          },
        },
        {
          label: 'Remove Duplicate Notes…',
          click: () => {
            void dedupeNotesFromMenu();
          },
        },
        {
          label: 'Anthropic API Key…',
          click: () => {
            showSearchWindow();
            if (searchWin && !searchWin.isDestroyed()) {
              searchWin.webContents.send('ai:key:open-modal');
            }
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Demo',
      submenu: [
        {
          label: 'Start Demo Mode',
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            startDemoMode();
          },
        },
        {
          label: 'Trigger Engineer Workflow',
          click: () => {
            triggerWorkflowDemo('engineering');
          },
        },
        {
          label: 'Trigger Meeting Workflow',
          click: () => {
            triggerWorkflowDemo('meeting');
          },
        },
      ],
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
        recentTransitions: watcher.getRecentTransitions(),
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

  ipcMain.handle('capture:parse-remind-workflow', async (_event, rawText) => {
    try {
      return parseRemindWorkflowText(rawText);
    } catch (_err) {
      return null;
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
  ipcMain.handle('db:export-from-picker', async () => {
    await exportDbFromMenu();
    return true;
  });
  ipcMain.handle('folders:list', () => db.listFolders());
  ipcMain.handle('folders:diagram', () => db.getFolderDiagram());
  ipcMain.handle('folders:create', (_event, name) => {
    const folder = db.createFolder(name);
    if (folder) notifySearchNotesChanged();
    return folder;
  });
  ipcMain.handle('folders:delete', (_event, folderId) => {
    const ok = db.deleteFolder(folderId);
    if (ok) notifySearchNotesChanged();
    return ok;
  });
  ipcMain.handle('apps:resolve', (_event, raw) => resolveInputToBundleId(raw));
  ipcMain.handle('clipboard:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('note-images:list', (_event, noteId) => {
    const rows = db.listNoteImages(noteId);
    return rows.map((row) => toImagePayload(row));
  });
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
    if (!row || !row.file_path) return false;
    const filesBaseDir = path.join(app.getPath('userData'), 'note-files');
    const resolvedFilePath = path.resolve(row.file_path);
    if (!resolvedFilePath.startsWith(filesBaseDir + path.sep) && resolvedFilePath !== filesBaseDir) {
      return false;
    }
    try {
      await shell.openPath(resolvedFilePath);
      return true;
    } catch (_error) {
      return false;
    }
  });

  ipcMain.handle('app:get-active', () => ({
    bundleId: lastSurfaceAppKey,
    appName: BUNDLE_ID_TO_NAME[lastSurfaceAppKey] || lastSurfaceAppKey || '',
  }));

  ipcMain.handle('demo:seed', async () => {
    return startDemoMode();
  });
  ipcMain.handle('demo:start-mode', async () => startDemoMode());
  ipcMain.handle('demo:trigger-workflow', async (_event, workflowId) => triggerWorkflowDemo(String(workflowId || 'engineering')));
  ipcMain.handle('participants:list', (_event, noteId) => db.listParticipantsForNote(noteId));
  ipcMain.handle('participants:add', (_event, noteId, participant) => db.addParticipantToNote(noteId, participant));
  ipcMain.handle('participants:remove', (_event, noteId, participant) => db.removeParticipantFromNote(noteId, participant));
  ipcMain.handle('meeting:quick-capture', (_event, text, participant) => {
    const body = String(text || '').trim();
    const person = String(participant || '').trim();
    if (!body) return null;
    const finalText = person ? `[Meeting] ${body}\nParticipant: ${person}` : `[Meeting] ${body}`;
    const note = db.createNote(finalText);
    if (!note) return null;
    db.linkNoteToApp(note.id, 'us.zoom.xos');
    if (person) db.addParticipantToNote(note.id, person);
    notifySearchNotesChanged();
    return note;
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
  ipcMain.handle('ai:night-chat', async (_event, payload) => {
    const userMessage = String((payload && payload.userMessage) || '').trim();
    if (!userMessage) return { error: 'Empty message' };
    const history = Array.isArray(payload && payload.history) ? payload.history : [];
    try {
      return await aiOrganize.nightChat(db, {
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
    db.recordSurfaceEvent(noteId, lastSurfaceAppKey, 'opened');
    hideOverlay();
    showSearchWindow({ openNoteId: noteId });
  });
  ipcMain.on('overlay-snooze', (_event, noteId, appKey, minutes) => {
    db.recordSurfaceEvent(noteId, appKey, 'snoozed');
    db.snoozeNote(noteId, appKey, Number(minutes) || APP_CONFIG.defaultSnoozeMinutes);
    hideOverlay();
  });
  ipcMain.on('overlay-complete', (_event, noteId) => {
    db.recordSurfaceEvent(noteId, lastSurfaceAppKey, 'completed');
    db.completeNote(noteId);
    hideOverlay();
    notifySearchNotesChanged();
  });
  ipcMain.on('overlay-disable', (_event, noteId, appKey) => {
    db.recordSurfaceEvent(noteId, appKey, 'dismissed');
    db.dismissNote(noteId, appKey);
    hideOverlay();
  });
  ipcMain.on('overlay-dismiss-all', hideOverlay);
}

app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('jot-image', async (request) => {
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (u.hostname !== 'image') return new Response(null, { status: 404 });
    const idPart = String(u.pathname || '').replace(/^\//, '');
    const imageId = Number(idPart);
    if (!Number.isFinite(imageId) || imageId < 1) return new Response(null, { status: 404 });
    const row = db.getNoteImageById(imageId);
    if (!row || !row.image_path) return new Response(null, { status: 404 });
    const imageBaseDir = path.join(app.getPath('userData'), 'note-images');
    const resolvedImagePath = path.resolve(row.image_path);
    if (!resolvedImagePath.startsWith(imageBaseDir + path.sep) && resolvedImagePath !== imageBaseDir) {
      return new Response(null, { status: 403 });
    }
    try {
      const buf = await fs.readFile(resolvedImagePath);
      if (!buf || buf.length === 0) return new Response(null, { status: 404 });
      const mime = mimeForImagePath(row.image_path);
      return new Response(buf, { headers: { 'Content-Type': mime } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  // Eagerly open the DB so first launch always creates an initial blank DB file.
  console.log('[app] app.getName():', app.getName());
  console.log('[app] app.getPath(userData):', app.getPath('userData'));
  db.listFolders(); // triggers getDb() → logs path, runs migration if needed
  console.log('[app] DB path:', db.getDbPath());

  if (process.env.JOT_SEED_SCREENSHOT === '1') {
    try {
      const summary = db.seedScreenshotDemoState();
      console.log('[seed] screenshot demo data written:', summary);
    } catch (err) {
      console.error('[seed] failed:', err);
      process.exitCode = 1;
    }
    app.quit();
    return;
  }

  createCaptureWindow();
  createSearchWindow();
  buildAppMenu();
  registerShortcuts();
  registerIpc();
  startWatcher();
  startDemoMode();
  const hadFirstLaunchOnboarding = await maybeShowFirstLaunchChoice();
  await maybePromptFirstLaunchApiKeySetup(hadFirstLaunchOnboarding);
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
