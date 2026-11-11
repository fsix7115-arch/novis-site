// Recent chats — on-device session history, mirroring the app's
// LocalSessionChats (lib/features/chat/data/local_session_chats.dart):
// one entry per finished call SESSION holding the whole transcript
// (waiting self-chat + every stranger segment + join/left lines),
// 30-minute retention enforced on every read, max 5 entries, and a
// session with no messages leaves no entry.
const KEY = 'novis_local_session_chats';
export const RETENTION_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // History is a nicety; losing it must never disturb leaving.
  }
}

/// All unexpired entries, newest first. Expired ones are pruned from
/// storage as a side effect (same rule as the app).
export function loadHistory() {
  const now = Date.now();
  const all = readAll();
  const live = all.filter((e) => now < Date.parse(e.ended_at) + RETENTION_MS);
  if (live.length !== all.length) writeAll(live);
  return live;
}

/// Saves a finished session. `messages`/`lines` use the app's JSON
/// shapes (ChatMessage / SessionChatLine maps).
export function saveHistory({ endedAt, people, messages, lines }) {
  if (!messages || messages.length === 0) return;
  const entry = {
    id: `local-${endedAt.getTime()}`,
    ended_at: endedAt.toISOString(),
    people,
    messages,
    lines,
  };
  const entries = readAll().filter((e) => e.id !== entry.id);
  entries.unshift(entry);
  writeAll(entries.slice(0, MAX_ENTRIES));
}

export function removeHistory(id) {
  writeAll(readAll().filter((e) => e.id !== id));
}

export function minutesLeft(entry) {
  const ms = Date.parse(entry.ended_at) + RETENTION_MS - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}
