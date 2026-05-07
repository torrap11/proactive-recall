'use strict';

let autoDismissMs = 10000;
let activeAppKey = '';
let focusedIndex = -1;
let cardCount = 0;

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
}

function getFocusedId() {
  const cards = getCards();
  const card = cards[focusedIndex];
  return card ? Number(card.dataset.id) : null;
}

window.overlay.onShow((payload) => {
  const notes = payload.notes || [];
  activeAppKey = payload.appKey || '';
  if (payload.autoDismissMs) autoDismissMs = payload.autoDismissMs;
  focusedIndex = notes.length > 0 ? 0 : -1;
  cardCount = notes.length;

  // Reset and restart progress bar
  const fill = document.getElementById('progress-fill');
  fill.style.animation = 'none';
  fill.offsetHeight; // force reflow
  fill.style.animationDuration = `${autoDismissMs}ms`;
  fill.style.animation = `shrink ${autoDismissMs}ms linear forwards`;

  // Update app name in header
  document.getElementById('header-app').textContent = payload.appName || 'Jot';

  const container = document.getElementById('notes-container');
  container.innerHTML = '';

  const list = Array.isArray(notes) ? notes : [];
  list.forEach((note, idx) => {
    const title = esc((note.text || '').split('\n')[0] || 'Note');
    const snippet = esc((note.text || '').slice(0, 160));
    const participants = Array.isArray(note.participants) ? note.participants.filter(Boolean) : [];
    const participantLine = participants.length > 0
      ? `<div class="note-card-meta">${participants.slice(0, 3).map((p) => `@${esc(p)}`).join(' · ')}</div>`
      : '';
    const workflowLabel = note.workflow === 'meeting' ? 'Meeting Context' : 'Engineering Context';

    const card = document.createElement('div');
    card.className = 'note-card' + (idx === 0 ? ' focused' : '');
    card.dataset.id = String(note.id);
    card.style.animationDelay = `${idx * 55}ms`;
    card.innerHTML = `
      <div class="note-card-title">${title}</div>
      <div class="note-card-badge">${workflowLabel}</div>
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

window.overlay.onDismiss(() => {
  document.getElementById('notes-container').innerHTML = '';
  focusedIndex = -1;
  cardCount = 0;
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
  const id = Number(card.dataset.id);
  if (Number.isFinite(id)) window.overlay.openNote(id);
});

document.addEventListener('keydown', (e) => {
  const cards = getCards();
  if (cards.length === 0) return;

  if (e.key === 'Escape') {
    window.overlay.dismissAll();
    return;
  }

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
    return;
  }
});
