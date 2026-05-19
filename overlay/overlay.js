'use strict';

let autoDismissMs = 10000;
let activeAppKey = '';
let focusedIndex = -1;
let cardCount = 0;
let visibleNoteIds = [];
let commandTargetNoteId = null;
let commandPanelOpen = false;

const commandPanelEl = document.getElementById('command-panel');
const commandInputEl = document.getElementById('command-input');
const commandStatusEl = document.getElementById('command-status');
const commandLabelEl = document.getElementById('command-label');

function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCards() {
  return Array.from(document.querySelectorAll('.note-card'));
}

function setFocus(index) {
  const cards = getCards();
  cards.forEach((c, i) => c.classList.toggle('focused', i === index));
  focusedIndex = index;
  const card = cards[index];
  if (card) {
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function getFocusedId() {
  const cards = getCards();
  const card = cards[focusedIndex];
  return card ? Number(card.dataset.id) : null;
}

function pauseProgressAnimation() {
  const fill = document.getElementById('progress-fill');
  fill.style.animationPlayState = 'paused';
}

function restartProgressAnimation() {
  const fill = document.getElementById('progress-fill');
  fill.style.animation = 'none';
  fill.offsetHeight;
  fill.style.animationPlayState = 'running';
  fill.style.animationDuration = `${autoDismissMs}ms`;
  fill.style.animation = `shrink ${autoDismissMs}ms linear forwards`;
}

function setCommandStatus(message, kind = '') {
  if (!commandStatusEl) return;
  commandStatusEl.textContent = message || '';
  commandStatusEl.classList.remove('is-error', 'is-ok');
  if (kind === 'error') commandStatusEl.classList.add('is-error');
  if (kind === 'ok') commandStatusEl.classList.add('is-ok');
}

function updateCommandTargetHighlight() {
  getCards().forEach((card) => {
    const id = Number(card.dataset.id);
    card.classList.toggle(
      'command-target',
      commandPanelOpen && Number.isFinite(commandTargetNoteId) && id === commandTargetNoteId
    );
  });
}

function hideCommandPanel() {
  commandPanelOpen = false;
  commandTargetNoteId = null;
  commandPanelEl?.classList.add('hidden');
  if (commandInputEl) commandInputEl.value = '';
  setCommandStatus('');
  updateCommandTargetHighlight();
  restartProgressAnimation();
}

function showCommandPanel(noteId) {
  commandPanelOpen = true;
  commandTargetNoteId = Number.isFinite(noteId) ? noteId : getFocusedId();
  commandPanelEl?.classList.remove('hidden');
  if (commandLabelEl) {
    commandLabelEl.textContent =
      visibleNoteIds.length > 1
        ? 'Command (applies to all visible reminders)'
        : 'Command';
  }
  if (commandInputEl) {
    commandInputEl.value = '';
    commandInputEl.focus();
  }
  setCommandStatus('e.g. snooze all reminders 1 hr');
  updateCommandTargetHighlight();
  pauseProgressAnimation();
}

async function submitCommand() {
  if (!commandInputEl) return;
  const command = commandInputEl.value.trim();
  if (!command) {
    setCommandStatus('Type a command first.', 'error');
    return;
  }
  setCommandStatus('Running…');
  commandInputEl.disabled = true;
  try {
    const result = await window.overlay.runCommand({
      command,
      appKey: activeAppKey,
      noteIds: visibleNoteIds,
      focusNoteId: commandTargetNoteId,
    });
    if (!result || result.error) {
      setCommandStatus(result?.error || 'Command failed.', 'error');
      return;
    }
    setCommandStatus(result.message || 'Done.', 'ok');
    if (result.dismissAll) {
      hideCommandPanel();
      return;
    }
    visibleNoteIds = getCards().map((c) => Number(c.dataset.id)).filter(Number.isFinite);
    if (visibleNoteIds.length === 0) {
      hideCommandPanel();
      return;
    }
    setTimeout(() => hideCommandPanel(), 600);
  } finally {
    commandInputEl.disabled = false;
  }
}

function removeCardByNoteId(noteId) {
  const cards = getCards();
  const removedIdx = cards.findIndex((c) => Number(c.dataset.id) === noteId);
  if (removedIdx < 0) return;

  const wasFocused = removedIdx === focusedIndex;
  cards[removedIdx].remove();
  visibleNoteIds = getCards().map((c) => Number(c.dataset.id)).filter(Number.isFinite);

  const remaining = getCards();
  cardCount = remaining.length;

  if (remaining.length === 0) {
    focusedIndex = -1;
    hideCommandPanel();
    window.overlay.notifyEmpty();
    return;
  }

  if (removedIdx < focusedIndex) {
    focusedIndex--;
  } else if (wasFocused || focusedIndex >= remaining.length) {
    focusedIndex = Math.min(Math.max(0, focusedIndex), remaining.length - 1);
  }
  setFocus(focusedIndex);
  if (!commandPanelOpen) restartProgressAnimation();
}

window.overlay.onShow((payload) => {
  hideCommandPanel();
  const notes = payload.notes || [];
  activeAppKey = payload.appKey || '';
  if (payload.autoDismissMs) autoDismissMs = payload.autoDismissMs;
  focusedIndex = notes.length > 0 ? 0 : -1;
  cardCount = notes.length;

  restartProgressAnimation();

  document.getElementById('header-app').textContent = payload.appName || 'Jot';

  const container = document.getElementById('notes-container');
  container.innerHTML = '';

  const list = Array.isArray(notes) ? notes : [];
  visibleNoteIds = list.map((n) => Number(n.id)).filter(Number.isFinite);

  list.forEach((note, idx) => {
    const title = esc((note.text || '').split('\n')[0] || 'Note');
    const snippet = esc((note.text || '').slice(0, 160));
    const participants = Array.isArray(note.participants) ? note.participants.filter(Boolean) : [];
    const participantLine =
      participants.length > 0
        ? `<div class="note-card-meta">${participants
            .slice(0, 3)
            .map((p) => `@${esc(p)}`)
            .join(' · ')}</div>`
        : '';

    const card = document.createElement('div');
    card.className = 'note-card' + (idx === 0 ? ' focused' : '');
    card.dataset.id = String(note.id);
    card.style.animationDelay = `${idx * 55}ms`;
    card.innerHTML = `
      <div class="note-card-title">${title}</div>
      <div class="note-card-snippet">${snippet}</div>
      ${participantLine}
      <div class="note-card-actions">
        <button type="button" class="action-btn open" data-id="${note.id}">Open <kbd>K</kbd></button>
        <button type="button" class="action-btn snooze" data-id="${note.id}">Snooze 30m <kbd>S</kbd></button>
        <button type="button" class="action-btn complete" data-id="${note.id}">Done <kbd>D</kbd></button>
      </div>
    `;
    container.appendChild(card);
  });
});

window.overlay.onRemoveCard((payload) => {
  const noteId = Number((payload && payload.noteId) ?? NaN);
  if (!Number.isFinite(noteId)) return;
  removeCardByNoteId(noteId);
});

window.overlay.onDismiss(() => {
  document.getElementById('notes-container').innerHTML = '';
  focusedIndex = -1;
  cardCount = 0;
  visibleNoteIds = [];
  hideCommandPanel();
});

document.getElementById('dismiss-all').addEventListener('click', () => {
  window.overlay.dismissAll();
});

document.getElementById('notes-container').addEventListener('click', (e) => {
  const btn = e.target.closest('.action-btn');
  if (btn) {
    const id = Number(btn.dataset.id);
    if (btn.classList.contains('open')) window.overlay.openNote(id);
    else if (btn.classList.contains('snooze')) window.overlay.snooze(id, activeAppKey, 30);
    else if (btn.classList.contains('complete')) window.overlay.complete(id);
    return;
  }
  const card = e.target.closest('.note-card');
  if (card) {
    const cards = getCards();
    const idx = cards.indexOf(card);
    if (idx >= 0) setFocus(idx);
  }
});

document.getElementById('notes-container').addEventListener('dblclick', (e) => {
  if (e.target.closest('.action-btn')) return;
  const card = e.target.closest('.note-card');
  if (!card) return;
  e.preventDefault();
  const id = Number(card.dataset.id);
  const cards = getCards();
  const idx = cards.indexOf(card);
  if (idx >= 0) setFocus(idx);
  showCommandPanel(id);
});

commandInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void submitCommand();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    hideCommandPanel();
  }
});

document.addEventListener('keydown', (e) => {
  if (commandPanelOpen && e.key === 'Escape') {
    e.preventDefault();
    hideCommandPanel();
    return;
  }

  const cards = getCards();
  if (cards.length === 0) return;

  if (e.key === 'Escape') {
    window.overlay.dismissAll();
    return;
  }

  if (commandPanelOpen) return;

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    setFocus(Math.min(focusedIndex + 1, cards.length - 1));
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setFocus(Math.max(focusedIndex - 1, 0));
    return;
  }

  if (e.key === 'k' || e.key === 'K') {
    const id = getFocusedId();
    if (id != null) window.overlay.openNote(id);
    return;
  }

  if (e.key === 's' || e.key === 'S') {
    const id = getFocusedId();
    if (id != null) window.overlay.snooze(id, activeAppKey, 30);
    return;
  }

  if (e.key === 'd' || e.key === 'D') {
    const id = getFocusedId();
    if (id != null) window.overlay.complete(id);
  }
});
