# Jot

Jot is a local-first proactive memory layer for macOS. It watches workflow context (frontmost app) and resurfaces the most relevant notes exactly when needed.

## Demo-Ready Workflows

### 1) Software Engineer Flow (30s)

Trigger: open VS Code / Cursor / coding context.

What appears automatically:
- architecture notes
- bug reminders
- implementation TODOs
- API migration context

How to show it:
1. Click `Start Demo Mode`.
2. Click `Engineer Flow`.
3. Overlay pops instantly with coding memory cards.
4. Click `Open` to jump into the full note editor.

### 2) Meeting / Sales Flow (30s)

Trigger: open Zoom / meeting context.

What appears automatically:
- agenda and prep notes
- prior summaries and follow-ups
- participant-linked context cards

How to show it:
1. Click `Meeting Flow`.
2. Overlay shows meeting prep cards.
3. Use quick capture row to add a meeting note + participant in one action.
4. Open note and show participant tags in the editor.

## One-Click Demo Mode

- UI button: `Start Demo Mode`
- Keyboard: `Cmd/Ctrl + Shift + D` cycles seeded demo scenes
- CLI command:

```bash
npm run demo:start
```

This seeds realistic demo data, enables a polished context overlay flow, and opens with immediate showcase value.

## YC Demo Script (Suggested)

Use this exact sequence:

1. "Jot removes manual memory recall during work."
2. Click `Start Demo Mode`.
3. Click `Engineer Flow` and show coding context cards.
4. Click `Meeting Flow` and show prep notes + participant context.
5. Add a quick meeting note in the capture row to demonstrate zero-friction in-call memory capture.
6. Close with: "You no longer search for memory. Memory appears when context changes."

## Why this implementation

Before implementation, we reviewed mature ecosystem options:
- onboarding/tour: Shepherd / TourGuide JS
- animation: Motion One
- positioning: Floating UI
- command palette: electron-command-palette

For this demo branch, we intentionally kept the existing Electron architecture and used native CSS/JS transitions to reduce integration risk and maximize recording stability.

## Tech Stack

- Electron
- Node.js
- SQLite (`better-sqlite3`)
- Electron Builder

## Getting Started

```bash
npm install
npm start
```

## Scripts

- `npm start` - Run app in development
- `npm run demo:start` - Run with auto demo mode enabled
- `npm test` - Run tests (`node --test tests/*.js`)
- `npm run rebuild` - Rebuild native modules
- `npm run dist` - Build macOS arm64 distribution
- `npm run dist:universal` - Build macOS universal distribution
- `npm run dist:signed` - Build signed macOS distribution
