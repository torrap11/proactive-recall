# Jot — overview

This document is the **single place** to understand what Jot is for, what it does today, what it is built with, and how it is run, packaged, and hosted (there is no server — “infra” here means your machine, build pipeline, and third-party services you opt into).

For module-by-module architecture and file reading order, see [repository-summary.md](./repository-summary.md).

---

## Purpose

Jot is a **local-first proactive memory layer for macOS**. It is meant for people who live in many apps and want **the right note to appear when context changes** (e.g. you switch to Slack, Zoom, or an IDE), instead of always searching manually.

Design goals reflected in the current app:

- **Fast capture** and **lightweight search**
- **Ties notes to workflow** (which app you were in or care about)
- **Surfaces notes automatically** when the frontmost app matches links or keywords
- **Keeps data on the device** by default; **optional** cloud AI only when you add an API key

---

## Functionality (what the app does today)

| Area | Behavior |
|------|----------|
| **Notes** | Create, edit, delete, mark complete; single main `text` field; folders; search and recents |
| **App context** | Link notes to macOS apps (bundle IDs); optional keyword matching from note text |
| **Surfacing** | Polls frontmost app (~1.5s); ranks candidates; shows up to **3** notes in a **corner overlay**; snooze, dismiss, open in main UI, mark done |
| **Capture** | Dedicated capture window; shorthand `remind me this: … when i open this <app>` to set body + app link |
| **Attachments** | Images (paste/pick) and a **small whitelist** of file types (e.g. pdf, md, txt) stored under app user data |
| **Meetings** | Quick-capture can create a `[Meeting]` note, optional participant tag, auto-link to Zoom |
| **AI (optional)** | With an Anthropic key: **organize** chat (suggest folder moves + apply plan) and **night** chat (suggest a few actions from your notes). No account; keys stored in app user data |
| **Data portability** | Import/export SQLite DB from the app menu; dedupe helper |
| **Shortcuts** | **⌘P** (⌃P) opens **search globally**; **⌘N** (⌃N) opens **capture globally** |

macOS **Automation** permission is required for reading the frontmost app (System Events). The app does not scrape URLs, screen, or use OCR for context.

---

## Current stack

| Layer | Technology |
|-------|------------|
| **Desktop shell** | Electron (multi-window: search, capture, overlay) |
| **Runtime** | Node.js (main process + preload scripts) |
| **UI** | HTML/CSS/JS in `renderer/` and `overlay/` |
| **Database** | SQLite via `better-sqlite3` |
| **Native rebuild** | `@electron/rebuild` for `better-sqlite3` against Electron’s Node ABI |
| **Packaging** | `electron-builder` → macOS `.dmg` and `.zip` (arm64 and universal targets in `package.json`) |
| **Release hardening** | Hardened runtime, entitlements plist, **`@electron/notarize`** (`scripts/notarize.js`) when signing |
| **Optional AI** | HTTPS calls to **Anthropic Messages API** from main process (`aiOrganize.js`) |

There is **no** separate backend service, sync service, or mobile app in this repo.

---

## Infrastructure and operations

### Local development

- **Install:** `npm install`
- **Run:** `npm start` (Electron loads the project root as the app)
- **Tests:** `npm test` (Node built-in test runner, files under `tests/`)
- **Native module issues:** `npm run rebuild`

### Builds and distribution

- **Artifacts:** Produced locally (or on a release machine) via `npm run dist`, `dist:universal`, or `dist:signed`
- **Distribution channel:** GitHub **Releases** (see project `README.md`); there is **no** managed cloud “infra” for the app runtime
- **Signing / notarization:** Configured for Apple **Developer ID** flows in `package.json` + `scripts/notarize.js`; requires Apple credentials in the environment when you run signed builds

### Where data lives (on the user’s Mac)

- **SQLite database:** Electron **userData** directory (path resolved in `database.js`; differs dev vs packaged — see [packaged-app-data-mismatch.md](./packaged-app-data-mismatch.md) if you ship or migrate data)
- **Attachments:** Subfolders under the same user data root (`note-images`, `note-files`)
- **AI / secrets:** `ANTHROPIC_API_KEY` (and optional `PROACTIVE_RECALL_MODEL`) in **userData `.env`**, typically set through the in-app key UI — not from the repo’s environment

### External dependencies (runtime)

| Dependency | Required? | Role |
|------------|-----------|------|
| **Anthropic API** | No | Optional organize + night assistants |
| **Apple notarization APIs** | Only when releasing signed builds | Notarization step |

### CI / automation

There is **no** checked-in GitHub Actions (or similar) CI config in this repository by default; quality gates are local (`npm test`) unless you add automation elsewhere.

---

## Related docs

- **[repository-summary.md](./repository-summary.md)** — architecture, main modules, data model, product flows, security notes, suggested file reading order
- **[packaged-app-data-mismatch.md](./packaged-app-data-mismatch.md)** — dev vs packaged database paths
- **Root [README.md](../README.md)** — quick start and download pointer
