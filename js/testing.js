// Hidden Testing door — mirrors the app's AboutSheet unlock exactly
// (novis-build/lib/features/entry/presentation/screens/entry_gate_screen.dart):
// triple-tap the "All features in this build have been tested and
// verified." line in the About sheet (each tap within 800ms) opens a
// password prompt; the password is checked as a SHA-256 hex compare
// against the hash stored in the app (hash only — the password itself
// is never stored, logged or written anywhere); 5 wrong attempts lock
// this device for 12h; Testing premium ON turns all ads off. The door
// is hidden by design — there is no visible Testing link anywhere.
import { sha256Hex, supabase, toast } from './supabase.js';
import { clearHistory } from './history-store.js';

// Copied from the app's kTestingPremiumHash (hash only, as in the app).
const TESTING_HASH = '4b19fac069535a46d2ca340d7126c8740dd1d3b373c48203f9649496e1837a52';
const TAP_WINDOW_MS = 800;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 12 * 60 * 60 * 1000;
const LS_PREMIUM = 'novis_testing_premium';
const LS_FAIL = 'novis_testing_fail';
const LS_LOCK = 'novis_testing_lock_until';

export function isTestingPremium() {
  try { return localStorage.getItem(LS_PREMIUM) === '1'; } catch { return false; }
}

/// The ad gate for the whole site: ads render only while Testing
/// premium is off. No ad slots exist yet — this is the switch Phase 2
/// (AdSense) checks before rendering any ad.
export function shouldShowAds() { return !isTestingPremium(); }
export function applyAdsGate() {
  const on = isTestingPremium();
  document.body.classList.toggle('testing-premium', on);
  for (const slot of document.querySelectorAll('.ad-slot')) {
    slot.style.display = on ? 'none' : '';
  }
}

export function setTestingPremium(on) {
  try { localStorage.setItem(LS_PREMIUM, on ? '1' : '0'); } catch { /* keep going */ }
  applyAdsGate();
}

/// Pure lock math (exported for the Node self-check). Mirrors
/// EntryGateStore.recordTestingFailure: an expired lock restarts the
/// count from zero, so the budget is always 5 consecutive failures.
export function nextFailState(failCount, lockUntilMs, nowMs) {
  let count = failCount;
  let lockUntil = lockUntilMs;
  if (lockUntil != null && lockUntil <= nowMs) { count = 0; lockUntil = null; }
  count += 1;
  if (count >= MAX_ATTEMPTS) lockUntil = nowMs + LOCK_MS;
  return { failCount: count, lockUntilMs: lockUntil };
}
export function isLocked(lockUntilMs, nowMs) {
  return lockUntilMs != null && lockUntilMs > nowMs;
}

/// One password attempt against the stored hash. Returns 'ok',
/// 'wrong', 'locked' (or 'empty'). Records failures and the 12h lock
/// exactly like the app's _unlock + recordTestingFailure; a correct
/// password wipes the failure count and any lock.
export async function attemptUnlock(value) {
  if (!value) return 'empty';
  const { failCount, lockUntilMs } = readFailState();
  if (isLocked(lockUntilMs, Date.now())) return 'locked';
  // Compare hashes only — the typed password is never stored or logged.
  if (await sha256Hex(value) === TESTING_HASH) {
    resetFailState();
    setTestingPremium(true);
    return 'ok';
  }
  const next = nextFailState(failCount, lockUntilMs, Date.now());
  writeFailState(next);
  return isLocked(next.lockUntilMs, Date.now()) ? 'locked' : 'wrong';
}

function readFailState() {
  let failCount = 0;
  let lockUntil = null;
  try {
    failCount = parseInt(localStorage.getItem(LS_FAIL) || '0', 10) || 0;
    const raw = localStorage.getItem(LS_LOCK);
    lockUntil = raw ? parseInt(raw, 10) : null;
  } catch { /* locked-out state must never break the gate */ }
  return { failCount, lockUntilMs: lockUntil };
}
function writeFailState({ failCount, lockUntilMs }) {
  try {
    localStorage.setItem(LS_FAIL, String(failCount));
    if (lockUntilMs == null) localStorage.removeItem(LS_LOCK);
    else localStorage.setItem(LS_LOCK, String(lockUntilMs));
  } catch { /* locked-out state must never break the gate */ }
}
function resetFailState() {
  try { localStorage.removeItem(LS_FAIL); localStorage.removeItem(LS_LOCK); } catch { /* keep going */ }
}

// About sheet content — the app's lines, verbatim (English only).
const ABOUT_LINES = [
  'Novis is a free video chat app for meeting new people, face to face.',
  'You must be 18 or older to use Novis.',
  'Be kind and respectful. You can report or block anyone at any time.',
  'Your display name is the only name strangers ever see.',
  'Novis is free to use, with optional extras you can unlock.',
];
const TESTED_LINE = 'All features in this build have been tested and verified.';

let initialized = false;
let doorOpen = false;
let lineTaps = 0;
let lastLineTap = 0;
let els = null;

function buildSheet() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay hidden';
  overlay.id = 'about-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet" role="dialog" aria-label="About Novis">
      <div style="display:flex; align-items:center; gap:14px; margin-bottom:20px;">
        <img class="logo logo-round" src="assets/logo.png" alt="Novis logo" width="52" height="52">
        <div>
          <div style="font-size:22px; font-weight:700;" class="brand-word">Novis</div>
          <div class="muted" style="font-size:13px;">Novis website · Phase 1</div>
        </div>
      </div>
      ${ABOUT_LINES.map((l) => `<p class="about-line">${l}</p>`).join('')}
      <p class="about-line" id="about-tested-line">${TESTED_LINE}</p>
      <div id="about-dynamic"></div>
      <div style="text-align:right; margin-top:18px;">
        <button class="btn ghost small" id="about-close" type="button">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function renderDynamic() {
  const area = els.dynamic;
  if (isTestingPremium()) {
    area.innerHTML = `
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="color:var(--glow-amber); font-size:16px;">★</span>
        <strong style="color:var(--glow-amber);">Premium</strong>
        <span class="note">Premium is on for this device.</span>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;">
        <button class="btn ghost small" id="testing-off" type="button">Turn off premium</button>
        <button class="btn ghost small" id="testing-clear-history" type="button">Clear recent chats</button>
      </div>
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;">
      <p class="note">Start over with a clean slate — clears this device's website data and sign-in, then returns to the welcome screen.</p>
      <button class="btn ghost small" id="testing-fresh-start" type="button" style="color:var(--sunset-rose);">Fresh test start</button>`;
    area.querySelector('#testing-off').addEventListener('click', () => {
      setTestingPremium(false);
      renderDynamic();
      toast('Premium is off for this device.');
    });
    area.querySelector('#testing-clear-history').addEventListener('click', () => {
      clearHistory();
      toast('Recent chats cleared.');
    });
    area.querySelector('#testing-fresh-start').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await supabase.auth.signOut(); } catch { /* signed-out state is enough */ }
      try { localStorage.clear(); } catch { /* keep going */ }
      location.replace('index.html');
    });
    return;
  }
  if (!doorOpen) { area.innerHTML = ''; return; }
  const { lockUntilMs } = readFailState();
  if (isLocked(lockUntilMs, Date.now())) {
    area.innerHTML = `<p class="note" style="margin-top:8px;">Too many attempts. Try again later.</p>`;
    return;
  }
  area.innerHTML = `
    <div class="field" style="margin-top:8px;">
      <label for="testing-password">Password</label>
      <input id="testing-password" type="password" autocomplete="off">
    </div>
    <div id="testing-error" class="error hidden"></div>
    <button class="btn primary small" id="testing-unlock" type="button">Unlock premium</button>`;
  const input = area.querySelector('#testing-password');
  const errorEl = area.querySelector('#testing-error');
  const unlock = async () => {
    const value = input.value; // raw, exactly like the app — no trim
    if (!value) return;
    const result = await attemptUnlock(value);
    if (result === 'ok') {
      input.value = '';
      renderDynamic();
      toast('Premium is on for this device.');
    } else if (result === 'locked') {
      renderDynamic();
    } else if (result === 'wrong') {
      errorEl.textContent = "That password didn't work.";
      errorEl.classList.remove('hidden');
    }
  };
  area.querySelector('#testing-unlock').addEventListener('click', unlock);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  input.focus();
}

function tapTestedLine() {
  if (doorOpen || isTestingPremium()) return;
  const now = Date.now();
  if (now - lastLineTap > TAP_WINDOW_MS) lineTaps = 1;
  else lineTaps += 1;
  lastLineTap = now;
  if (lineTaps >= 3) {
    lineTaps = 0;
    lastLineTap = 0;
    doorOpen = true;
    renderDynamic();
  }
}

/// Wire the hidden door on the entry gate (the only place the app has
/// it): a small muted ⓘ top-right of the gate opens the About sheet.
/// Call once, from the gate page.
export function initTesting() {
  if (initialized) return;
  initialized = true;
  const overlay = buildSheet();
  els = { overlay, dynamic: overlay.querySelector('#about-dynamic') };
  const open = () => {
    applyAdsGate();
    renderDynamic();
    overlay.classList.remove('hidden');
  };
  const close = () => overlay.classList.add('hidden');
  document.getElementById('btn-about')?.addEventListener('click', open);
  overlay.querySelector('#about-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.querySelector('#about-tested-line').addEventListener('click', tapTestedLine);
  applyAdsGate();
}
