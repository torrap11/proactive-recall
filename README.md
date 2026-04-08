# Proactive Recall

A local-first desktop notes app for macOS that **proactively surfaces relevant notes** when you switch to configured apps — no screen capture, no cloud, no subscriptions.

---

## Features

- **Notes + folders** — create, edit, delete notes; organise into folders; full-text search
- **Keyboard-first** — global shortcut to show/hide; in-app shortcuts for all common actions
- **Proactive surfacing** — notes can be linked to macOS apps by bundle ID; when you switch into that app, a non-intrusive overlay appears with your linked notes
- **AI assistant** — in-app text chat powered by Claude (Anthropic); closed tool set limited to your own notes and folders, no web browsing
- **Local data** — SQLite database stored in your macOS user data directory; nothing leaves your machine except API calls to Anthropic when you use the AI assistant

---

## Setup

### 1. Prerequisites

- **Node.js** ≥ 18
- **macOS** (proactive surfacing requires macOS; notes/AI work cross-platform)

### 2. Clone and install

```bash
git clone <repo-url> proactive-recall
cd proactive-recall
npm install
npm run rebuild   # rebuild native module (better-sqlite3) for Electron
```

### 3. Configure API key

**Option A — Settings panel (recommended):**
Open the app, click **⚙ Settings** in the sidebar, paste your [Anthropic API key](https://console.anthropic.com/), click **Save API Key**.

**Option B — Environment variable:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

**Option C — Config file:**
Create `~/Library/Application Support/Proactive Recall/config.json`:
```json
{
  "anthropicApiKey": "sk-ant-..."
}
```

The AI assistant is optional — notes and surfacing work without an API key.

### 4. Run

```bash
npm start
```

### 5. macOS permissions

On first launch, macOS will prompt for **Automation / Accessibility** access so the app can read which app is frontmost via System Events. Approve the prompt, or grant it manually:

> System Preferences → Privacy & Security → Privacy → Automation  
> Enable: **Proactive Recall → System Events**

If you decline, notes and AI still work; proactive surfacing is silently disabled until permission is granted.

---

## Keyboard shortcuts

### Global (works from any app)

| Shortcut | Action |
|---|---|
| `⌘⇧P` | Show / hide Proactive Recall window |

### In-app

| Shortcut | Action |
|---|---|
| `⌘N` | New note |
| `⌘⇧N` | New folder (sidebar modal; also **Notes → New Folder**) |
| `⌘⇧F` | Focus search |
| `⌘⇧A` | Toggle AI assistant panel (works from anywhere in the window; also under **Notes** in the menu bar) |
| `⌘↵` | Send AI message |
| `↑` / `↓` | Move through the notes list (opens each note; disabled while focus is in the note body, search, or AI field) |
| `Escape` | Close modal / dismiss; **when editing a note**, save and return to the list (selection stays on that note) |
| `Delete` / `Backspace` | Move the selected note to **Recently deleted** (not while typing in the note title/body, search, or AI; disabled in Recently deleted) |

**Recently deleted** — Sidebar → 🗑 Recently deleted. Restore a note from the banner buttons, or **Delete forever** to remove it permanently. The main **🗑** toolbar button moves active notes to Recently deleted (with confirmation); in Recently deleted it erases permanently (with confirmation).

---

## Linking notes to apps (proactive surfacing)

1. Open a note in the editor
2. In the **"Surface when app is active"** section at the bottom, click **＋ Add app**
3. Choose from the list of known apps (Messages, WhatsApp, Slack, etc.) or enter a custom bundle ID
4. When you switch into that app on macOS, the note appears in a small overlay at the bottom-right corner

### Overlay actions

- **Open** — brings Proactive Recall to focus and opens the note
- **Snooze 30m** — hide this note from the overlay for 30 minutes
- **Don't surface** — permanently remove this note from auto-surfacing (you can re-enable in the note's settings later)

The overlay auto-dismisses after 10 seconds if not interacted with.

### Cooldown

The same note will not be re-surfaced within 30 minutes (configurable in Settings). Switching in and out of an app rapidly will not spam you.

### Surfacing toggle

Settings → **Proactive Surfacing** toggle switches the entire feature on or off.

---

## AI assistant

The chat panel is **open by default** so you can use it even when no note is selected. Click **✦ AI** in the top bar of the main column, press **`⌘⇧A`**, or use **Notes → Toggle AI Assistant** to show or hide it.

In chat, send **`/help`** or **`/shortcuts`** to print keyboard shortcuts locally (no API key or network call).

The assistant can:
- Search and list your notes
- Read note content
- Create, update, and delete notes
- Create and manage folders
- Move notes between folders
- Link or unlink notes to apps

The assistant **cannot** browse the web, fetch URLs, or access any data outside your notes library. If you ask about something not in your notes, it will say so.

**Model:** `claude-sonnet-4-6` by default. Change in Settings.

---

## How proactive surfacing works (technical)

1. A background loop polls the macOS frontmost application every 1.5 seconds via AppleScript (`System Events`)
2. When the frontmost app changes, the app resolves candidate bundle IDs (reported bundle ID + stable app-name fallback for known apps)
3. The database is queried for notes linked to any of those bundle IDs
4. Notes that are not snoozed and not permanently disabled are surfaced in an overlay window
5. After surfacing, each note is auto-snoozed for the configured cooldown period (default 30 min)

**What is NOT used:** screen recording, OCR, vision APIs, window title parsing, per-contact or per-thread detection.

---

## Data storage

| What | Where |
|---|---|
| SQLite database | `~/Library/Application Support/Proactive Recall/proactive-recall.db` |
| Config (if saved via UI) | `~/Library/Application Support/Proactive Recall/config.json` |

---

## Building a distributable

```bash
npm run dist
```

Output in `dist/`. Requires [electron-builder](https://www.electron.build).

---

## Running tests

```bash
npm test
```

Tests cover: surface engine matching, cooldown logic, app name fallbacks, and all AI tool contracts.

---

## Non-goals (v1)

- Voice input / dictation / TTS
- Web search or arbitrary URL fetching in the AI assistant
- Screen recording, OCR, or vision APIs
- Per-contact or per-thread detection (only which app is frontmost)
- Cloud sync or multi-device

---

## Known limitations

- Proactive surfacing requires **macOS** and the Automation permission for System Events
- Some apps (especially sandboxed Mac App Store apps) may not report a bundle ID via System Events; use the stable app-name mapping or enter the bundle ID manually
- The overlay positions at the bottom-right of the primary display; multiple-monitor layouts may need adjustment in a future release
- The AI assistant requires an internet connection to reach Anthropic's API; notes and surfacing work fully offline
