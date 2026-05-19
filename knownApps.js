'use strict';

/** Curated apps: bundle ids, display names, and text aliases for resolve + keyword surfacing. */

const KNOWN_APPS = [
  { name: 'Messages', bundleId: 'com.apple.MobileSMS', aliases: ['message', 'messages', 'imessage', 'sms'] },
  { name: 'WhatsApp', bundleId: 'net.whatsapp.WhatsApp', aliases: ['whatsapp', 'whats app'] },
  { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', aliases: ['slack'] },
  { name: 'Zoom', bundleId: 'us.zoom.xos', aliases: ['zoom', 'meeting', 'call'] },
  { name: 'Mail', bundleId: 'com.apple.mail', aliases: ['mail', 'email', 'inbox'] },
  {
    name: 'App Store',
    bundleId: 'com.apple.AppStore',
    aliases: ['app store', 'appstore', 'mac app store'],
  },
  { name: 'Safari', bundleId: 'com.apple.Safari', aliases: ['browser', 'web', 'safari'] },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome', aliases: ['browser', 'chrome', 'web'] },
  { name: 'ChatGPT Atlas', bundleId: 'com.openai.atlas', aliases: ['chatgpt', 'atlas', 'chatgpt atlas', 'openai'] },
  { name: 'Spotify', bundleId: 'com.spotify.client', aliases: ['spotify', 'music'] },
  {
    name: 'Visual Studio Code',
    bundleId: 'com.microsoft.VSCode',
    aliases: ['code', 'vscode', 'vsc', 'vs code', 'visual studio code', 'debug', 'repo'],
  },
  {
    name: 'Cursor',
    bundleId: 'com.todesktop.230313mzl4w4u92',
    aliases: ['cursor', 'ide'],
  },
];

const BUNDLE_ID_TO_NAME = Object.fromEntries(KNOWN_APPS.map((a) => [a.bundleId, a.name]));
const APP_NAME_TO_BUNDLE_ID = Object.fromEntries(KNOWN_APPS.map((a) => [a.name, a.bundleId]));

/** Map typed app name / alias / bundle id to canonical bundle id (passthrough if unknown). */
function resolveInputToBundleId(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const value = trimmed.toLowerCase();
  for (const entry of KNOWN_APPS) {
    if (entry.name.toLowerCase() === value) return entry.bundleId;
    if (entry.bundleId.toLowerCase() === value) return entry.bundleId;
    for (const a of entry.aliases || []) {
      if (a.toLowerCase() === value) return entry.bundleId;
    }
  }
  const contains = KNOWN_APPS.find((e) => e.name.toLowerCase().includes(value));
  if (contains) return contains.bundleId;
  return trimmed;
}

module.exports = { KNOWN_APPS, BUNDLE_ID_TO_NAME, APP_NAME_TO_BUNDLE_ID, resolveInputToBundleId };
