'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeCaptureWorkflow } = require('../captureWorkflow');

test('executeCaptureWorkflow parses remind shorthand without AI', async () => {
  const links = [];
  const mockDb = {
    createNote: (text) => ({ id: 99, text, folder_id: null }),
    linkNoteToApp: (noteId, appKey) => {
      links.push({ noteId, appKey });
    },
  };

  const result = await executeCaptureWorkflow(
    mockDb,
    'remind me to run tests when i open Cursor',
    '/tmp/no-ai-userdata'
  );
  assert.equal(result.ok, true);
  assert.equal(result.reminderText, 'run tests');
  assert.ok(result.appKey);
  assert.equal(result.note.id, 99);
  assert.deepEqual(links, [{ noteId: 99, appKey: result.appKey }]);
});
