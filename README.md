# Jot

Jot is a local-first proactive memory layer for macOS. It watches workflow context (frontmost app) and resurfaces the most relevant notes exactly when needed.

## Shortcut

- `Cmd/Ctrl + Shift + D` triggers the showcase overlay flow.

## Tech Stack

- Electron
- Node.js
- SQLite (`better-sqlite3`)
- Electron Builder

## Download

**macOS (Apple Silicon + Intel):** get the universal `.dmg` from **[Latest release](https://github.com/parthha12/jot/releases/latest)** (matches the **`main`** branch).

## Getting Started

```bash
npm install
npm start
```

## Scripts

- `npm start` - Run app in development
- `npm test` - Run tests (`node --test tests/*.js`)
- `npm run rebuild` - Rebuild native modules
- `npm run dist` - Build macOS arm64 distribution
- `npm run dist:universal` - Build macOS universal distribution
- `npm run dist:signed` - Build signed macOS distribution
