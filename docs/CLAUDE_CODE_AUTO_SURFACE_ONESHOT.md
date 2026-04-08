# Claude Code — one-shot: auto-detect app links from note text

Use this document as the **single task specification**. Implement everything below on branch **`feature/auto-surface-from-notes`** in the **proactive-recall** repository. If `main` has moved ahead, rebase or merge as needed, but ship the feature on this branch.

---

## Goal (one sentence)

Users can still **manually** link notes to apps for proactive surfacing; the app should also **scan each note’s title and body** (local, deterministic) and **add matching app bundle IDs** automatically, with clear UI and user control so false positives are manageable.

---

## Non-goals (do not implement)

- **No LLM / API calls** for detection in this milestone. Matching must be **rule-based** (keywords, aliases, word boundaries). Optional future: a separate “AI suggest links” feature is out of scope here.
- **No screen capture, window titles, or contacts** — surfacing trigger stays **frontmost app only**, as today.
- **No new cloud sync** or background network jobs.

---

## Current behavior (do not break)

- **`note_app_links`** stores `(note_id, bundle_id)`; `surfaceEngine.getEligibleNotes` queries linked notes when the frontmost app changes.
- Renderer **`KNOWN_APPS`** + modal + custom bundle ID = **manual** links.
- Snooze, cooldown, **Don’t surface** (`surface_disabled`), and trash flows must keep working.

---

## Functional requirements

### 1. Automatic detection

- After **note title or content changes are saved** (reuse existing autosave path), run a **pure function** over `title + '\n' + content` that returns a set of **bundle IDs** to consider for auto-linking.
- Use a **single shared catalog** of apps: same bundle IDs as **`KNOWN_APPS` / `APP_NAME_TO_BUNDLE_ID`** (consider extracting one module, e.g. `knownApps.js`, imported by `surfaceEngine.js`, renderer bundling via duplication acceptable if you document it — **prefer one shared Node module** required from main + tests, and expose catalog to renderer via a small IPC `get-known-apps-catalog` **or** generate a minimal JSON at build time — **simplest acceptable**: duplicate the alias map in one new file `noteAppScan.js` used only in main process on save, and keep renderer list in sync manually with a comment — **better**: shared `knownApps.js` at repo root required by `main.js` / `surfaceEngine.js` / `noteAppScan.js` and **preload exposes read-only list for UI** if needed).

- Matching rules (minimum bar):
  - **Case-insensitive** search over normalized text (collapse whitespace; optional: strip simple punctuation for matching).
  - **Whole-word or clear delimiter** for short tokens (e.g. `imessage`, `slack`) to reduce false positives; longer phrases (e.g. `Microsoft Teams`) can use substring with boundaries.
  - For each known app, support **aliases** beyond display name, e.g. `iMessage`, `SMS`, `texts` → `com.apple.MobileSMS`; `WA` alone is too ambiguous — skip or require `WhatsApp` / `whatsapp`.
- **Idempotent**: running the scanner twice on the same text must not create duplicate rows.

### 2. Manual vs automatic links in the data model

- Extend persistence so each link knows its **source**:
  - **`manual`** — user (or assistant tool) added via existing flows.
  - **`auto`** — added by the scanner.
- Migration strategy (pick one, document in code comments):
  - **Preferred:** add column `source TEXT NOT NULL DEFAULT 'manual'` to `note_app_links` with `CHECK(source IN ('manual','auto'))`, backfill existing rows as `'manual'`.
  - Primary key may need to change from `(note_id, bundle_id)` to **`(note_id, bundle_id, source)`** *or* keep unique `(note_id, bundle_id)` and **upgrade** duplicate semantics: at most one row per pair — store source as **`manual` if either manual or both** (if user linked manually, row is manual). Simpler unique approach: **one row per pair**, column `source` = `'manual'` if user ever linked that bundle for that note, else `'auto'`. When user **removes** a link, delete the row; scanner may re-add as `auto` unless suppressed (see dismissals).

- **User dismissals (important):** If the user **removes an auto-suggested** link, the scanner must **not immediately re-add** it on the next save. Persist **`note_auto_link_dismissals`** (e.g. `(note_id, bundle_id)` primary key) or a JSON column on `notes`. Cleaner: separate table `note_app_link_dismissals (note_id, bundle_id, PRIMARY KEY)`.

### 3. When to run the scanner

- Run **after successful save** of note title/content in the main process (IPC handler that already persists the note), **debounced** per note id (e.g. 400–800ms coalesced saves) to avoid SQLite thrash.
- On **first load / migration**, optionally one-time scan all non-deleted notes — **nice-to-have**; minimum is **on save only**.

### 4. UI / UX

- In the note editor **“Surface when app is active”** section:
  - Show **all** linked bundle IDs (manual + auto).
  - **Visually distinguish** auto vs manual (e.g. chip style, `A` badge, or subtitle “from text”).
  - **Removing** a chip calls existing unlink path; if it was auto, record **dismissal** so scanner stops re-adding.
  - **Manual add** flow unchanged; manual link should set source **manual** and **override** dismissal for that bundle if you want the user’s explicit choice to win — spec: **manual link clears dismissal for that `(note_id, bundle_id)`**.

### 5. Settings

- Add a **global toggle** in Settings: **“Suggest app links from note text”** (default **on** or **off** — pick one and justify in README; recommend **on** for discoverability with easy dismiss).
- When off, **do not** add new `auto` links; existing auto links can remain until user removes them, or you may offer “Remove all auto links” — **optional**; minimum is stop adding new ones.

### 6. Assistant tools

- Extend **`link_note_to_app` / `unlink_note_to_app` / `get_note`** behavior so tools use **`manual`** source.
- Add tool **`scan_note_app_links`** or **`refresh_note_app_links`** (optional) that re-runs the scanner for a given `note_id` — helpful for assistant-driven workflows; if added, must respect global toggle and dismissals.

### 7. Tests

- **Unit tests** for the scanner: given title/body strings, expect exact bundle ID sets (include false-positive guards, dismissal behavior, manual precedence).
- Update **`test-assistant-tools.js`** if DB contract changes.
- **`test-surface-engine.js`**: ensure eligible notes still resolve if links come from either source (query should not filter by `source` — a link is a link).

### 8. Documentation

- Update **`README.md`**: describe auto-detection, toggle, dismiss behavior, and that matching is **local keyword-based** (not “reading your screen”).
- Update **`/help`** text in **`renderer.js`** if you add a shortcut for toggling the new setting (optional).

---

## Files you will likely touch

- `database.js` — migration, link insert/delete with source, dismissals table, getters.
- New module e.g. **`noteAppScan.js`** — `detectBundleIdsFromText(title, content, catalog)`.
- `main.js` — hook scanner after note update (debounced), IPC for config toggle.
- `config.js` / Settings UI — persist `autoAppLinkFromText` (or similar key).
- `renderer/renderer.js` + `renderer/index.html` + `renderer/style.css` — chips, toggle.
- `preload.js` — any new IPC.
- `surfaceEngine.js` / `main.js` queries — ensure `getNotesByAnyBundleId` / link queries **include both sources**.
- `assistant.js` — tool updates.
- `tests/*` — new + updated tests.

---

## Acceptance checklist

- [ ] Manual linking still works; surfaced notes behave as before.
- [ ] Typing e.g. “Discuss on **Slack** with the team” in a note (after save) adds **`com.tinyspeck.slackmacgap`** as an **auto** link (with toggle on).
- [ ] User removes that auto chip → link gone and **not** re-added on further saves unless user manually links or clears dismissal (per your spec above).
- [ ] Global toggle off → no new auto links.
- [ ] No API keys or network required for detection.
- [ ] README + tests updated.

---

## Execution guidance

- Land **small, reviewable commits** on `feature/auto-surface-from-notes` if the user prefers history; otherwise one commit is fine for a true oneshot.
- After implementation, run **`npm test`** and **`npm start`** on macOS and sanity-check save → chip appears → dismiss → save again.

When finished, summarize behavior, config keys, and any **known limitations** (e.g. ambiguous words, English-centric aliases).
