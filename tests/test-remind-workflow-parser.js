'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseRemindWorkflowText, looksLikeRemindWorkflowText } = require('../remindWorkflowParser');

test('parses basic reminder workflow', () => {
  const out = parseRemindWorkflowText('remind me this: pay rent when i open this Safari');
  assert.deepEqual(out, { reminderText: 'pay rent', appQuery: 'Safari' });
});

test('parses case-insensitively', () => {
  const out = parseRemindWorkflowText('Remind Me This: submit report When I Open This slack.');
  assert.equal(out.reminderText, 'submit report');
  assert.equal(out.appQuery, 'slack');
});

test('parses remind me to … when i open …', () => {
  const out = parseRemindWorkflowText('remind me to check #general when i open Slack');
  assert.deepEqual(out, { reminderText: 'check #general', appQuery: 'Slack' });
});

test('parses when i open … remind me to …', () => {
  const out = parseRemindWorkflowText('when i open Cursor remind me to run tests');
  assert.deepEqual(out, { reminderText: 'run tests', appQuery: 'Cursor' });
});

test('parses surface … when i open …', () => {
  const out = parseRemindWorkflowText('surface deploy checklist when i open VS Code');
  assert.deepEqual(out, { reminderText: 'deploy checklist', appQuery: 'VS Code' });
});

test('does not match without an app target', () => {
  const out = parseRemindWorkflowText('remind me this: pay rent when i open');
  assert.equal(out, null);
});

test('trims trailing punctuation on app target', () => {
  const out = parseRemindWorkflowText('remind me this: check email when i open this Mail,');
  assert.deepEqual(out, { reminderText: 'check email', appQuery: 'Mail' });
});

test('does not match unrelated text', () => {
  const out = parseRemindWorkflowText('remind me later: pay rent');
  assert.equal(out, null);
});

test('looksLikeRemindWorkflowText detects workflow phrasing', () => {
  assert.equal(looksLikeRemindWorkflowText('remind me to foo when i open bar'), true);
  assert.equal(looksLikeRemindWorkflowText('just a normal note'), false);
});
