'use strict';

/**
 * Parse shorthand proactive-recall workflows typed into capture.
 *
 * Supported shapes (case-insensitive):
 *   remind me this: <text> when i open this <app>
 *   remind me to <text> when i open <app>
 *   when i open <app> remind me to <text>
 *   surface <text> when i open <app>
 *
 * Returns null if the input doesn't match.
 */

function normalizeAppQuery(raw) {
  let appQuery = String(raw || '').trim();
  appQuery = appQuery.replace(/^(?:the\s+)?(?:app\s+)?/i, '').trim();
  appQuery = appQuery.replace(/[.,;:!?]+$/g, '').trim();
  return appQuery;
}

/** True when capture text is likely a remind-on-app-open workflow. */
function looksLikeRemindWorkflowText(rawText) {
  const text = String(rawText || '').trim().toLowerCase();
  if (!text) return false;
  if (/^remind\s+me\b/.test(text)) return true;
  if (/\bwhen\s+i\s+open\b/.test(text) && /\bremind\s+me\b/.test(text)) return true;
  if (/^surface\s+.+\s+when\s+i\s+open\b/.test(text)) return true;
  return false;
}

function parseRemindWorkflowText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const matchers = [
    {
      re: /^\s*remind\s+me\s+this\s*:\s*([\s\S]+?)\s+when\s+i\s+open\s+(?:this\s+)?(.+?)\s*$/i,
      pick: (m) => ({ reminderText: m[1], appQuery: m[2] }),
    },
    {
      re: /^\s*when\s+i\s+open\s+(?:this\s+)?(.+?)\s*,?\s*remind\s+me(?:\s+to)?\s+([\s\S]+?)\s*$/i,
      pick: (m) => ({ reminderText: m[2], appQuery: m[1] }),
    },
    {
      re: /^\s*remind\s+me(?:\s+to)?\s+([\s\S]+?)\s+when\s+i\s+open\s+(?:this\s+)?(.+?)\s*$/i,
      pick: (m) => ({ reminderText: m[1], appQuery: m[2] }),
    },
    {
      re: /^\s*surface\s+([\s\S]+?)\s+when\s+i\s+open\s+(?:this\s+)?(.+?)\s*$/i,
      pick: (m) => ({ reminderText: m[1], appQuery: m[2] }),
    },
  ];

  for (const { re, pick } of matchers) {
    const m = text.match(re);
    if (!m) continue;
    const { reminderText, appQuery } = pick(m);
    const reminder = String(reminderText || '').trim();
    const app = normalizeAppQuery(appQuery);
    if (!reminder || !app) return null;
    return { reminderText: reminder, appQuery: app };
  }

  return null;
}

module.exports = { parseRemindWorkflowText, looksLikeRemindWorkflowText };
