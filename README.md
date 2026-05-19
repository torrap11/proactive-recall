# Jot

Jot is a local-first proactive memory layer for macOS. It watches workflow context (frontmost app) and resurfaces the most relevant notes in a corner overlay when you switch apps. Notes and attachments stay on disk (SQLite); optional Anthropic-powered helpers can organize folders or suggest what to do from your notes after you add an API key.

**[Jot Launch](https://github.com/parthha12/jot/releases/tag/jot-launch)** — Named source milestone for v2 (app **2.0.0**). The [`jot-launch`](https://github.com/parthha12/jot/releases/tag/jot-launch) tag points at the fork-ready `main` snapshot (MIT `LICENSE`, contributor hygiene). Installable macOS builds: **[Releases](https://github.com/parthha12/jot/releases/latest)** (`Jot-2.0.0.dmg`).

**Shortcuts:** ⌘P (⌃P) opens search from anywhere. ⌘N (⌃N) opens capture from anywhere. In capture, type a workflow like `remind me to … when i open Cursor` and press Enter to save and link to that app.

**Demo:** [Jot walkthrough on YouTube](https://www.youtube.com/watch?v=8iutF9J1JHI)

## Tech Stack

- Electron
- Node.js
- SQLite (`better-sqlite3`)
- Electron Builder

## Install

**macOS (Apple Silicon + Intel)** — universal `.dmg` from the **[latest release](https://github.com/parthha12/jot/releases/latest)**.

1. Download `Jot-2.0.0.dmg`, open it, drag **Jot** into **Applications**.
2. The first launch needs one extra step (this build is ad‑hoc signed, not yet notarized). Open Terminal and run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Jot.app
   ```

3. Open Jot from Applications. Done — macOS won't warn again.

Don't want to use Terminal? See the **[full install guide](INSTALL.md)** for a no‑terminal path via System Settings, plus troubleshooting.

> A fully notarized build (zero extra steps) is on the roadmap — see [`docs/release-signing.md`](docs/release-signing.md).

**Forks:** Download and release links in this repo point at the canonical GitHub project. After you fork, search for `github.com/parthha12/jot` in `README.md`, `INSTALL.md`, and `docs/` and replace those URLs if you ship your own releases.

## Docs

- **[Purpose, stack, infra, and functionality](docs/jot-overview.md)** — start here for what Jot is and how it is built/shipped
- **[Technical deep dive](docs/repository-summary.md)** — architecture, modules, data model

## Getting Started

```bash
npm install
npm start
```

## Scripts

- `npm start` - Run app in development
- `npm test` - Run tests (`node --test tests/*.js`)
- `npm run rebuild` - Rebuild native modules
- `npm run clean:dist` - Delete `dist/` (build artifacts only; safe to run anytime)
- `npm run dist` - Build macOS arm64 distribution (ad‑hoc signed)
- `npm run dist:universal` - Build macOS universal distribution (ad‑hoc signed)
- `npm run dist:signed` - Build signed macOS distribution (requires Developer ID)
- `npm run dist:notarized` - Build signed + notarized macOS distribution (requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
