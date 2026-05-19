'use strict';

function normalizeCommandText(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/snoo+z+e/gi, 'snooze');
}

function parseDurationMinutes(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || 'm').toLowerCase();
  if (u.startsWith('h')) return Math.round(n * 60);
  return Math.round(n);
}

/**
 * @param {string} text
 * @returns {{ op: string, minutes?: number } | { error: string }}
 */
function parseOverlayCommand(text) {
  const t = normalizeCommandText(text);
  if (!t) return { error: 'Type a command.' };

  let m = t.match(
    /^snooze\s+all(?:\s+reminders?)?\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(h(?:r|rs|our|ours)?|m(?:in|ins|inute|inutes)?)\s*$/
  );
  if (m) {
    const minutes = parseDurationMinutes(m[1], m[2]);
    if (minutes) return { op: 'snoozeAll', minutes };
  }

  m = t.match(
    /^snooze(?:\s+this|\s+it)?\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(h(?:r|rs|our|ours)?|m(?:in|ins|inute|inutes)?)\s*$/
  );
  if (m) {
    const minutes = parseDurationMinutes(m[1], m[2]);
    if (minutes) return { op: 'snoozeOne', minutes };
  }

  if (/^(?:done|complete)\s+all(?:\s+reminders?)?\s*$/.test(t)) {
    return { op: 'completeAll' };
  }

  if (/^(?:done|complete)(?:\s+this|\s+it)?\s*$/.test(t)) {
    return { op: 'completeOne' };
  }

  if (/^(?:dismiss|close)\s+all(?:\s+reminders?)?\s*$/.test(t)) {
    return { op: 'dismissAll' };
  }

  return {
    error: 'Try: snooze all 1 hr · snooze this 30m · done all · dismiss all',
  };
}

function formatMinutesLabel(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 1) return '';
  if (m % 60 === 0 && m >= 60) {
    const h = m / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return m === 1 ? '1 minute' : `${m} minutes`;
}

module.exports = { parseOverlayCommand, formatMinutesLabel, normalizeCommandText };
