// Settings — mirrors the app's SettingsScreen sections that the
// website has: Calls ('Speaker on top'), Ads Time (server balance +
// toggle), Appearance (accent themes behind the shared premium
// clock) and sign-out. The speaker toggle writes the same
// localStorage key the call page reads, so it drives group frame
// ordering directly.
import { supabase, LS, currentUser, toast } from './supabase.js';
import { applyAdsGate } from './testing.js';
import {
  premiumActive, adPremiumActive, premiumUntilMs,
  formatPremiumTimeLeft, renderUnlockNote,
} from './premium.js';

const $ = (id) => document.getElementById(id);
const SPEAKER_KEY = 'novis_speaker_on_top'; // app's prefs key
const ACCENT_KEY = 'novis_accent_index'; // app's prefs key

// accent_themes.dart — index 0 is free, the rest are premium.
const ACCENTS = [
  { name: 'Golden Hour', a: '#ff7a18', b: '#8b5cf6' },
  { name: 'Sunset', a: '#ff9100', b: '#ff4081' },
  { name: 'Emerald', a: '#00e676', b: '#00bfa5' },
  { name: 'Solar', a: '#ffd600', b: '#ff9100' },
];

let adsStatus = null; // {balance_minutes, is_active}

function renderSpeaker() {
  let on = false;
  try { on = localStorage.getItem(SPEAKER_KEY) === '1'; } catch { /* default OFF */ }
  $('speakerSwitch').checked = on;
}

function renderAppearance() {
  let selected = 0;
  try {
    selected = Number.parseInt(localStorage.getItem(ACCENT_KEY) ?? '0', 10) || 0;
  } catch { /* default */ }
  selected = Math.min(Math.max(selected, 0), ACCENTS.length - 1);
  const unlocked = premiumActive();
  const list = $('accentList');
  list.innerHTML = '';
  ACCENTS.forEach((accent, i) => {
    const locked = i > 0 && !unlocked;
    const row = document.createElement('button');
    row.className = `accent-row${locked ? ' locked' : ''}`;
    row.type = 'button';
    const dot = document.createElement('span');
    dot.className = 'accent-dot';
    dot.style.background = `linear-gradient(135deg, ${accent.a}, ${accent.b})`;
    const name = document.createElement('span');
    name.style.flex = '1';
    name.textContent = accent.name;
    row.append(dot, name);
    if (locked) {
      const lock = document.createElement('span');
      lock.textContent = '🔒';
      row.appendChild(lock);
    } else if (i === selected) {
      const check = document.createElement('span');
      check.textContent = '✓';
      check.style.color = 'var(--glow-amber)';
      check.style.fontWeight = '800';
      row.appendChild(check);
    }
    row.addEventListener('click', () => {
      if (locked) return; // bonus themes open only while premium is live
      try { localStorage.setItem(ACCENT_KEY, String(i)); } catch { /* cosmetic */ }
      // Apply immediately, like the app's AccentController.
      if (i === 0) {
        document.documentElement.style.removeProperty('--sunset-orange');
        document.documentElement.style.removeProperty('--sunset-violet');
      } else {
        document.documentElement.style.setProperty('--sunset-orange', accent.a);
        document.documentElement.style.setProperty('--sunset-violet', accent.b);
      }
      renderAppearance();
    });
    list.appendChild(row);
  });

  const note = $('appearanceNote');
  note.innerHTML = '';
  if (unlocked) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Premium is on — all themes unlocked.';
    note.appendChild(p);
    if (adPremiumActive()) {
      const left = document.createElement('p');
      left.className = 'note';
      left.textContent = `Premium time left: ${formatPremiumTimeLeft(premiumUntilMs() - Date.now())}`;
      note.appendChild(left);
    }
  } else {
    renderUnlockNote(note);
  }
}

async function loadAdsTime() {
  try {
    const { data, error } = await supabase.rpc('ads_time_status');
    if (error) throw error;
    adsStatus = {
      balance_minutes: Number(data?.balance_minutes ?? 0),
      is_active: data?.is_active === true,
    };
  } catch {
    adsStatus = null;
  }
  const sw = $('adsSwitch');
  if (!adsStatus) {
    $('adsBalance').textContent = '…';
    sw.disabled = true;
    return;
  }
  $('adsBalance').textContent = `${adsStatus.balance_minutes} min`;
  sw.checked = adsStatus.is_active;
  sw.disabled = adsStatus.balance_minutes === 0 && !adsStatus.is_active;
}

async function setAdsActive(on) {
  const sw = $('adsSwitch');
  try {
    const { data, error } = await supabase.rpc('ads_time_set_active', { p_on: on });
    if (error) throw error;
    adsStatus = {
      balance_minutes: Number(data?.balance_minutes ?? adsStatus?.balance_minutes ?? 0),
      is_active: data?.is_active === true,
    };
    $('adsBalance').textContent = `${adsStatus.balance_minutes} min`;
    sw.checked = adsStatus.is_active;
    sw.disabled = adsStatus.balance_minutes === 0 && !adsStatus.is_active;
  } catch {
    sw.checked = !on; // revert, like the app's failed toggle
    toast('Could not update Ads Time. Please try again.');
  }
}

async function boot() {
  applyAdsGate();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');

  renderSpeaker();
  $('speakerSwitch').addEventListener('change', (e) => {
    try {
      localStorage.setItem(SPEAKER_KEY, e.target.checked ? '1' : '0');
    } catch { /* cosmetic preference only */ }
  });
  renderAppearance();
  $('adsSwitch').addEventListener('change', (e) => setAdsActive(e.target.checked));
  await loadAdsTime();
  $('btnSignOut').addEventListener('click', async () => {
    await supabase.auth.signOut();
    try { localStorage.removeItem(LS.choice); } catch { /* ignore */ }
    location.replace('index.html');
  });
}

boot();
