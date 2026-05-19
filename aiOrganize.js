'use strict';

const fs = require('fs');
const path = require('path');
const { parseRemindWorkflowText } = require('./remindWorkflowParser');

/** Parse a dotenv file into a plain object (no process.env mutation). */
function parseEnvFile(filePath) {
  const env = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key) env[key] = val;
    }
  } catch {
    // Missing or unreadable file
  }
  return env;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Anthropic credentials come only from the app userData .env (e.g. set via in-app API Key).
 * Repo, cwd, and shell process.env are intentionally ignored so installs do not pick up dev keys.
 */
function readAnthropicCredentials(userDataDir) {
  if (!userDataDir) return { apiKey: '', model: DEFAULT_MODEL };
  const fileEnv = parseEnvFile(path.join(userDataDir, '.env'));
  const apiKey = String(fileEnv.ANTHROPIC_API_KEY || '').trim();
  const model = String(fileEnv.PROACTIVE_RECALL_MODEL || '').trim() || DEFAULT_MODEL;
  return { apiKey, model };
}

function buildOrganizeSnapshot(database) {
  const folders = database.listFolders();
  const notes = database.listRecent(500, 'all').map((n) => ({
    id: n.id,
    preview: String(n.text || '').split('\n')[0].slice(0, 280),
    folderId: n.folder_id ?? null,
  }));
  return { folders, notes };
}

const ORGANIZE_SYSTEM = `You help organize notes into folders for the app "Jot".
The user sends a JSON snapshot: "folders" [{id, name}] and "notes" [{id, preview, folderId}].

Reply with a single JSON object only (no markdown fences). Shape:
{"reply":"<string — short explanation for the user>","plan":[...]}

"plan" is an array of operations in execution order. Put all createFolder steps before moveNote steps that use new folder names.

Allowed operations:
- {"op":"createFolder","name":"<string>"}
- {"op":"moveNote","noteId":<number>,"folderId":<number>} — use an id from snapshot.folders
- {"op":"moveNote","noteId":<number>,"folderName":"<string>"} — name must match a folder you created earlier in plan or an existing folder name
- {"op":"moveNote","noteId":<number>,"unfiled":true}

Use only note ids from the snapshot. If the user only chats or asks questions, use "plan": [].
Keep "reply" concise.`;

function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model response');
  return JSON.parse(body.slice(start, end + 1));
}

async function callAnthropic({ apiKey, model, system, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || data.message || res.statusText;
    throw new Error(msg || `Anthropic API error ${res.status}`);
  }
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

async function organizeChat(database, { history, userMessage, userDataDir }) {
  const { apiKey, model } = readAnthropicCredentials(userDataDir);
  if (!apiKey) {
    return {
      error:
        'No API key configured. Click "API Key" in the toolbar (or "Set API Key" in the AI panel), paste your Anthropic key, and save. Keys in the project folder are not used.',
    };
  }
  const snapshot = buildOrganizeSnapshot(database);
  const trimmedHistory = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-8)
    .map((m) => ({ role: m.role, content: String(m.content || '') }));
  const payload = `${userMessage}\n\n--- current workspace (JSON) ---\n${JSON.stringify(snapshot)}`;
  const messages = [...trimmedHistory, { role: 'user', content: payload }];
  const text = await callAnthropic({
    apiKey,
    model,
    system: ORGANIZE_SYSTEM,
    messages,
  });
  let parsed;
  try {
    parsed = extractJsonObject(text);
  } catch (e) {
    return { error: `Could not parse AI response: ${e.message}`, raw: text };
  }
  if (parsed.reply == null) {
    return { error: 'Invalid response shape (missing reply)', raw: text };
  }
  const plan = Array.isArray(parsed.plan) ? parsed.plan : [];
  return { reply: String(parsed.reply), plan, raw: text };
}

function sortPlan(plan) {
  const list = Array.isArray(plan) ? plan : [];
  const creates = list.filter((p) => p && p.op === 'createFolder');
  const moves = list.filter((p) => p && p.op === 'moveNote');
  return [...creates, ...moves];
}

function applyOrganizePlan(database, plan) {
  const sorted = sortPlan(plan);
  const noteRows = database.listRecent(10000, 'all');
  const validNoteIds = new Set(noteRows.map((n) => n.id));
  const applied = [];
  const errors = [];

  let folders = database.listFolders();

  for (const step of sorted) {
    if (step.op === 'createFolder') {
      const name = String(step.name || '').trim();
      if (!name) {
        errors.push('createFolder: empty name');
        continue;
      }
      const exists = folders.some((f) => f.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        applied.push({ op: 'createFolder', name, skipped: true });
        continue;
      }
      const created = database.createFolder(name);
      if (created) {
        folders = database.listFolders();
        applied.push({ op: 'createFolder', id: created.id, name: created.name });
      } else {
        errors.push(`createFolder: failed for "${name}" (duplicate name?)`);
      }
      continue;
    }
    if (step.op === 'moveNote') {
      const noteId = Number(step.noteId);
      if (!Number.isFinite(noteId) || !validNoteIds.has(noteId)) {
        errors.push(`moveNote: invalid noteId ${step.noteId}`);
        continue;
      }
      if (step.unfiled === true) {
        database.setNoteFolder(noteId, 'unfiled');
        applied.push({ op: 'moveNote', noteId, unfiled: true });
        continue;
      }
      const folderIdRaw = step.folderId;
      if (folderIdRaw != null && folderIdRaw !== '') {
        const folderId = Number(folderIdRaw);
        if (!Number.isFinite(folderId)) {
          errors.push(`moveNote: invalid folderId for note ${noteId}`);
          continue;
        }
        folders = database.listFolders();
        const exists = folders.some((f) => f.id === folderId);
        if (!exists) {
          errors.push(`moveNote: folderId ${folderId} not found`);
          continue;
        }
        database.setNoteFolder(noteId, folderId);
        applied.push({ op: 'moveNote', noteId, folderId });
        continue;
      }
      const folderName = String(step.folderName || '').trim();
      if (folderName) {
        folders = database.listFolders();
        const hit = folders.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
        if (!hit) {
          errors.push(`moveNote: folderName "${folderName}" not found`);
          continue;
        }
        database.setNoteFolder(noteId, hit.id);
        applied.push({ op: 'moveNote', noteId, folderId: hit.id, folderName });
        continue;
      }
      errors.push(`moveNote: missing target for note ${noteId}`);
    }
  }
  return { applied, errors };
}

const WORKFLOW_SYSTEM = `You convert natural-language workflows for Jot (a macOS proactive memory app) into a reminder that surfaces when the user opens a specific app.

Reply with a single JSON object only (no markdown fences). Shape:
{"reminderText":"<what to remember or do>","appQuery":"<short macOS app name>"}

appQuery examples: Cursor, Slack, Safari, Zoom, Mail, VS Code.

If the user describes surfacing or reminding on app open, extract the task and app even if phrasing is informal.

If you cannot determine both fields, use: {"error":"<short reason>"}`;

async function interpretRemindWorkflow(userDataDir, rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { error: 'Empty workflow.' };

  const local = parseRemindWorkflowText(trimmed);
  if (local) return local;

  const { apiKey, model } = readAnthropicCredentials(userDataDir);
  if (!apiKey) {
    return {
      error:
        'Use “remind me to … when i open <App>”, or add an Anthropic API key (toolbar) so Jot can interpret free-form workflows.',
    };
  }

  let parsed;
  try {
    const text = await callAnthropic({
      apiKey,
      model,
      system: WORKFLOW_SYSTEM,
      messages: [{ role: 'user', content: trimmed }],
    });
    parsed = extractJsonObject(text);
  } catch (e) {
    return { error: e.message || String(e) };
  }

  if (parsed.error) return { error: String(parsed.error) };

  const reminderText = String(parsed.reminderText || '').trim();
  const appQuery = String(parsed.appQuery || '').trim();
  if (!reminderText || !appQuery) {
    return { error: 'Could not understand that workflow. Try: remind me to … when i open Cursor.' };
  }
  return { reminderText, appQuery };
}

module.exports = {
  readAnthropicCredentials,
  buildOrganizeSnapshot,
  organizeChat,
  applyOrganizePlan,
  interpretRemindWorkflow,
};
