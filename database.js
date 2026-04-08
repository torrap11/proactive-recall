'use strict';

/**
 * database.js — SQLite schema and CRUD helpers for Proactive Recall.
 *
 * Uses better-sqlite3 (synchronous API).
 * Database stored in Electron userData directory as "proactive-recall.db".
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { app }  = require('electron');

let db;

function getDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'proactive-recall.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Folders ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Notes ──────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      title                TEXT NOT NULL DEFAULT '',
      content              TEXT NOT NULL DEFAULT '',
      folder_id            INTEGER REFERENCES folders(id),
      surface_disabled     INTEGER NOT NULL DEFAULT 0,
      surface_snoozed_until TEXT,
      last_surfaced_at     TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Note ↔ App links ───────────────────────────────────────────────────────
  // A note can be linked to one or more bundle IDs for proactive surfacing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_app_links (
      note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      bundle_id TEXT NOT NULL,
      PRIMARY KEY (note_id, bundle_id)
    )
  `);

  // Safe migrations (idempotent column additions)
  _migrate();

  return db;
}

function _migrate() {
  const cols = getDb().pragma('table_info(notes)').map(c => c.name);
  if (!cols.includes('deleted_at')) {
    getDb().exec('ALTER TABLE notes ADD COLUMN deleted_at TEXT');
  }
}

// ── Notes CRUD ────────────────────────────────────────────────────────────────

function getAllNotes(folderId) {
  if (folderId === 'trash') {
    return getDb()
      .prepare('SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all();
  }
  const active = 'deleted_at IS NULL';
  if (folderId === undefined || folderId === 'all') {
    return getDb().prepare(`SELECT * FROM notes WHERE ${active} ORDER BY updated_at DESC`).all();
  }
  if (folderId === null || folderId === 'unfiled') {
    return getDb()
      .prepare(`SELECT * FROM notes WHERE folder_id IS NULL AND ${active} ORDER BY updated_at DESC`)
      .all();
  }
  return getDb()
    .prepare(`SELECT * FROM notes WHERE folder_id = ? AND ${active} ORDER BY updated_at DESC`)
    .all(folderId);
}

function getNoteById(id) {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id);
}

function searchNotes(query) {
  const q = `%${(query || '').toLowerCase()}%`;
  return getDb()
    .prepare(`SELECT * FROM notes
              WHERE deleted_at IS NULL
                AND (lower(title) LIKE ? OR lower(content) LIKE ?)
              ORDER BY updated_at DESC`)
    .all(q, q);
}

function createNote({ title = '', content = '', folderId = null } = {}) {
  const stmt = getDb().prepare(
    'INSERT INTO notes (title, content, folder_id) VALUES (?, ?, ?)'
  );
  const result = stmt.run(title, content, folderId);
  return getNoteById(result.lastInsertRowid);
}

function updateNote(id, { title, content } = {}) {
  const note = getNoteById(id);
  if (!note) return null;
  const newTitle   = title   !== undefined ? title   : note.title;
  const newContent = content !== undefined ? content : note.content;
  getDb()
    .prepare("UPDATE notes SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newTitle, newContent, id);
  return getNoteById(id);
}

/** Move note to Recently deleted (soft delete). */
function moveNoteToTrash(id) {
  const note = getNoteById(id);
  if (!note || note.deleted_at) return false;
  getDb()
    .prepare("UPDATE notes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(id);
  return true;
}

/** Restore from Recently deleted. */
function restoreNote(id) {
  const note = getNoteById(id);
  if (!note || !note.deleted_at) return null;
  getDb()
    .prepare("UPDATE notes SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(id);
  return getNoteById(id);
}

/** Permanently remove (from trash only). */
function permanentDeleteNote(id) {
  const note = getNoteById(id);
  if (!note || !note.deleted_at) return false;
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
  return true;
}

/** @deprecated Use moveNoteToTrash — kept as alias for IPC/tools. */
function deleteNote(id) {
  return moveNoteToTrash(id);
}

function moveNoteToFolder(noteId, folderId) {
  getDb()
    .prepare("UPDATE notes SET folder_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(folderId ?? null, noteId);
  return getNoteById(noteId);
}

// ── Surface lifecycle ─────────────────────────────────────────────────────────

/** Mark note as auto-surfaced and snooze it for cooldown minutes. */
function markNoteSurfaced(id, cooldownMinutes = 30) {
  const until = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  getDb()
    .prepare(`UPDATE notes
              SET last_surfaced_at = datetime('now'),
                  surface_snoozed_until = ?,
                  updated_at = datetime('now')
              WHERE id = ?`)
    .run(until, id);
}

/** Snooze a note from auto-surfacing for N minutes. */
function snoozeNoteSurface(id, minutes = 30) {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  getDb()
    .prepare("UPDATE notes SET surface_snoozed_until = ?, updated_at = datetime('now') WHERE id = ?")
    .run(until, id);
}

/** Permanently disable auto-surfacing for this note. */
function disableNoteSurface(id) {
  getDb()
    .prepare("UPDATE notes SET surface_disabled = 1, surface_snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

/** Re-enable auto-surfacing for a note. */
function enableNoteSurface(id) {
  getDb()
    .prepare("UPDATE notes SET surface_disabled = 0, surface_snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

/** True if this note is eligible for automatic surfacing. */
function noteEligibleForSurface(note) {
  if (note.surface_disabled) return false;
  if (note.surface_snoozed_until) {
    const until = new Date(note.surface_snoozed_until);
    if (!isNaN(until.getTime()) && until > new Date()) return false;
  }
  return true;
}

// ── Note ↔ App links ──────────────────────────────────────────────────────────

function linkNoteToApp(noteId, bundleId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO note_app_links (note_id, bundle_id) VALUES (?, ?)')
    .run(noteId, bundleId);
}

function unlinkNoteFromApp(noteId, bundleId) {
  getDb()
    .prepare('DELETE FROM note_app_links WHERE note_id = ? AND bundle_id = ?')
    .run(noteId, bundleId);
}

function getLinkedBundleIds(noteId) {
  return getDb()
    .prepare('SELECT bundle_id FROM note_app_links WHERE note_id = ?')
    .all(noteId)
    .map(r => r.bundle_id);
}

function getNotesByBundleId(bundleId) {
  return getDb()
    .prepare(`SELECT n.* FROM notes n
              JOIN note_app_links l ON l.note_id = n.id
              WHERE l.bundle_id = ? AND n.deleted_at IS NULL
              ORDER BY n.updated_at DESC`)
    .all(bundleId);
}

/** Return all notes linked to ANY of the given bundle IDs. */
function getNotesByAnyBundleId(bundleIds) {
  if (!bundleIds || bundleIds.length === 0) return [];
  const placeholders = bundleIds.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT DISTINCT n.* FROM notes n
              JOIN note_app_links l ON l.note_id = n.id
              WHERE l.bundle_id IN (${placeholders}) AND n.deleted_at IS NULL
              ORDER BY n.updated_at DESC`)
    .all(...bundleIds);
}

// ── Folders CRUD ──────────────────────────────────────────────────────────────

function getAllFolders() {
  return getDb().prepare('SELECT * FROM folders ORDER BY name ASC').all();
}

function getFolderById(id) {
  return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

function createFolder({ name }) {
  const stmt = getDb().prepare('INSERT INTO folders (name) VALUES (?)');
  const result = stmt.run(name);
  return getFolderById(result.lastInsertRowid);
}

function updateFolder(id, { name }) {
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
  return getFolderById(id);
}

function deleteFolder(id) {
  getDb()
    .prepare("UPDATE notes SET folder_id = NULL, updated_at = datetime('now') WHERE folder_id = ? AND deleted_at IS NULL")
    .run(id);
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id);
}

module.exports = {
  getAllNotes, getNoteById, searchNotes, createNote, updateNote, deleteNote, moveNoteToTrash, restoreNote, permanentDeleteNote, moveNoteToFolder,
  markNoteSurfaced, snoozeNoteSurface, disableNoteSurface, enableNoteSurface, noteEligibleForSurface,
  linkNoteToApp, unlinkNoteFromApp, getLinkedBundleIds, getNotesByBundleId, getNotesByAnyBundleId,
  getAllFolders, getFolderById, createFolder, updateFolder, deleteFolder,
};
