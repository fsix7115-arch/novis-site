// AI Friend — a faithful web mirror of the app's AiDostScreen +
// AiDostController + AiDostRepository. Same live `ai-dost` edge
// function, same request/response shape, same limit states. The
// persona choice persists server-side (ai_dost_prefs, written by the
// edge function with each send); history lives in memory only.
// Replies come back in the user's own language — that is the
// function's job, nothing client-side tunes it.
import { supabase, LS, currentUser, toast } from './supabase.js';
import { applyAdsGate } from './testing.js';

const $ = (id) => document.getElementById(id);
const els = {
  avatar: $('dostAvatar'), name: $('dostName'), tagline: $('dostTagline'),
  cardMale: $('personaMale'), cardFemale: $('personaFemale'),
  notReady: $('dostNotReady'), empty: $('dostEmpty'), emptyAvatar: $('dostEmptyAvatar'),
  greeting: $('dostGreeting'), starters: $('starterRow'),
  log: $('dostLog'), typing: $('dostTyping'), error: $('dostError'),
  limit: $('dostLimit'), form: $('dostForm'), input: $('dostInput'),
  send: $('btnDostSend'), retry: $('btnDostRetry'),
};

const PERSONAS = {
  male: {
    name: 'Darling', initial: 'D', kind: '(Male friend)',
    tagline: 'Your own friend — always there for you',
    gradient: 'linear-gradient(135deg,#ffc46b,#ff7a18)',
  },
  female: {
    name: 'Honey', initial: 'H', kind: '(Female friend)',
    tagline: 'Your own friend — heart-to-heart, never any judgement',
    gradient: 'linear-gradient(135deg,#ff8fab,#8b5cf6)',
  },
};

const state = {
  messages: [], // {role: 'user'|'assistant', content}
  persona: 'female',
  sending: false,
  limitReached: false,
  notConfigured: false,
  hasError: false,
};

let myId = null;

function render() {
  const p = PERSONAS[state.persona];
  els.avatar.textContent = p.initial;
  els.avatar.style.background = p.gradient;
  els.name.textContent = p.name;
  els.tagline.textContent = p.tagline;
  els.emptyAvatar.textContent = p.initial;
  els.emptyAvatar.style.background = p.gradient;
  els.greeting.textContent = `Say hello to ${p.name} — short, sweet chats, in your own language.`;
  for (const [card, key] of [[els.cardMale, 'male'], [els.cardFemale, 'female']]) {
    card.classList.toggle('selected', state.persona === key);
    card.querySelector('[data-check]').classList.toggle('hidden', state.persona !== key);
  }
  els.starters.innerHTML = '';
  for (const line of [
    `Hi ${p.name}, let me tell you about my day`,
    "I can't sleep…",
    'Say something sweet',
  ]) {
    const chip = document.createElement('button');
    chip.className = 'starter-chip';
    chip.type = 'button';
    chip.textContent = line;
    chip.addEventListener('click', () => send(line));
    els.starters.appendChild(chip);
  }
  els.notReady.classList.toggle('hidden', !state.notConfigured);
  els.empty.classList.toggle('hidden', state.notConfigured || state.messages.length > 0);
  els.log.classList.toggle('hidden', state.notConfigured || state.messages.length === 0);
  els.log.innerHTML = '';
  for (const m of state.messages) {
    const div = document.createElement('div');
    div.className = `msg ${m.role === 'user' ? 'mine' : 'theirs'}`;
    div.textContent = m.content;
    els.log.appendChild(div);
  }
  els.log.scrollTop = els.log.scrollHeight;
  els.typing.classList.toggle('hidden', !state.sending);
  els.error.classList.toggle('hidden', !(state.hasError && !state.notConfigured));
  els.limit.classList.toggle('hidden', !state.limitReached);
  const inputEnabled = !state.sending && !state.limitReached && !state.notConfigured;
  els.input.disabled = !inputEnabled;
  els.send.disabled = !inputEnabled;
  els.input.placeholder = state.limitReached ? 'See you tomorrow…' : `Message ${p.name}…`;
}

/// Response parsing — mirrors parseAiDostResponse exactly.
function parseResponse(data) {
  if (data && data.limit_reached === true) {
    return { outcome: 'limit', reply: data.reply ?? null, persona: data.persona ?? null };
  }
  if (!data || !data.reply) return { outcome: 'error' };
  return { outcome: 'ok', reply: data.reply, persona: data.persona ?? null };
}

async function callDost({ message, persona, history }) {
  try {
    const { data, error } = await supabase.functions.invoke('ai-dost', {
      body: {
        message,
        persona,
        // The repository sends only the last 8 history entries.
        history: history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      },
    });
    if (error) {
      // 501 {error:'not_configured'} — provider keys not set.
      let status = error.context?.status ?? null;
      let bodyText = '';
      try { bodyText = await error.context.clone().text(); } catch { /* already read */ }
      if (status === 501 || bodyText.includes('not_configured')) return { outcome: 'notConfigured' };
      return { outcome: 'error' };
    }
    if (data && typeof data === 'object') return parseResponse(data);
    return { outcome: 'error' };
  } catch {
    return { outcome: 'error' };
  }
}

async function send(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed || state.sending || state.limitReached || state.notConfigured) return;
  const history = state.messages;
  state.messages = [...history, { role: 'user', content: trimmed }];
  state.sending = true;
  state.hasError = false;
  render();
  const result = await callDost({ message: trimmed, persona: state.persona, history });
  applyResult(result, history, true);
}

async function retryLast() {
  if (state.sending || !state.hasError) return;
  const lastUserIndex = state.messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) return;
  const text = state.messages[lastUserIndex].content;
  const history = state.messages.slice(0, lastUserIndex);
  state.sending = true;
  state.hasError = false;
  render();
  const result = await callDost({ message: text, persona: state.persona, history });
  applyResult(result, history, false);
}

function applyResult(result, historyBefore, rollbackOnNotConfigured) {
  state.sending = false;
  if (result.outcome === 'ok') {
    state.messages = [...state.messages, { role: 'assistant', content: result.reply }];
    if (result.persona === 'male' || result.persona === 'female') {
      state.persona = result.persona;
    }
  } else if (result.outcome === 'limit') {
    if (result.reply) {
      state.messages = [...state.messages, { role: 'assistant', content: result.reply }];
    }
    state.limitReached = true;
  } else if (result.outcome === 'notConfigured') {
    // On a fresh send, roll back the optimistic user bubble (nothing
    // was answered); on retry the app keeps the bubble. Same rule.
    if (rollbackOnNotConfigured) state.messages = historyBefore;
    state.notConfigured = true;
  } else {
    state.hasError = true;
  }
  render();
}

function selectPersona(persona) {
  if (persona !== 'male' && persona !== 'female') return;
  state.persona = persona;
  render();
}

els.cardMale.addEventListener('click', () => selectPersona('male'));
els.cardFemale.addEventListener('click', () => selectPersona('female'));
els.retry.addEventListener('click', retryLast);
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = '';
  send(text);
});

async function boot() {
  applyAdsGate();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  myId = user.id;
  render();
  // Stored persona ('male' | 'female') or null if never chosen.
  try {
    const { data } = await supabase
      .from('ai_dost_prefs').select('persona')
      .eq('user_id', myId).maybeSingle();
    if (data?.persona === 'male' || data?.persona === 'female') {
      state.persona = data.persona;
      render();
    }
  } catch { /* default stays */ }
}

boot();
