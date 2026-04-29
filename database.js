'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;
/** Cached: 'app_key' | 'bundle_id' | 'both' (legacy tables can have NOT NULL bundle_id + added app_key). */
let cachedNoteLinkMode = null;

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

function getDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'proactive-recall.db');
  db = new Database(dbPath);
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
  `);

  migrateLegacy();
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
  }
  if (linkCols.includes('bundle_id')) {
    database.exec("UPDATE note_app_links SET bundle_id = 'com.spotify.client' WHERE lower(bundle_id) = 'spotify'");
    database.exec(
      "UPDATE note_app_links SET bundle_id = 'com.apple.AppStore' WHERE lower(bundle_id) IN ('app store', 'appstore', 'mac app store')"
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

  const surfaceCols = database.pragma('table_info(note_surface_state)').map((c) => c.name);
  if (surfaceCols.includes('app_key')) {
    database.exec("UPDATE note_surface_state SET app_key = 'com.spotify.client' WHERE lower(app_key) = 'spotify'");
    database.exec(
      "UPDATE note_surface_state SET app_key = 'com.apple.AppStore' WHERE lower(app_key) IN ('app store', 'appstore', 'mac app store')"
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
    .prepare(`SELECT ${mode} AS k FROM note_app_links WHERE note_id = ? ORDER BY k ASC`)
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
      .prepare(`INSERT OR IGNORE INTO note_app_links (note_id, ${mode}) VALUES (?, ?)`)
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
      .prepare(`DELETE FROM note_app_links WHERE note_id = ? AND ${mode} = ?`)
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

module.exports = {
  createNote,
  updateNote,
  deleteNote,
  deleteNotes,
  completeNote,
  getNote,
  listRecent,
  searchNotes,
  listFolders,
  pruneEmptyFolders,
  getFolderDiagram,
  createFolder,
  setNoteFolder,
  linkNoteToApp,
  unlinkNoteFromApp,
  getLinksForNote,
  listNoteImages,
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
  snoozeNote,
  dismissNote,
};
