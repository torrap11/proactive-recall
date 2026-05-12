'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let db;
/** Cached: 'app_key' | 'bundle_id' | 'both' (legacy tables can have NOT NULL bundle_id + added app_key). */
let cachedNoteLinkMode = null;
/** Set once getDb() opens the DB; read via getDbPath(). */
let _resolvedDbPath = null;
/** Paths of secondary legacy DBs to merge after canonical DB is open (cleared after first run). */
let _pendingSecondaryMerge = [];
/** One-time marker for packaged builds to enforce blank-slate first launch. */
const FIRST_LAUNCH_MARKER_FILE = '.first-launch-initialized';
/** True when this process initialized packaged first launch. */
let _wasPackagedFirstLaunch = false;
const DB_FILENAME = 'jot.db';

function getCanonicalDbPath() {
  return path.join(app.getPath('userData'), DB_FILENAME);
}

function getProjectDbPath() {
  return path.join(__dirname, DB_FILENAME);
}

function getFirstLaunchMarkerPath() {
  return path.join(app.getPath('userData'), FIRST_LAUNCH_MARKER_FILE);
}

function firstExistingPath(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function resolveDbPath() {
  // In local dev (Cursor project), keep the DB in the repo for easy backup/import workflows.
  if (!app.isPackaged) {
    const projectDb = getProjectDbPath();
    console.log('[db] dev mode DB path:', projectDb);
    return projectDb;
  }

  const userData = app.getPath('userData');
  const appName = app.getName();
  const appSupport = path.join(app.getPath('home'), 'Library', 'Application Support');
  const canonical = getCanonicalDbPath();
  const firstLaunchMarker = getFirstLaunchMarkerPath();

  console.log('[db] app.getName():', appName);
  console.log('[db] app.getPath(userData):', userData);

  // Packaged app first launch should always start from a blank DB.
  // Any pre-existing DB is preserved as a backup so users can import it manually.
  if (app.isPackaged && !fs.existsSync(firstLaunchMarker)) {
    fs.mkdirSync(userData, { recursive: true });
    const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(canonical)) {
      const backupPath = path.join(userData, `jot.pre-first-launch-${backupSuffix}.db`);
      try {
        fs.renameSync(canonical, backupPath);
        console.log('[db] first launch backup created:', backupPath);
      } catch (err) {
        console.error('[db] failed to backup existing canonical DB:', err.message);
      }
    }
    for (const legacyPath of [
      path.join(appSupport, 'proactive-recall', 'proactive-recall.db'),
      path.join(appSupport, 'Proactive Recall', 'proactive-recall.db'),
      path.join(userData, 'jot.db'),
    ]) {
      if (!fs.existsSync(legacyPath)) continue;
      const legacyBase = path.basename(legacyPath, path.extname(legacyPath));
      const legacyBackupPath = path.join(userData, `${legacyBase}.pre-first-launch-${backupSuffix}.db`);
      try {
        fs.copyFileSync(legacyPath, legacyBackupPath);
        console.log('[db] first launch legacy backup copied:', legacyBackupPath);
      } catch (err) {
        console.error('[db] failed to backup legacy DB:', legacyPath, err.message);
      }
    }
    fs.writeFileSync(firstLaunchMarker, new Date().toISOString());
    _wasPackagedFirstLaunch = true;
    console.log('[db] first launch initialized: blank canonical DB will be created');
    return canonical;
  }

  if (fs.existsSync(canonical)) {
    console.log('[db] resolved → canonical (exists):', canonical);
    return canonical;
  }

  // Legacy on-disk paths from earlier app names (migration only; do not remove).
  //   1. proactive-recall/proactive-recall.db
  //   2. Proactive Recall/proactive-recall.db  – uppercase macOS variant
  //   3. jot.db under userData
  const legacyCandidates = [
    path.join(userData, 'proactive-recall.db'),
    path.join(appSupport, 'proactive-recall', 'proactive-recall.db'),
    path.join(appSupport, 'Proactive Recall', 'proactive-recall.db'),
    path.join(userData, 'jot.db'),
  ];
  const foundLegacy = legacyCandidates.filter(p => fs.existsSync(p));

  if (foundLegacy.length === 0) {
    console.log('[db] no existing DB → creating canonical:', canonical);
    return canonical;
  }

  const primary = foundLegacy[0];
  const secondaries = foundLegacy.slice(1);
  console.log('[db] legacy DB(s) found:', foundLegacy);
  console.log('[db] one-time migration: copying primary →', canonical);

  try {
    fs.copyFileSync(primary, canonical);
    // Provenance record – never delete; confirms migration happened.
    fs.writeFileSync(
      canonical + '.migrated-from',
      JSON.stringify({ migratedAt: new Date().toISOString(), primary, secondaries }, null, 2),
    );
    console.log('[db] migration copy complete (fallback used:', primary, ')');
    if (secondaries.length > 0) {
      console.log('[db] secondary DBs to merge after open:', secondaries);
      _pendingSecondaryMerge = secondaries;
    }
  } catch (err) {
    console.error('[db] migration copy failed:', err.message, '→ using primary directly:', primary);
    return primary;
  }

  return canonical;
}

function closeDb() {
  if (!db) return;
  db.close();
  db = null;
  cachedNoteLinkMode = null;
  _resolvedDbPath = null;
}

function importDbFromFile(sourcePath) {
  const src = String(sourcePath || '').trim();
  if (!src) return null;
  if (!fs.existsSync(src)) return null;

  const targetPath = app.isPackaged ? getCanonicalDbPath() : getProjectDbPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // Ensure SQLite handles are closed before replacing the active DB files.
  closeDb();

  const walPath = `${targetPath}-wal`;
  const shmPath = `${targetPath}-shm`;
  const tempImportPath = `${targetPath}.importing`;
  if (fs.existsSync(walPath)) fs.rmSync(walPath, { force: true });
  if (fs.existsSync(shmPath)) fs.rmSync(shmPath, { force: true });
  if (fs.existsSync(tempImportPath)) fs.rmSync(tempImportPath, { force: true });

  // Two-step replace to avoid readers seeing a partially copied DB file.
  fs.copyFileSync(src, tempImportPath);
  fs.renameSync(tempImportPath, targetPath);
  return targetPath;
}

/**
 * Writes a consistent snapshot of the open DB (safe with WAL) for backup / import elsewhere.
 * @param {string} destPath
 * @returns {Promise<string|null>} Absolute path written, or null if destPath empty.
 */
async function exportDbToFile(destPath) {
  const dest = String(destPath || '').trim();
  if (!dest) return null;

  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${dest}.exporting-${process.pid}`;
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });

  try {
    await getDb().backup(tempPath);
    if (fs.existsSync(dest)) fs.rmSync(dest);
    fs.renameSync(tempPath, dest);
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_e) {
      // ignore
    }
    throw err;
  }
  return dest;
}

/**
 * Import non-duplicate notes (by text + created_at) from a secondary legacy DB into the
 * already-open main DB. Uses SQLite ATTACH so no external tools are needed.
 * Empty-text notes (schema migration artifacts) are skipped.
 */
function mergeNotesFromLegacyDb(mainDb, legacyPath) {
  console.log('[db] merging secondary legacy DB:', legacyPath);
  const escaped = legacyPath.replace(/'/g, "''");
  mainDb.exec(`ATTACH DATABASE '${escaped}' AS _legacy_import`);
  try {
    const result = mainDb.prepare(`
      INSERT OR IGNORE INTO notes (text, created_at, updated_at, completed_at)
      SELECT text, created_at, updated_at, completed_at
      FROM _legacy_import.notes AS src
      WHERE TRIM(src.text) != ''
        AND NOT EXISTS (
          SELECT 1 FROM notes n
          WHERE n.text = src.text AND n.created_at = src.created_at
        )
    `).run();
    console.log('[db] merged', result.changes, 'note(s) from:', legacyPath);
  } finally {
    mainDb.exec('DETACH DATABASE _legacy_import');
  }
}

function hasCompositeLinkPrimaryKey() {
  const info = getDb().pragma('table_info(note_app_links)');
  const pkCols = info
    .filter((col) => Number(col.pk) > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((col) => col.name);
  return pkCols.length === 2 && pkCols[0] === 'note_id' && pkCols[1] === 'app_key';
}

function migrateNoteAppLinksToCompositeKey() {
  const database = getDb();
  const linkCols = database.pragma('table_info(note_app_links)').map((c) => c.name);
  if (!linkCols.length) return;

  const hasApp = linkCols.includes('app_key');
  const hasBundle = linkCols.includes('bundle_id');
  if (hasCompositeLinkPrimaryKey() && hasApp && !hasBundle) return;

  const selectExpr = hasApp && hasBundle
    ? "COALESCE(NULLIF(TRIM(app_key), ''), NULLIF(TRIM(bundle_id), ''))"
    : hasApp
      ? "NULLIF(TRIM(app_key), '')"
      : "NULLIF(TRIM(bundle_id), '')";

  database.exec(`
    CREATE TABLE IF NOT EXISTS note_app_links_new (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      PRIMARY KEY (note_id, app_key)
    );
  `);

  database.exec(`
    INSERT OR IGNORE INTO note_app_links_new (note_id, app_key)
    SELECT note_id, ${selectExpr}
    FROM note_app_links
    WHERE ${selectExpr} IS NOT NULL;
  `);

  database.exec('DROP TABLE note_app_links');
  database.exec('ALTER TABLE note_app_links_new RENAME TO note_app_links');
}

/** Exact `notes.text` values from an older bundled sample set (no longer inserted). Safe to delete if still present (FK cascades). */
const LEGACY_OBSOLETE_SAMPLE_NOTE_TEXTS = Object.freeze([
  'API edge-case: oauth callback fails when state payload exceeds 2KB',
  'TODO before deploy: add retry/backoff around sync API and bump timeout to 8s',
  'Debug note: auth bug only reproduces with stale local session from previous branch',
  'Architecture context: capture -> SQLite -> surface engine -> overlay, keep this slide concise',
  'Docs link to open while coding: API v2 migration checklist + schema notes',
  'Meeting prep: ACME pilot kickoff agenda (success metrics, timeline, blockers)',
  'Prior summary: ACME asked for SOC2 roadmap and SSO timeline, follow up today',
  'Sales context: Expansion opportunity depends on reducing onboarding time under 10 min',
  'Post-meeting action items draft for ACME + owner assignments',
  'Customer call reminder: open case study deck and pricing one-pager before joining',
]);

function purgeObsoleteSampleNotesIfPresent() {
  const database = getDb();
  const placeholders = LEGACY_OBSOLETE_SAMPLE_NOTE_TEXTS.map(() => '?').join(',');
  const stmt = database.prepare(`DELETE FROM notes WHERE text IN (${placeholders})`);
  const info = stmt.run(...LEGACY_OBSOLETE_SAMPLE_NOTE_TEXTS);
  if (info.changes > 0) {
    console.log('[db] removed', info.changes, 'obsolete sample note row(s)');
  }
}

function getDb() {
  if (db) return db;
  const dbPath = resolveDbPath();
  console.log('[db] opening DB at:', dbPath);
  db = new Database(dbPath);
  _resolvedDbPath = dbPath;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS note_app_links (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      PRIMARY KEY (note_id, app_key)
    );

    CREATE TABLE IF NOT EXISTS note_surface_state (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      snoozed_until TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      last_surfaced_at TEXT,
      surfaced_day TEXT,
      surfaced_count_day INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (note_id, app_key)
    );

    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS note_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS folder_app_links (
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      PRIMARY KEY (folder_id, app_key)
    );

    CREATE TABLE IF NOT EXISTS surface_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS note_participants (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      participant TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (note_id, participant)
    );

    CREATE INDEX IF NOT EXISTS idx_surface_events_note ON surface_events(note_id);
    CREATE INDEX IF NOT EXISTS idx_surface_events_app ON surface_events(app_key, event_type);
  `);

  migrateLegacy();

  // One-time secondary merge: import non-duplicate notes from any other legacy DBs found at startup.
  const pending = _pendingSecondaryMerge.splice(0);
  for (const legacyPath of pending) {
    try {
      mergeNotesFromLegacyDb(db, legacyPath);
    } catch (err) {
      console.error('[db] secondary merge failed for', legacyPath, ':', err.message);
    }
  }

  // After merges: drop any rows that still match the old bundled sample set (upgrades / merged DBs).
  purgeObsoleteSampleNotesIfPresent();

  return db;
}

function migrateLegacy() {
  const database = getDb();
  const cols = database.pragma('table_info(notes)').map((c) => c.name);

  // Do not early-return when `text` exists — older DBs still need completed_at and link fixes.
  if (!cols.includes('text')) {
    if (cols.includes('title') || cols.includes('content')) {
      database.exec("ALTER TABLE notes ADD COLUMN text TEXT NOT NULL DEFAULT ''");
      database.exec("UPDATE notes SET text = trim(COALESCE(title, '') || '\n' || COALESCE(content, ''))");
      database.exec("UPDATE notes SET text = content WHERE text = '' AND COALESCE(content, '') <> ''");
      database.exec("UPDATE notes SET text = title WHERE text = '' AND COALESCE(title, '') <> ''");
      database.exec("UPDATE notes SET text = '(empty note)' WHERE text = ''");
    }
  }

  if (!cols.includes('completed_at')) {
    database.exec('ALTER TABLE notes ADD COLUMN completed_at TEXT');
  }

  if (!cols.includes('folder_id')) {
    database.exec('ALTER TABLE notes ADD COLUMN folder_id INTEGER');
  }

  const linkCols = database.pragma('table_info(note_app_links)').map((c) => c.name);
  if (linkCols.includes('bundle_id') && !linkCols.includes('app_key')) {
    database.exec("ALTER TABLE note_app_links ADD COLUMN app_key TEXT");
    database.exec("UPDATE note_app_links SET app_key = bundle_id WHERE app_key IS NULL");
  }

  if (linkCols.includes('app_key')) {
    database.exec("UPDATE note_app_links SET app_key = 'com.spotify.client' WHERE lower(app_key) = 'spotify'");
    database.exec(
      "UPDATE note_app_links SET app_key = 'com.apple.AppStore' WHERE lower(app_key) IN ('app store', 'appstore', 'mac app store')"
    );
    database.exec(
      "UPDATE note_app_links SET app_key = 'com.microsoft.VSCode' WHERE lower(app_key) IN ('vsc', 'vs code')"
    );
  }
  if (linkCols.includes('bundle_id')) {
    database.exec("UPDATE note_app_links SET bundle_id = 'com.spotify.client' WHERE lower(bundle_id) = 'spotify'");
    database.exec(
      "UPDATE note_app_links SET bundle_id = 'com.apple.AppStore' WHERE lower(bundle_id) IN ('app store', 'appstore', 'mac app store')"
    );
    database.exec(
      "UPDATE note_app_links SET bundle_id = 'com.microsoft.VSCode' WHERE lower(bundle_id) IN ('vsc', 'vs code')"
    );
  }

  migrateNoteAppLinksToCompositeKey();

  database.exec(`
    CREATE TABLE IF NOT EXISTS folder_app_links (
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      PRIMARY KEY (folder_id, app_key)
    );
  `);
  database.exec(
    "UPDATE folder_app_links SET app_key = 'com.microsoft.VSCode' WHERE lower(app_key) IN ('vsc', 'vs code')"
  );

  const surfaceCols = database.pragma('table_info(note_surface_state)').map((c) => c.name);
  if (surfaceCols.includes('app_key')) {
    database.exec("UPDATE note_surface_state SET app_key = 'com.spotify.client' WHERE lower(app_key) = 'spotify'");
    database.exec(
      "UPDATE note_surface_state SET app_key = 'com.apple.AppStore' WHERE lower(app_key) IN ('app store', 'appstore', 'mac app store')"
    );
    database.exec(
      "UPDATE note_surface_state SET app_key = 'com.microsoft.VSCode' WHERE lower(app_key) IN ('vsc', 'vs code')"
    );
  }

  const seCols = database.pragma('table_info(surface_events)').map((c) => c.name);
  if (seCols.includes('app_key')) {
    database.exec(
      "UPDATE surface_events SET app_key = 'com.microsoft.VSCode' WHERE lower(app_key) IN ('vsc', 'vs code')"
    );
  }

  cachedNoteLinkMode = null;
}

function getNoteLinkMode() {
  if (cachedNoteLinkMode) return cachedNoteLinkMode;
  const cols = getDb().pragma('table_info(note_app_links)').map((c) => c.name);
  const hasApp = cols.includes('app_key');
  const hasBundle = cols.includes('bundle_id');
  if (hasApp && hasBundle) cachedNoteLinkMode = 'both';
  else cachedNoteLinkMode = hasApp ? 'app_key' : 'bundle_id';
  return cachedNoteLinkMode;
}

// A03 — Injection: guard against interpolating unexpected values into SQL column names.
const ALLOWED_LINK_COLS = Object.freeze({ app_key: 'app_key', bundle_id: 'bundle_id' });
function safeLinkCol(mode) {
  const col = ALLOWED_LINK_COLS[mode];
  if (!col) throw new Error(`Unexpected note_app_links column: ${JSON.stringify(mode)}`);
  return col;
}

function normalizeText(input) {
  return String(input || '').trim();
}

function createNote(text) {
  const value = normalizeText(text);
  if (!value) return null;
  const result = getDb()
    .prepare("INSERT INTO notes (text, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))")
    .run(value);
  return getNote(result.lastInsertRowid);
}

function updateNote(id, text) {
  const value = normalizeText(text);
  if (!value) return null;
  getDb()
    .prepare("UPDATE notes SET text = ?, updated_at = datetime('now') WHERE id = ?")
    .run(value, id);
  return getNote(id);
}

function deleteNote(id) {
  const nid = Number(id);
  if (!Number.isFinite(nid) || nid < 1) return false;
  const result = getDb().prepare('DELETE FROM notes WHERE id = ?').run(nid);
  return result.changes > 0;
}

function deleteNotes(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const normalized = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (normalized.length === 0) return 0;

  const stmt = getDb().prepare('DELETE FROM notes WHERE id = ?');
  const tx = getDb().transaction((values) => {
    let count = 0;
    for (const id of values) {
      count += stmt.run(id).changes;
    }
    return count;
  });
  return tx(normalized);
}

/**
 * Removes rows that share the same text and created_at (same-second duplicates).
 * Keeps the lowest id in each group. Typical cause: Enter key repeat or overlapping capture saves.
 * @returns {{ removed: number, groups: number, imagePaths: string[], filePaths: string[] }}
 */
function deduplicateNotesByTextAndCreatedAt() {
  const database = getDb();
  const groups = database
    .prepare(`
      SELECT text, created_at, COUNT(*) AS c
      FROM notes
      GROUP BY text, created_at
      HAVING c > 1
    `)
    .all();

  const selectIds = database.prepare(
    'SELECT id FROM notes WHERE text = ? AND created_at = ? ORDER BY id ASC',
  );

  const idsToDelete = [];
  for (const g of groups) {
    const rows = selectIds.all(g.text, g.created_at);
    for (let i = 1; i < rows.length; i++) {
      idsToDelete.push(rows[i].id);
    }
  }

  if (idsToDelete.length === 0) {
    return { removed: 0, groups: 0, imagePaths: [], filePaths: [] };
  }

  const imagePaths = getImagePathsForNotes(idsToDelete);
  const filePaths = getFilePathsForNotes(idsToDelete);
  const removed = deleteNotes(idsToDelete);
  return { removed, groups: groups.length, imagePaths, filePaths };
}

function completeNote(id) {
  const nid = Number(id);
  if (!Number.isFinite(nid) || nid < 1) return false;
  const result = getDb()
    .prepare("UPDATE notes SET completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(nid);
  return result.changes > 0;
}

function getNote(id) {
  return getDb().prepare('SELECT id, text, created_at, folder_id FROM notes WHERE id = ?').get(id) || null;
}

function parseFolderFilter(folderId) {
  if (folderId === 'all' || folderId == null || folderId === '') return { mode: 'all', id: null };
  if (folderId === 'unfiled') return { mode: 'unfiled', id: null };
  const numeric = Number(folderId);
  if (Number.isFinite(numeric) && numeric > 0) return { mode: 'folder', id: numeric };
  return { mode: 'all', id: null };
}

function buildFolderWhereClause(parsed, params, tableAlias = '') {
  const column = tableAlias ? `${tableAlias}.folder_id` : 'folder_id';
  if (parsed.mode === 'unfiled') return `${column} IS NULL`;
  if (parsed.mode === 'folder') {
    params.push(parsed.id);
    return `${column} = ?`;
  }
  return '1 = 1';
}

function listRecent(limit = 200, folderId = 'all') {
  const parsedFolder = parseFolderFilter(folderId);
  const params = [];
  const whereFolder = buildFolderWhereClause(parsedFolder, params, 'n');
  params.push(limit);
  return getDb()
    .prepare(`
      SELECT n.id, n.text, n.created_at, n.folder_id
      FROM notes n
      LEFT JOIN folders f ON f.id = n.folder_id
      WHERE ${whereFolder}
      ORDER BY
        datetime(n.created_at) DESC,
        n.id DESC
      LIMIT ?
    `)
    .all(...params);
}

function searchNotes(query, limit = 20, folderId = 'all') {
  const q = normalizeText(query).toLowerCase();
  if (!q) return listRecent(limit, folderId);

  const like = `%${q}%`;
  const parsedFolder = parseFolderFilter(folderId);
  const params = [q, `${q}%`, like];
  const whereFolder = buildFolderWhereClause(parsedFolder, params);
  params.push(limit);
  return getDb()
    .prepare(`
      SELECT id, text, created_at, folder_id,
        CASE
          WHEN lower(text) = ? THEN 100
          WHEN lower(text) LIKE ? THEN 60
          ELSE 20
        END + (
          CASE
            WHEN datetime(created_at) >= datetime('now', '-1 day') THEN 15
            WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 8
            ELSE 0
          END
        ) AS score
      FROM notes
      WHERE lower(text) LIKE ?
        AND ${whereFolder}
      ORDER BY score DESC, datetime(created_at) DESC
      LIMIT ?
    `)
    .all(...params);
}

function listFolders() {
  return getDb().prepare('SELECT id, name, created_at FROM folders ORDER BY lower(name) ASC').all();
}

function pruneEmptyFolders() {
  const result = getDb()
    .prepare(`
      DELETE FROM folders
      WHERE id NOT IN (
        SELECT DISTINCT folder_id
        FROM notes
        WHERE folder_id IS NOT NULL
      )
    `)
    .run();
  return result.changes || 0;
}

function getFolderDiagram() {
  const folders = getDb()
    .prepare(
      `
      SELECT f.id, f.name, COUNT(n.id) AS note_count
      FROM folders f
      LEFT JOIN notes n ON n.folder_id = f.id
      GROUP BY f.id, f.name
      ORDER BY lower(f.name) ASC
      `
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      noteCount: Number(row.note_count) || 0,
    }));
  const unfiled = getDb()
    .prepare('SELECT COUNT(*) AS count FROM notes WHERE folder_id IS NULL')
    .get();
  return {
    rootLabel: 'All notes',
    unfiledCount: Number(unfiled?.count) || 0,
    folders,
  };
}

function createFolder(name) {
  const value = normalizeText(name);
  if (!value) return null;
  const result = getDb().prepare('INSERT INTO folders (name, created_at) VALUES (?, datetime(\'now\'))').run(value);
  return getDb().prepare('SELECT id, name, created_at FROM folders WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * @param {string|number} folderId
 * @param {string} newName
 * @returns {{ id: number, name: string, created_at: string } | null}
 */
function renameFolder(folderId, newName) {
  const parsed = parseFolderFilter(folderId);
  if (parsed.mode !== 'folder') return null;
  const fid = parsed.id;
  const value = normalizeText(newName);
  if (!value) return null;
  const row = getDb().prepare('SELECT id, name, created_at FROM folders WHERE id = ?').get(fid);
  if (!row) return null;
  if (row.name === value) return row;
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(value, fid);
  return getDb().prepare('SELECT id, name, created_at FROM folders WHERE id = ?').get(fid);
}

/**
 * Removes a folder and moves any notes in it to Unfiled (same semantics as setNoteFolder(..., 'unfiled')).
 * @param {string|number} folderId
 * @returns {boolean}
 */
function deleteFolder(folderId) {
  const parsed = parseFolderFilter(folderId);
  if (parsed.mode !== 'folder') return false;
  const fid = parsed.id;
  const folder = getDb().prepare('SELECT id FROM folders WHERE id = ?').get(fid);
  if (!folder) return false;

  const txn = getDb().transaction(() => {
    const rows = getDb().prepare('SELECT id FROM notes WHERE folder_id = ?').all(fid);
    for (const row of rows) {
      setNoteFolder(row.id, 'unfiled');
    }
    getDb().prepare('DELETE FROM folders WHERE id = ?').run(fid);
  });
  txn();
  return true;
}

function setNoteFolder(noteId, folderId) {
  const nid = Number(noteId);
  if (!Number.isFinite(nid) || nid < 1) return null;
  const prev = getNote(nid);
  if (!prev) return null;
  const parsed = parseFolderFilter(folderId);
  let nextFolderId = null;
  if (parsed.mode === 'folder') {
    const folder = getDb().prepare('SELECT id FROM folders WHERE id = ?').get(parsed.id);
    if (!folder) return null;
    nextFolderId = folder.id;
  }

  const prevFolderId = prev.folder_id;
  if (nextFolderId === prevFolderId) return prev;

  if (nextFolderId != null) {
    const noteOnly = getNoteOnlyLinksForNote(nid);
    for (const k of noteOnly) {
      getDb()
        .prepare('INSERT OR IGNORE INTO folder_app_links (folder_id, app_key) VALUES (?, ?)')
        .run(nextFolderId, k);
    }
    getDb().prepare('DELETE FROM note_app_links WHERE note_id = ?').run(nid);
    getDb().prepare('UPDATE notes SET folder_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(nextFolderId, nid);
    return getNote(nid);
  }

  if (prevFolderId != null) {
    const folderKeys = getFolderLinksForFolderId(prevFolderId);
    getDb().prepare('UPDATE notes SET folder_id = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(nid);
    const mode = getNoteLinkMode();
    for (const k of folderKeys) {
      if (mode === 'both') {
        getDb()
          .prepare('INSERT OR IGNORE INTO note_app_links (note_id, bundle_id, app_key) VALUES (?, ?, ?)')
          .run(nid, k, k);
      } else {
        getDb()
          .prepare(`INSERT OR IGNORE INTO note_app_links (note_id, ${mode}) VALUES (?, ?)`)
          .run(nid, k);
      }
    }
    return getNote(nid);
  }

  getDb().prepare('UPDATE notes SET folder_id = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(nid);
  return getNote(nid);
}

function listParticipantsForNote(noteId) {
  const nid = Number(noteId);
  if (!Number.isFinite(nid) || nid < 1) return [];
  return getDb()
    .prepare('SELECT participant FROM note_participants WHERE note_id = ? ORDER BY lower(participant) ASC')
    .all(nid)
    .map((row) => String(row.participant || '').trim())
    .filter(Boolean);
}

function addParticipantToNote(noteId, participant) {
  const nid = Number(noteId);
  const value = normalizeText(participant);
  if (!Number.isFinite(nid) || nid < 1) return listParticipantsForNote(noteId);
  if (!value) return listParticipantsForNote(noteId);
  getDb()
    .prepare('INSERT OR IGNORE INTO note_participants (note_id, participant) VALUES (?, ?)')
    .run(nid, value);
  return listParticipantsForNote(nid);
}

function removeParticipantFromNote(noteId, participant) {
  const nid = Number(noteId);
  const value = normalizeText(participant);
  if (!Number.isFinite(nid) || nid < 1) return listParticipantsForNote(noteId);
  if (!value) return listParticipantsForNote(noteId);
  getDb()
    .prepare('DELETE FROM note_participants WHERE note_id = ? AND participant = ?')
    .run(nid, value);
  return listParticipantsForNote(nid);
}

function getNoteOnlyLinksForNote(noteId) {
  const mode = getNoteLinkMode();
  if (mode === 'both') {
    return getDb()
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(app_key), ''), NULLIF(TRIM(bundle_id), '')) AS k
         FROM note_app_links
         WHERE note_id = ?
           AND COALESCE(NULLIF(TRIM(app_key), ''), NULLIF(TRIM(bundle_id), '')) IS NOT NULL
         ORDER BY k ASC`
      )
      .all(noteId)
      .map((row) => row.k)
      .filter(Boolean);
  }
  return getDb()
    .prepare(`SELECT ${safeLinkCol(mode)} AS k FROM note_app_links WHERE note_id = ? ORDER BY k ASC`)
    .all(noteId)
    .map((row) => row.k)
    .filter(Boolean);
}

function getFolderLinksForFolderId(folderId) {
  const fid = Number(folderId);
  if (!Number.isFinite(fid) || fid < 1) return [];
  return getDb()
    .prepare('SELECT app_key FROM folder_app_links WHERE folder_id = ? ORDER BY app_key ASC')
    .all(fid)
    .map((row) => row.app_key)
    .filter(Boolean);
}

function linkNoteToApp(noteId, appKey) {
  const note = getNote(noteId);
  if (!note) return;
  if (note.folder_id != null) {
    getDb()
      .prepare('INSERT OR IGNORE INTO folder_app_links (folder_id, app_key) VALUES (?, ?)')
      .run(note.folder_id, appKey);
    return;
  }
  const mode = getNoteLinkMode();
  if (mode === 'both') {
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO note_app_links (note_id, bundle_id, app_key) VALUES (?, ?, ?)'
      )
      .run(noteId, appKey, appKey);
  } else {
    getDb()
      .prepare(`INSERT OR IGNORE INTO note_app_links (note_id, ${safeLinkCol(mode)}) VALUES (?, ?)`)
      .run(noteId, appKey);
  }
}

function unlinkNoteFromApp(noteId, appKey) {
  const note = getNote(noteId);
  if (!note) return;
  if (note.folder_id != null) {
    const removed = getDb()
      .prepare('DELETE FROM folder_app_links WHERE folder_id = ? AND app_key = ?')
      .run(note.folder_id, appKey);
    if (removed.changes > 0) return;
  }
  const mode = getNoteLinkMode();
  if (mode === 'both') {
    getDb()
      .prepare(
        'DELETE FROM note_app_links WHERE note_id = ? AND (app_key = ? OR bundle_id = ?)'
      )
      .run(noteId, appKey, appKey);
  } else {
    getDb()
      .prepare(`DELETE FROM note_app_links WHERE note_id = ? AND ${safeLinkCol(mode)} = ?`)
      .run(noteId, appKey);
  }
}

function getLinksForNote(noteId) {
  const note = getNote(noteId);
  if (!note) return [];
  const fromNote = getNoteOnlyLinksForNote(noteId);
  const fromFolder = note.folder_id != null ? getFolderLinksForFolderId(note.folder_id) : [];
  return [...new Set([...fromNote, ...fromFolder])].sort((a, b) => a.localeCompare(b));
}

function listNoteImages(noteId) {
  return getDb()
    .prepare('SELECT id, note_id, image_path, created_at FROM note_images WHERE note_id = ? ORDER BY id ASC')
    .all(noteId);
}

function getNoteImageById(imageId) {
  const id = Number(imageId);
  if (!Number.isFinite(id) || id < 1) return null;
  return (
    getDb()
      .prepare('SELECT id, note_id, image_path, created_at FROM note_images WHERE id = ?')
      .get(id) || null
  );
}

function addNoteImage(noteId, imagePath) {
  const result = getDb()
    .prepare("INSERT INTO note_images (note_id, image_path, created_at) VALUES (?, ?, datetime('now'))")
    .run(noteId, imagePath);
  return getDb()
    .prepare('SELECT id, note_id, image_path, created_at FROM note_images WHERE id = ?')
    .get(result.lastInsertRowid);
}

function removeNoteImage(noteId, imageId) {
  const row = getDb()
    .prepare('SELECT id, note_id, image_path, created_at FROM note_images WHERE id = ? AND note_id = ?')
    .get(imageId, noteId);
  if (!row) return null;
  getDb().prepare('DELETE FROM note_images WHERE id = ?').run(imageId);
  return row;
}

function getImagePathsForNote(noteId) {
  return getDb()
    .prepare('SELECT image_path FROM note_images WHERE note_id = ?')
    .all(noteId)
    .map((row) => row.image_path)
    .filter(Boolean);
}

function getImagePathsForNotes(noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return [];
  const normalized = [...new Set(noteIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => '?').join(', ');
  return getDb()
    .prepare(`SELECT image_path FROM note_images WHERE note_id IN (${placeholders})`)
    .all(...normalized)
    .map((row) => row.image_path)
    .filter(Boolean);
}

function listNoteFiles(noteId) {
  return getDb()
    .prepare('SELECT id, note_id, file_path, file_name, file_ext, created_at FROM note_files WHERE note_id = ? ORDER BY id ASC')
    .all(noteId);
}

function addNoteFile(noteId, filePath, fileName, fileExt) {
  const result = getDb()
    .prepare(
      "INSERT INTO note_files (note_id, file_path, file_name, file_ext, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .run(noteId, filePath, fileName, fileExt);
  return getDb()
    .prepare('SELECT id, note_id, file_path, file_name, file_ext, created_at FROM note_files WHERE id = ?')
    .get(result.lastInsertRowid);
}

function removeNoteFile(noteId, fileId) {
  const row = getDb()
    .prepare('SELECT id, note_id, file_path, file_name, file_ext, created_at FROM note_files WHERE id = ? AND note_id = ?')
    .get(fileId, noteId);
  if (!row) return null;
  getDb().prepare('DELETE FROM note_files WHERE id = ?').run(fileId);
  return row;
}

function getNoteFile(noteId, fileId) {
  return getDb()
    .prepare('SELECT id, note_id, file_path, file_name, file_ext, created_at FROM note_files WHERE id = ? AND note_id = ?')
    .get(fileId, noteId) || null;
}

function getNoteFilesForNote(noteId) {
  return getDb()
    .prepare('SELECT id, file_path, file_name, file_ext, created_at FROM note_files WHERE note_id = ? ORDER BY id ASC')
    .all(noteId);
}

function getFilePathsForNote(noteId) {
  return getDb()
    .prepare('SELECT file_path FROM note_files WHERE note_id = ?')
    .all(noteId)
    .map((row) => row.file_path)
    .filter(Boolean);
}

function getFilePathsForNotes(noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return [];
  const normalized = [...new Set(noteIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => '?').join(', ');
  return getDb()
    .prepare(`SELECT file_path FROM note_files WHERE note_id IN (${placeholders})`)
    .all(...normalized)
    .map((row) => row.file_path)
    .filter(Boolean);
}

function getNotesLinkedToApp(appKey, limit = 50) {
  const mode = getNoteLinkMode();
  if (mode === 'both') {
    return getDb()
      .prepare(`
        SELECT n.id, n.text, n.created_at
        FROM notes n
        WHERE n.completed_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM note_app_links l
              WHERE l.note_id = n.id AND (l.app_key = ? OR l.bundle_id = ?)
            )
            OR EXISTS (
              SELECT 1 FROM folder_app_links fl
              WHERE fl.folder_id = n.folder_id AND n.folder_id IS NOT NULL AND fl.app_key = ?
            )
          )
        ORDER BY datetime(n.created_at) DESC
        LIMIT ?
      `)
      .all(appKey, appKey, appKey, limit);
  }
  return getDb()
    .prepare(`
      SELECT n.id, n.text, n.created_at
      FROM notes n
      WHERE n.completed_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM note_app_links l
            WHERE l.note_id = n.id AND l.${mode} = ?
          )
          OR EXISTS (
            SELECT 1 FROM folder_app_links fl
            WHERE fl.folder_id = n.folder_id AND n.folder_id IS NOT NULL AND fl.app_key = ?
          )
        )
      ORDER BY datetime(n.created_at) DESC
      LIMIT ?
    `)
    .all(appKey, appKey, limit);
}

function getKeywordCandidates(keywords, limit = 50) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  const likeClauses = keywords.map(() => 'lower(text) LIKE ?').join(' OR ');
  const values = keywords.map((k) => `%${k.toLowerCase()}%`);
  return getDb()
    .prepare(`
      SELECT id, text, created_at
      FROM notes
      WHERE (${likeClauses})
        AND completed_at IS NULL
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `)
    .all(...values, limit);
}

function getSurfaceState(noteId, appKey) {
  return getDb()
    .prepare(`
      SELECT note_id, app_key, snoozed_until, dismissed, last_surfaced_at, surfaced_day, surfaced_count_day
      FROM note_surface_state
      WHERE note_id = ? AND app_key = ?
    `)
    .get(noteId, appKey);
}

function upsertSurfaceState(noteId, appKey) {
  getDb()
    .prepare('INSERT OR IGNORE INTO note_surface_state (note_id, app_key) VALUES (?, ?)')
    .run(noteId, appKey);
}

function snoozeNote(noteId, appKey, minutes) {
  upsertSurfaceState(noteId, appKey);
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  getDb()
    .prepare('UPDATE note_surface_state SET snoozed_until = ?, dismissed = 0 WHERE note_id = ? AND app_key = ?')
    .run(until, noteId, appKey);
}

function dismissNote(noteId, appKey) {
  upsertSurfaceState(noteId, appKey);
  getDb()
    .prepare('UPDATE note_surface_state SET dismissed = 1 WHERE note_id = ? AND app_key = ?')
    .run(noteId, appKey);
}

function canSurfaceNote(noteId, appKey) {
  const state = getSurfaceState(noteId, appKey);
  if (!state) return true;
  if (state.dismissed) return false;

  if (state.snoozed_until) {
    const until = new Date(state.snoozed_until);
    if (!Number.isNaN(until.getTime()) && until > new Date()) return false;
  }
  return true;
}

function recordSurfaced(noteId, appKey) {
  upsertSurfaceState(noteId, appKey);
  const today = new Date().toISOString().slice(0, 10);
  const existing = getSurfaceState(noteId, appKey);
  const nextCount = existing && existing.surfaced_day === today ? existing.surfaced_count_day + 1 : 1;

  getDb()
    .prepare(`
      UPDATE note_surface_state
      SET last_surfaced_at = datetime('now'),
          surfaced_day = ?,
          surfaced_count_day = ?,
          snoozed_until = NULL
      WHERE note_id = ? AND app_key = ?
    `)
    .run(today, nextCount, noteId, appKey);
}

/** Returns the absolute path of the currently open DB (null until first getDb() call). */
function getDbPath() {
  return _resolvedDbPath;
}

function consumeWasPackagedFirstLaunch() {
  const value = _wasPackagedFirstLaunch;
  _wasPackagedFirstLaunch = false;
  return value;
}

function recordSurfaceEvent(noteId, appKey, eventType) {
  try {
    getDb()
      .prepare("INSERT INTO surface_events (note_id, app_key, event_type, timestamp) VALUES (?, ?, ?, datetime('now'))")
      .run(noteId, appKey, eventType);
  } catch (_err) {
    // Non-critical — don't let analytics failures break the app
  }
}

function recordSurfaceEventBatch(noteIds, appKey, eventType) {
  const stmt = getDb().prepare(
    "INSERT INTO surface_events (note_id, app_key, event_type, timestamp) VALUES (?, ?, ?, datetime('now'))"
  );
  const insertMany = getDb().transaction((ids) => {
    for (const id of ids) stmt.run(id, appKey, eventType);
  });
  try {
    insertMany(noteIds);
  } catch (_err) {
    // Non-critical
  }
}

function getNoteSurfaceScore(noteId, appKey) {
  try {
    const row = getDb().prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'opened' THEN 1 ELSE 0 END) AS opens,
        MAX(CASE WHEN event_type = 'opened' THEN timestamp ELSE NULL END) AS last_opened
      FROM surface_events
      WHERE note_id = ? AND app_key = ?
    `).get(noteId, appKey);
    if (!row || !row.opens) return 0;
    const daysSinceOpen = row.last_opened
      ? (Date.now() - new Date(row.last_opened).getTime()) / 86400000
      : 999;
    const recencyBonus = Math.max(0, 1 - daysSinceOpen / 7);
    return Math.min(1.0, row.opens * 0.2 + recencyBonus * 0.5);
  } catch (_err) {
    return 0;
  }
}

module.exports = {
  getDbPath,
  consumeWasPackagedFirstLaunch,
  closeDb,
  importDbFromFile,
  exportDbToFile,
  createNote,
  updateNote,
  deleteNote,
  deleteNotes,
  deduplicateNotesByTextAndCreatedAt,
  completeNote,
  getNote,
  listRecent,
  searchNotes,
  listFolders,
  pruneEmptyFolders,
  getFolderDiagram,
  createFolder,
  renameFolder,
  deleteFolder,
  setNoteFolder,
  linkNoteToApp,
  unlinkNoteFromApp,
  getLinksForNote,
  listNoteImages,
  getNoteImageById,
  addNoteImage,
  removeNoteImage,
  getImagePathsForNote,
  getImagePathsForNotes,
  listNoteFiles,
  addNoteFile,
  removeNoteFile,
  getNoteFile,
  getFilePathsForNote,
  getFilePathsForNotes,
  getNotesLinkedToApp,
  getKeywordCandidates,
  canSurfaceNote,
  recordSurfaced,
  recordSurfaceEvent,
  recordSurfaceEventBatch,
  getNoteSurfaceScore,
  listParticipantsForNote,
  addParticipantToNote,
  removeParticipantFromNote,
  snoozeNote,
  dismissNote,
};
