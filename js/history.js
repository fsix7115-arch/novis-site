// Recent chats — view-only rendering of the on-device session
// history (same store the call page writes). Entries expire 30
// minutes after their session ended; "Clear now" removes one
// entry from this device only (the app's rule for local entries).
import { currentUser } from './supabase.js';
import { loadHistory, removeHistory, minutesLeft } from './history-store.js';

const listEl = document.getElementById('hist-list');
const emptyEl = document.getElementById('hist-empty');
const threadEl = document.getElementById('thread');
const logEl = document.getElementById('thread-log');

function renderList() {
  const entries = loadHistory();
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', entries.length > 0);
  threadEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  for (const entry of entries) {
    const when = new Date(entry.ended_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const card = document.createElement('div');
    card.className = 'card hist-item';
    card.innerHTML = `
      <h3>Call chat · ${when}</h3>
      <p>${entry.people} ${entry.people === 1 ? 'person' : 'people'} · ${entry.messages.length} messages · ${minutesLeft(entry)} min left</p>
      <p style="margin-top:10px; display:flex; gap:8px;">
        <button class="icon-btn" data-open>Open</button>
        <button class="icon-btn" data-clear>Clear now</button>
      </p>`;
    card.querySelector('[data-open]').addEventListener('click', () => openThread(entry));
    card.querySelector('[data-clear]').addEventListener('click', () => {
      removeHistory(entry.id);
      renderList();
    });
    listEl.appendChild(card);
  }
}

function openThread(entry) {
  listEl.classList.add('hidden');
  threadEl.classList.remove('hidden');
  document.getElementById('thread-meta').textContent =
    `${entry.people} ${entry.people === 1 ? 'person' : 'people'} · ${minutesLeft(entry)} min left`;
  // Interleave messages and separator lines in time order.
  const items = [
    ...entry.messages.map((m) => ({ at: m.created_at, msg: m })),
    ...entry.lines.map((l) => ({ at: l.at, line: l })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const myId = window.__myId;
  logEl.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    if (item.line) {
      div.className = 'sep';
      div.textContent = `${item.line.name ?? 'Stranger'} ${item.line.verb}`;
    } else {
      const mine = item.msg.sender_id === myId;
      div.className = `msg ${mine ? 'mine' : 'theirs'}`;
      if (!mine && item.msg.sender_name) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = item.msg.sender_name;
        div.appendChild(who);
      }
      div.appendChild(document.createTextNode(item.msg.content));
    }
    logEl.appendChild(div);
  }
}

document.getElementById('thread-back').addEventListener('click', renderList);

(async () => {
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  window.__myId = user.id;
  renderList();
})();
