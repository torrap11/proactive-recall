'use strict';

/**
 * assistant.js — In-app AI assistant powered by Claude.
 *
 * The assistant can ONLY read and mutate data stored in this app.
 * No web search, no external HTTP calls, no arbitrary tools.
 *
 * Tool set (closed):
 *   list_notes, search_notes, get_note,
 *   create_note, update_note, delete_note,
 *   list_folders, create_folder, update_folder, delete_folder,
 *   move_note_to_folder,
 *   link_note_to_app, unlink_note_from_app, get_note_app_links
 */

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a helpful assistant embedded in Proactive Recall, a local notes application.

Your ONLY job is to help the user manage and navigate their notes library.

Rules you must always follow:
1. Only use the provided tools — no external knowledge, no web searches, no URLs.
2. If the user asks about something not in their notes, say so clearly and offer to help search or organize what does exist.
3. Never fabricate note content or folder names; always read from tools first.
4. When creating or editing notes, confirm the action with the user before doing it if the scope is large.
5. You may chain multiple tool calls to answer a request (e.g. search then get_note for full content).
6. Be concise. Bullet lists are fine. Avoid lengthy preamble.`;

const TOOLS = [
  {
    name: 'list_notes',
    description: 'List notes, optionally filtered by folder. Returns id, title, snippet, folder_id, updated_at.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: {
          type: ['integer', 'null', 'string'],
          description: 'Folder ID to filter by. Omit for all active notes, null for unfiled. Use the string "trash" for Recently deleted.',
        },
      },
    },
  },
  {
    name: 'search_notes',
    description: 'Full-text search across note titles and content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (case-insensitive).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description: 'Get the full content of a single note by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_note',
    description: 'Create a new note.',
    input_schema: {
      type: 'object',
      properties: {
        title:     { type: 'string', description: 'Note title.' },
        content:   { type: 'string', description: 'Note body text.' },
        folder_id: { type: ['integer', 'null'], description: 'Folder to place it in. Omit for unfiled.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_note',
    description: 'Update the title and/or content of an existing note.',
    input_schema: {
      type: 'object',
      properties: {
        id:      { type: 'integer', description: 'Note ID.' },
        title:   { type: 'string', description: 'New title (omit to keep existing).' },
        content: { type: 'string', description: 'New content (omit to keep existing).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_note',
    description: 'Move a note to Recently deleted (soft delete).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_folders',
    description: 'List all folders.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_folder',
    description: 'Create a new folder.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_folder',
    description: 'Rename a folder.',
    input_schema: {
      type: 'object',
      properties: {
        id:   { type: 'integer', description: 'Folder ID.' },
        name: { type: 'string', description: 'New name.' },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'delete_folder',
    description: 'Delete a folder (notes inside become unfiled).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Folder ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'move_note_to_folder',
    description: 'Move a note into a folder, or set it to unfiled.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:   { type: 'integer', description: 'Note ID.' },
        folder_id: { type: ['integer', 'null'], description: 'Target folder ID, or null to unfile.' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'link_note_to_app',
    description: 'Link a note to a macOS app by bundle ID so it surfaces when that app becomes active.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:   { type: 'integer', description: 'Note ID.' },
        bundle_id: { type: 'string', description: 'macOS bundle ID (e.g. "com.apple.MobileSMS").' },
      },
      required: ['note_id', 'bundle_id'],
    },
  },
  {
    name: 'unlink_note_from_app',
    description: 'Remove a note\'s link to a macOS app bundle ID.',
    input_schema: {
      type: 'object',
      properties: {
        note_id:   { type: 'integer', description: 'Note ID.' },
        bundle_id: { type: 'string', description: 'macOS bundle ID to remove.' },
      },
      required: ['note_id', 'bundle_id'],
    },
  },
  {
    name: 'get_note_app_links',
    description: 'Get all app bundle IDs linked to a note.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'integer', description: 'Note ID.' },
      },
      required: ['note_id'],
    },
  },
];

/** Snippet helper — first 150 chars of content. */
function snippet(note) {
  return { id: note.id, title: note.title, snippet: (note.content || '').slice(0, 150), folder_id: note.folder_id, updated_at: note.updated_at };
}

/**
 * Execute a single tool call against the database module.
 * Returns a JSON-serialisable result or throws.
 */
function executeTool(name, input, db) {
  switch (name) {
    case 'list_notes': {
      let folderId = input.folder_id !== undefined ? input.folder_id : 'all';
      if (folderId === 'trash') folderId = 'trash';
      const notes = db.getAllNotes(folderId);
      return { count: notes.length, notes: notes.map(snippet) };
    }
    case 'search_notes': {
      const notes = db.searchNotes(input.query || '');
      return { count: notes.length, notes: notes.map(snippet) };
    }
    case 'get_note': {
      const note = db.getNoteById(input.id);
      if (!note) return { error: `Note ${input.id} not found.` };
      const links = db.getLinkedBundleIds(note.id);
      return { ...note, linked_bundle_ids: links };
    }
    case 'create_note': {
      const note = db.createNote({ title: input.title || '', content: input.content || '', folderId: input.folder_id ?? null });
      return note;
    }
    case 'update_note': {
      const note = db.updateNote(input.id, { title: input.title, content: input.content });
      if (!note) return { error: `Note ${input.id} not found.` };
      return note;
    }
    case 'delete_note': {
      const ok = db.moveNoteToTrash(input.id);
      return ok ? { moved_to_trash: input.id } : { error: `Note ${input.id} not found or already deleted.` };
    }
    case 'list_folders': {
      return db.getAllFolders();
    }
    case 'create_folder': {
      return db.createFolder({ name: input.name });
    }
    case 'update_folder': {
      const f = db.updateFolder(input.id, { name: input.name });
      if (!f) return { error: `Folder ${input.id} not found.` };
      return f;
    }
    case 'delete_folder': {
      db.deleteFolder(input.id);
      return { deleted: input.id };
    }
    case 'move_note_to_folder': {
      const note = db.moveNoteToFolder(input.note_id, input.folder_id ?? null);
      if (!note) return { error: `Note ${input.note_id} not found.` };
      return note;
    }
    case 'link_note_to_app': {
      db.linkNoteToApp(input.note_id, input.bundle_id);
      return { linked: { note_id: input.note_id, bundle_id: input.bundle_id } };
    }
    case 'unlink_note_from_app': {
      db.unlinkNoteFromApp(input.note_id, input.bundle_id);
      return { unlinked: { note_id: input.note_id, bundle_id: input.bundle_id } };
    }
    case 'get_note_app_links': {
      const ids = db.getLinkedBundleIds(input.note_id);
      return { note_id: input.note_id, bundle_ids: ids };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Run a user message through the assistant with tool-calling loop.
 *
 * @param {string} userMessage
 * @param {Array}  history     - Prior messages (alternating user/assistant).
 * @param {object} db          - database.js module.
 * @param {object} cfg         - Current config (anthropicApiKey, model).
 * @returns {{ reply: string, messages: Array, toolCalls: Array }}
 */
async function runAssistant(userMessage, history, db, cfg) {
  if (!cfg.anthropicApiKey) {
    return {
      reply: 'No API key configured. Please set your Anthropic API key in Settings.',
      messages: history,
      toolCalls: [],
    };
  }

  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const messages = [...history, { role: 'user', content: userMessage }];
  const toolCalls = [];

  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: cfg.model || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      return { reply: text, messages, toolCalls };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResultContent = [];

      for (const block of toolUseBlocks) {
        toolCalls.push({ name: block.name, input: block.input });
        let result;
        try {
          result = executeTool(block.name, block.input, db);
        } catch (err) {
          result = { error: err.message };
        }
        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResultContent });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  return {
    reply: '(Assistant reached max iterations without a final response.)',
    messages,
    toolCalls,
  };
}

module.exports = { runAssistant };
