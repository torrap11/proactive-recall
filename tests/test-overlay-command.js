'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOverlayCommand } = require('../overlayCommand');

test('parses snooze all reminders 1 hr', () => {
  const out = parseOverlayCommand('snooze all reminders 1 hr');
  assert.deepEqual(out, { op: 'snoozeAll', minutes: 60 });
});

test('parses snoooze typo', () => {
  const out = parseOverlayCommand('snoooze all reminders 1 hr');
  assert.deepEqual(out, { op: 'snoozeAll', minutes: 60 });
});

test('parses snooze this 30m', () => {
  const out = parseOverlayCommand('snooze this 30m');
  assert.deepEqual(out, { op: 'snoozeOne', minutes: 30 });
});

test('parses done all', () => {
  assert.deepEqual(parseOverlayCommand('done all'), { op: 'completeAll' });
});

test('rejects unknown command', () => {
  assert.ok(parseOverlayCommand('hello world').error);
});
