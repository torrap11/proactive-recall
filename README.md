# Proactive Recall

Proactive Recall is a local-first macOS desktop notes app built with Electron. It watches your frontmost app and surfaces contextually relevant notes, so useful information appears when you need it.

## Features

- Local-first note storage with SQLite (`better-sqlite3`)
- Proactive note surfacing based on current/frontmost app
- Overlay UI for surfaced notes
- Capture flow for quickly saving notes
- Interactive folder dashboard (click folders in the diagram to filter the notes list)
- Prompt-based “view organization” (changes how the notes list is displayed; folder diagram remains in sync)
- Prompt filters/sorts for phrases like “today” and “last hour” (UI hides the date when all results are from the same day)
- Keyboard navigation in the notes list (arrow keys move selection; Enter opens a note)
- AI-assisted folder organization tools (configured via environment/API key)
- macOS packaging, signing, and notarization support

## Tech Stack

- Electron
- Node.js
- SQLite (`better-sqlite3`)
- Electron Builder

## Project Structure

- `app-main.js` - Electron main process entrypoint
- `preload.js` - Main window preload bridge
- `database.js` - Local data/storage layer
- `appWatcher.js` - Frontmost app detection/polling
- `surfaceEngine.js` - Surfacing logic/cooldown behavior
- `noteAppScan.js` - Note content scanning/matching
- `knownApps.js` - Known app metadata/mappings
- `renderer/` - Main app UI and capture view
- `overlay/` - Surfacing overlay window UI
- `tests/` - Node test suite
- `build/` - Build/signing assets
- `scripts/notarize.js` - macOS notarization script

## Requirements

- macOS
- Node.js 18+ (recommended)
- npm

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment:

   ```bash
   cp .env.example .env
   ```

   Then set at minimum:

   - `ANTHROPIC_API_KEY`

3. Start the app:

   ```bash
   npm start
   ```

## Configuration

You can configure behavior through `.env` (or the app settings panel), including:

- `PROACTIVE_RECALL_MODEL`
- `PROACTIVE_RECALL_SURFACING`
- `PROACTIVE_RECALL_POLL_MS`
- `PROACTIVE_RECALL_COOLDOWN_MIN`
- `PROACTIVE_RECALL_DISMISS_MS`

See `.env.example` for the full template.

## Scripts

- `npm start` - Run app in development
- `npm test` - Run tests (`node --test tests/*.js`)
- `npm run rebuild` - Rebuild native modules
- `npm run dist` - Build macOS arm64 distribution
- `npm run dist:universal` - Build macOS universal distribution
- `npm run dist:signed` - Build signed macOS distribution

## Downloadable Builds (macOS)

`electron-builder` writes distributable artifacts to `dist/`.

After running `npm run dist:universal`, you should find:
- `dist/Proactive Recall-<version>-universal.dmg`
- `dist/Proactive Recall-<version>-universal-mac.zip`

## Build and Release (macOS)

- Build configuration is in `package.json` under `build`
- Entitlements are in `build/entitlements.mac.plist`
- Notarization hook is `scripts/notarize.js`

## Security Notes

- Never commit real secrets in `.env` or config files.
- Keep API keys local and private.

## License

MIT
