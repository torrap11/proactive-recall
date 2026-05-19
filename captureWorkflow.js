'use strict';

const { parseRemindWorkflowText } = require('./remindWorkflowParser');
const { interpretRemindWorkflow } = require('./aiOrganize');
const { resolveInputToBundleId } = require('./knownApps');

/**
 * Run a capture reminder workflow: parse shorthand or AI, create note, link to app.
 * @returns {Promise<{ ok: true, note: object, appKey: string, appQuery: string } | { error: string }>}
 */
async function executeCaptureWorkflow(database, rawText, userDataDir) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { error: 'Describe what the reminder should do.' };

  let parsed = parseRemindWorkflowText(trimmed);
  if (!parsed) {
    const ai = await interpretRemindWorkflow(userDataDir, trimmed);
    if (ai.error) return { error: ai.error };
    parsed = ai;
  }

  const appKey = resolveInputToBundleId(parsed.appQuery);
  if (!appKey) {
    return {
      error: `Could not match an app for “${parsed.appQuery}”. Try a name like Cursor, Slack, or Safari.`,
    };
  }

  const note = database.createNote(parsed.reminderText);
  if (!note) return { error: 'Could not create the reminder note.' };

  database.linkNoteToApp(note.id, appKey);
  return {
    ok: true,
    note,
    appKey,
    appQuery: parsed.appQuery,
    reminderText: parsed.reminderText,
  };
}

module.exports = { executeCaptureWorkflow };
