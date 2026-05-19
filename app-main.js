'use strict';

/**
 * Main process: tray-less MVP with windows (capture, search, overlay) + app watcher.
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
const noteCleanup = require('./noteCleanup');
const { executeCaptureWorkflow } = require('./captureWorkflow');
const { parseOverlayCommand, formatMinutesLabel } = require('./overlayCommand');

const PRELOAD_MAIN = path.join(__dirname, 'preload.js');

let captureWin = null;
let searchWin = null;
let overlayWin = null;
let lastSurfaceAt = 0;
let lastSurfaceAppKey = '';
let isImportingDb = false;
/** While > 0, blur must not hide search/capture (native file/message dialogs). */
let blurHideSuppressCount = 0;

const CLICK_AWAY_HIDE_DELAY_MS = 120;
/** Ignore blur-after-minimize races (traffic lights / dock). */
const BLUR_HIDE_IGNORE_MS = 450;

let appIsQuitting = false;

const APP_CONFIG = {
  maxSurfacedNotes: 3,
  minGapMsBetweenSurfacing: 15 * 1000,
  overlayDismissMs: 12000,
  defaultSnoozeMinutes: 30,
};

/** Overlay: fixed width; notes scroll inside. Height respects work area. */
const OVERLAY_LAYOUT = {
  width: 400,
  preferredHeight: 400,
  minHeight: 260,
  marginRight: 12,
  marginBottom: 24,
  workAreaBottomPad: 72,
};

function layoutOverlayWindow(win) {
  if (!win || win.isDestroyed()) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = OVERLAY_LAYOUT.width;
  const maxH = Math.max(OVERLAY_LAYOUT.minHeight, sh - OVERLAY_LAYOUT.workAreaBottomPad);
  const h = Math.min(OVERLAY_LAYOUT.preferredHeight, maxH);
  win.setBounds({
    x: sw - w - OVERLAY_LAYOUT.marginRight,
    y: sh - h - OVERLAY_LAYOUT.marginBottom,
    width: w,
    height: h,
  });
}

/**
 * macOS: showInactive() often stacks the overlay below the active app (e.g. Spotify).
 * Show + moveTop + focus brings Jot forward; startWatcher skips when Jot is frontmost.
 */
function raiseOverlayWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.show();
  win.moveTop();
  if (process.platform === 'darwin') {
    void app.focus({ steal: true });
    win.focus();
    setImmediate(() => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.moveTop();
      void app.focus({ steal: true });
      win.focus();
    });
  }
}

/** Surfacing when our own app is frontmost would use the wrong context — skip. */
function isJotOwningFrontBundle(bundleId) {
  const b = String(bundleId || '');
  if (!b) return false;
  if (b === 'com.jot.app') return true;
  if (!app.isPackaged && b === 'com.github.Electron') return true;
  return false;
}

/** Activate another macOS app by bundle identifier (requires Automation permission). */
function activateMacAppByBundleId(bundleId) {
  if (process.platform !== 'darwin') return;
  const bid = String(bundleId || '').trim();
  if (!bid || !/^[a-zA-Z0-9.-]+$/.test(bid)) return;
  try {
    execFileSync('osascript', ['-e', `tell application id "${bid}" to activate`], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* App not running, automation denied, or invalid id */
  }
}

/**
 * Overlay steals OS focus so it stacks above the surfaced-from app; restore it when
 * closing Done / Snooze / Disable / dismiss-all — but not when user taps Open (main UI).
 */
function restoreFrontmostAppAfterOverlay(bundleKey) {
  const bid = String(bundleKey || lastSurfaceAppKey || '').trim();
  if (!bid) return;
  setTimeout(() => activateMacAppByBundleId(bid), 60);
}

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

/** macOS: frameless window with native traffic lights + draggable web content. */
function macHiddenInsetChrome() {
  if (process.platform !== 'darwin') return {};
  return {
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
  };
}

/** Close button hides utility windows instead of destroying them. */
function wireUtilityWindowClose(win, hideFn) {
  win.on('close', (event) => {
    if (appIsQuitting) return;
    event.preventDefault();
    hideFn();
  });
}

function isJotMainWindow(win) {
  if (!win || win.isDestroyed()) return false;
  return win === searchWin || win === captureWin;
}

function hideJotUiOnClickAway() {
  if (blurHideSuppressCount > 0) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (isJotMainWindow(focused)) return;
  hideCaptureWindow();
  hideSearchWindow();
}

function scheduleHideJotOnClickAway() {
  setTimeout(hideJotUiOnClickAway, CLICK_AWAY_HIDE_DELAY_MS);
}

async function withBlurHideSuppressed(task) {
  blurHideSuppressCount += 1;
  try {
    return await task();
  } finally {
    blurHideSuppressCount -= 1;
  }
}

function attachClickAwayHide(win) {
  let ignoreBlurUntil = 0;
  win.on('minimize', () => {
    ignoreBlurUntil = Date.now() + BLUR_HIDE_IGNORE_MS;
  });
  win.on('blur', () => {
    if (Date.now() < ignoreBlurUntil) return;
    scheduleHideJotOnClickAway();
  });
}

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    width: 560,
    height: 248,
    show: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...macHiddenInsetChrome(),
    ...(process.platform !== 'darwin' ? { frame: false } : {}),
    webPreferences: rendererWebPreferences(),
  });
  captureWin.on('closed', () => {
    captureWin = null;
  });
  wireUtilityWindowClose(captureWin, hideCaptureWindow);
  attachClickAwayHide(captureWin);
  captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
}

function createSearchWindow() {
  searchWin = new BrowserWindow({
    width: 760,
    height: 640,
    show: false,
    title: 'Jot',
    minimizable: true,
    maximizable: true,
    ...macHiddenInsetChrome(),
    webPreferences: rendererWebPreferences(),
  });
  searchWin.on('closed', () => {
    searchWin = null;
  });
  wireUtilityWindowClose(searchWin, hideSearchWindow);
  attachClickAwayHide(searchWin);
  searchWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function getOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    width: OVERLAY_LAYOUT.width,
    height: OVERLAY_LAYOUT.preferredHeight,
    transparent: true,
    backgroundColor: '#00000000',
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
  layoutOverlayWindow(overlayWin);
  overlayWin.setAlwaysOnTop(true, 'pop-up-menu');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
  return overlayWin;
}

/**
 * Point used to pick which display to center Jot windows on.
 * Uses the frontmost *other* app's main window when possible; if the frontmost app is
 * Jot itself (stale frame on another Space), uses the mouse so ⌘P opens on the Space
 * you're actually using.
 */
function getPlacementAnchorPoint() {
  if (process.platform === 'darwin') {
    try {
      const script = [
        'tell application "System Events"',
        '  set frontApp to first application process whose frontmost is true',
        '  try',
        '    set bid to bundle identifier of frontApp',
        '  on error',
        '    set bid to ""',
        '  end try',
        '  try',
        '    tell window 1 of frontApp',
        '      set px to item 1 of position',
        '      set py to item 2 of position',
        '      set sw to item 1 of size',
        '      set sh to item 2 of size',
        '      return bid & "||||" & (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)',
        '    end tell',
        '  on error',
        '    return bid & "||||"',
        '  end try',
        'end tell',
      ].join('\n');
      const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 800 }).trim();
      const sep = '||||';
      const i = out.indexOf(sep);
      if (i >= 0) {
        const bid = out.slice(0, i).trim();
        const rest = out.slice(i + sep.length).trim();
        if (bid && isJotOwningFrontBundle(bid)) {
          return screen.getCursorScreenPoint();
        }
        if (rest) {
          const parts = rest.split(',').map((p) => Number(String(p).trim()));
          if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
            const [x, y, w, h] = parts;
            return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
          }
        }
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
  hideSearchWindow();

  const present = () => {
    if (!captureWin || captureWin.isDestroyed()) return;
    centerWindowOnContextDisplay(captureWin);
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
    hideCaptureWindow();
    if (process.platform === 'darwin' && payload.toggle && searchWin.isVisible()) {
      searchWin.hide();
      return;
    }
    centerWindowOnContextDisplay(searchWin);
    searchWin.show();
    if (process.platform === 'darwin') {
      void app.focus({ steal: true });
      searchWin.moveTop();
    }
    searchWin.focus();
    searchWin.webContents.send('search:focus', payload);
  };

  if (searchWin.webContents.isLoading()) searchWin.webContents.once('did-finish-load', present);
  else present();
}

function hideSearchWindow() {
  if (searchWin && !searchWin.isDestroyed()) searchWin.hide();
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
  layoutOverlayWindow(win);

  const payload = {
    appKey,
    appName: appNameOverride || BUNDLE_ID_TO_NAME[appKey] || appKey,
    notes: notes.map((note) => ({
      id: note.id,
      text: note.text,
      participants: db.listParticipantsForNote(note.id),
    })),
    autoDismissMs: APP_CONFIG.overlayDismissMs,
  };
  const send = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('overlay-show', payload);
    raiseOverlayWindow(win);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

/** Remove one card from the overlay UI; overlay calls `overlay-empty` when no cards remain. */
function sendOverlayRemoveCard(noteId) {
  const id = Number(noteId);
  if (!Number.isFinite(id)) return;
  const win = overlayWin;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay-remove-card', { noteId: id });
}

function finishOverlaySession() {
  hideOverlay();
  restoreFrontmostAppAfterOverlay(lastSurfaceAppKey);
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+P', () => showSearchWindow({ toggle: true }));
  globalShortcut.register('CommandOrControl+N', () => showCaptureWindow());
}

async function importExistingDbFromMenu() {
  if (isImportingDb) return;
  return withBlurHideSuppressed(async () => {
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
  });
}

/**
 * Deterministic dedupe + optional AI merge/reorganize. Notifies search UI when the DB changes.
 * @param {boolean} useAi
 */
async function executeNotesCleanup(useAi) {
  const local = noteCleanup.runLocalCleanup(db);
  void cleanupImagePaths([...(local.exactDupes?.imagePaths || []), ...(local.exactDupes?.filePaths || [])]);

  let ai = null;
  let apply = null;

  const localChanged =
    (local.exactDupes && local.exactDupes.removed > 0) ||
    (local.normalizedDupes && local.normalizedDupes.removed > 0) ||
    (local.prunedFolders && local.prunedFolders > 0);

  if (useAi) {
    try {
      ai = await noteCleanup.cleanupChat(db, { userDataDir: app.getPath('userData') });
    } catch (e) {
      ai = { error: e.message || String(e) };
    }
    if (ai && !ai.error && Array.isArray(ai.plan) && ai.plan.length > 0) {
      apply = noteCleanup.applyCleanupPlan(db, ai.plan);
      void cleanupImagePaths([...(apply.imagePaths || []), ...(apply.filePaths || [])]);
    }
  }

  const extraPruned = db.pruneEmptyFolders();
  const aiChanged = apply && apply.applied && apply.applied.length > 0;

  if (localChanged || aiChanged || extraPruned > 0) {
    notifySearchNotesChanged();
  }

  const summary = formatCleanupSummary({ local, ai, apply, extraPruned });
  return { local, ai, apply, extraPruned, summary };
}

function formatCleanupSummary(res) {
  const parts = [];
  const ex = res.local?.exactDupes?.removed || 0;
  const nm = res.local?.normalizedDupes?.removed || 0;
  if (ex) parts.push(`Removed ${ex} duplicate(s) with the same text and timestamp.`);
  if (nm) parts.push(`Merged ${nm} duplicate(s) with the same wording (ignoring spacing and letter case).`);
  if (!ex && !nm) parts.push('No exact-text duplicates found.');
  if (res.ai && res.ai.error) {
    parts.push(`AI cleanup: ${res.ai.error}`);
  } else if (res.apply && res.apply.applied && res.apply.applied.length > 0) {
    parts.push(`AI applied ${res.apply.applied.length} change(s).`);
    if (res.ai && res.ai.reply) parts.push(String(res.ai.reply));
  } else if (res.ai && res.ai.reply) {
    parts.push(String(res.ai.reply));
  }
  if (res.apply && res.apply.errors && res.apply.errors.length) {
    parts.push(`Warnings: ${res.apply.errors.join('; ')}`);
  }
  if (res.extraPruned > 0) {
    parts.push(`Removed ${res.extraPruned} empty folder(s).`);
  }
  return parts.join('\n');
}

async function cleanupNotesFromMenu() {
  return withBlurHideSuppressed(async () => {
  const parentWindow = searchWin || captureWin || null;
  const confirm = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'question',
    title: 'Clean DB',
    message: 'Run Clean DB?',
    detail:
      'This removes duplicate notes (same text, including copies that only differ by spacing or capital letters). If an Anthropic API key is set, AI will also try to merge overlapping ideas and tidy folders — skipped when no key.',
    buttons: ['Cancel', 'Clean DB'],
    defaultId: 1,
    cancelId: 0,
  });
  if (confirm.response !== 1) return;
  try {
    const res = await executeNotesCleanup(true);
    await dialog.showMessageBox(parentWindow || undefined, {
      type: 'info',
      title: 'Clean DB finished',
      message: 'Clean DB finished.',
      detail: res.summary,
    });
  } catch (error) {
    await dialog.showMessageBox(parentWindow || undefined, {
      type: 'error',
      title: 'Clean DB failed',
      message: error && error.message ? error.message : String(error),
    });
  }
  });
}

async function dedupeNotesFromMenu() {
  return withBlurHideSuppressed(async () => {
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
  });
}

async function exportDbFromMenu() {
  return withBlurHideSuppressed(async () => {
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
  });
}

async function maybeShowFirstLaunchChoice() {
  if (!db.consumeWasPackagedFirstLaunch()) return false;
  return withBlurHideSuppressed(async () => {
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
  });
}

async function maybePromptFirstLaunchApiKeySetup(hadFirstLaunchOnboarding) {
  if (!hadFirstLaunchOnboarding || !app.isPackaged) return;
  const { apiKey } = aiOrganize.readAnthropicCredentials(app.getPath('userData'));
  if (apiKey) return;
  return withBlurHideSuppressed(async () => {
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
  });
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
          label: 'Clean DB…',
          click: () => {
            showSearchWindow();
            void cleanupNotesFromMenu();
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
      if (isJotOwningFrontBundle(bundleId)) return;
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

  ipcMain.handle('capture:run-workflow', async (_event, rawText) => {
    try {
      const result = await executeCaptureWorkflow(db, rawText, app.getPath('userData'));
      if (result.ok) notifySearchNotesChanged();
      return result;
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

  ipcMain.handle('capture:save', (_event, text, appKey) => {
    const note = db.createNote(text);
    if (note && appKey) db.linkNoteToApp(note.id, appKey);
    if (note) notifySearchNotesChanged();
    return note;
  });
  ipcMain.handle('notes:create', (_event, text) => {
    const trimmed = String(text || '').trim();
    const note = trimmed ? db.createNote(trimmed) : db.createDraftNote();
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
  ipcMain.handle('folders:group-notes', (_event, noteIds, folderName) => {
    const result = db.groupNotesIntoNewFolder(noteIds, folderName);
    if (result) notifySearchNotesChanged();
    return result;
  });
  ipcMain.handle('folders:rename', (_event, folderId, name) => {
    const folder = db.renameFolder(folderId, name);
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
  ipcMain.handle('clipboard:read-image', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return img.toDataURL();
  });
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
  ipcMain.handle('note-images:add-from-picker', async (event, noteId) =>
    withBlurHideSuppressed(async () => {
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
  }));
  ipcMain.handle('note-images:remove', async (_event, noteId, imageId) => {
    const removed = db.removeNoteImage(noteId, imageId);
    if (!removed) return false;
    await cleanupImagePaths([removed.image_path]);
    notifySearchNotesChanged();
    return true;
  });

  ipcMain.handle('note-files:list', (_event, noteId) => db.listNoteFiles(noteId).map(toFilePayload));

  ipcMain.handle('note-files:add-from-picker', async (event, noteId) =>
    withBlurHideSuppressed(async () => {
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
  }));

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
  ipcMain.handle('ai:organize-apply', (_event, plan) => {
    const result = aiOrganize.applyOrganizePlan(db, plan);
    const prunedFolders = db.pruneEmptyFolders();
    if (result.applied.length > 0 || prunedFolders > 0) notifySearchNotesChanged();
    return { ...result, prunedFolders };
  });

  ipcMain.handle('notes:cleanup', async (_event, payload) => {
    const useAi = !payload || payload.useAi !== false;
    try {
      return await executeNotesCleanup(useAi);
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

  ipcMain.on('window:hide-capture', hideCaptureWindow);
  ipcMain.on('window:hide-search', hideSearchWindow);
  ipcMain.on('window:minimize-capture', () => {
    if (captureWin && !captureWin.isDestroyed()) captureWin.minimize();
  });
  ipcMain.on('window:minimize-search', () => {
    if (searchWin && !searchWin.isDestroyed()) searchWin.minimize();
  });
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
    sendOverlayRemoveCard(noteId);
  });
  ipcMain.on('overlay-complete', (_event, noteId) => {
    db.recordSurfaceEvent(noteId, lastSurfaceAppKey, 'completed');
    db.completeNote(noteId);
    notifySearchNotesChanged();
    sendOverlayRemoveCard(noteId);
  });
  ipcMain.on('overlay-disable', (_event, noteId, appKey) => {
    db.recordSurfaceEvent(noteId, appKey, 'dismissed');
    db.dismissNote(noteId, appKey);
    sendOverlayRemoveCard(noteId);
  });
  ipcMain.on('overlay-empty', () => {
    finishOverlaySession();
  });
  ipcMain.on('overlay-dismiss-all', () => {
    finishOverlaySession();
  });

  ipcMain.handle('overlay:run-command', (_event, payload) => {
    const appKey = String((payload && payload.appKey) || lastSurfaceAppKey || '').trim();
    const noteIds = (Array.isArray(payload && payload.noteIds) ? payload.noteIds : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    const focusNoteId = Number(payload && payload.focusNoteId);
    const parsed = parseOverlayCommand(payload && payload.command);
    if (parsed.error) return parsed;

    if (parsed.op === 'snoozeAll') {
      if (!appKey) return { error: 'Missing app context.' };
      if (noteIds.length === 0) return { error: 'No reminders to snooze.' };
      for (const id of noteIds) {
        db.recordSurfaceEvent(id, appKey, 'snoozed');
        db.snoozeNote(id, appKey, parsed.minutes);
        sendOverlayRemoveCard(id);
      }
      return {
        ok: true,
        message: `Snoozed ${noteIds.length} reminder(s) for ${formatMinutesLabel(parsed.minutes)}.`,
      };
    }

    if (parsed.op === 'snoozeOne') {
      if (!appKey) return { error: 'Missing app context.' };
      const id =
        Number.isFinite(focusNoteId) && noteIds.includes(focusNoteId) ? focusNoteId : noteIds[0];
      if (!id) return { error: 'No reminder selected.' };
      db.recordSurfaceEvent(id, appKey, 'snoozed');
      db.snoozeNote(id, appKey, parsed.minutes);
      sendOverlayRemoveCard(id);
      return {
        ok: true,
        message: `Snoozed for ${formatMinutesLabel(parsed.minutes)}.`,
      };
    }

    if (parsed.op === 'completeAll') {
      for (const id of noteIds) {
        db.recordSurfaceEvent(id, lastSurfaceAppKey, 'completed');
        db.completeNote(id);
        sendOverlayRemoveCard(id);
      }
      if (noteIds.length > 0) notifySearchNotesChanged();
      return { ok: true, message: `Marked ${noteIds.length} reminder(s) done.` };
    }

    if (parsed.op === 'completeOne') {
      const id =
        Number.isFinite(focusNoteId) && noteIds.includes(focusNoteId) ? focusNoteId : noteIds[0];
      if (!id) return { error: 'No reminder selected.' };
      db.recordSurfaceEvent(id, lastSurfaceAppKey, 'completed');
      db.completeNote(id);
      notifySearchNotesChanged();
      sendOverlayRemoveCard(id);
      return { ok: true, message: 'Marked done.' };
    }

    if (parsed.op === 'dismissAll') {
      finishOverlaySession();
      return { ok: true, message: 'Dismissed.', dismissAll: true };
    }

    return { error: 'Unknown command.' };
  });
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

  createSearchWindow();
  buildAppMenu();
  registerShortcuts();
  registerIpc();
  startWatcher();
  const hadFirstLaunchOnboarding = await maybeShowFirstLaunchChoice();
  await maybePromptFirstLaunchApiKeySetup(hadFirstLaunchOnboarding);
});

app.on('before-quit', () => {
  appIsQuitting = true;
});

app.on('will-quit', () => {
  watcher.stopWatcher();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!searchWin || searchWin.isDestroyed()) createSearchWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
