// Ads Time — a faithful web mirror of the app's AdsTimeScreen. The
// balance lives ONLY on the server (AdMob SSV credits it); this page
// never credits anything locally. Earning happens by watching
// rewarded ads — on the web, exactly like the app's own non-Android
// builds, that means the honest line "Watch ads to earn Ads Time in
// the Android app." The separate premium clock (cosmetic locks,
// +24h per rewarded ad) is displayed alongside, per premium.js.
import { supabase, LS, currentUser, toast } from './supabase.js';
import { applyAdsGate, isTestingPremium } from './testing.js';
import {
  premiumActive, adPremiumActive, premiumUntilMs,
  formatPremiumTimeLeft, renderUnlockNote,
} from './premium.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let status = null; // {balance_minutes, is_active}

/// Ledger labels — ported from AdsTimeLedgerEntry.label.
function ledgerLabel(entry) {
  const d = Number(entry.delta_minutes ?? 0);
  if (d < 0) return `Ad-free time −${-d}`;
  if (entry.source === 'referral') return `Referral +${d}`;
  if (entry.source === 'spend') return `Ad-free time +${d}`;
  return `Watched ad +${d}`;
}

/// 'd MMM, HH:mm' — the app's history date format.
function ledgerDate(iso) {
  const dt = new Date(iso);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}, ${hh}:${mm}`;
}

function renderStatus() {
  $('balanceBig').textContent = `${status.balance_minutes} min`;
  const sw = $('adsSwitchPage');
  sw.checked = status.is_active;
  sw.disabled = !(status.balance_minutes > 0 || status.is_active);
  $('activeText').textContent = status.is_active
    ? 'Ads Time is ON — no ads will run. Your balance counts down only while it is on.'
    : 'Turn on to enjoy Novis with zero ads. Your balance is saved while it is off.';
  const earn = $('earnNote');
  if (isTestingPremium()) {
    earn.textContent = 'Testing premium is on — all ads are off across Novis.';
    earn.style.color = 'var(--warning)';
  } else if (status.is_active) {
    earn.textContent = 'Ads Time is on — earning is paused while no ads run.';
    earn.style.color = 'var(--warning)';
  } else {
    // AdsService is unsupported on web — the app's own fallback line.
    earn.textContent = 'Watch ads to earn Ads Time in the Android app.';
    earn.style.color = '';
  }
  renderPremium();
}

function renderPremium() {
  const note = $('premiumNote');
  note.innerHTML = '';
  if (isTestingPremium()) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Testing premium is on — every lock is open and all ads are off.';
    note.appendChild(p);
    return;
  }
  if (adPremiumActive()) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = `Premium time left: ${formatPremiumTimeLeft(premiumUntilMs() - Date.now())} — every lock is open.`;
    note.appendChild(p);
    return;
  }
  if (premiumActive()) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Premium is on — every lock is open.';
    note.appendChild(p);
    return;
  }
  renderUnlockNote(note);
}

async function load() {
  $('adsLoading').classList.remove('hidden');
  $('view-error').classList.add('hidden');
  $('view-ads').classList.add('hidden');
  try {
    const { data, error } = await supabase.rpc('ads_time_status');
    if (error) throw error;
    status = {
      balance_minutes: Number(data?.balance_minutes ?? 0),
      is_active: data?.is_active === true,
    };
    const { data: rows } = await supabase
      .from('ads_time_ledger').select()
      .order('created_at', { ascending: false }).limit(50);
    const list = $('ledgerList');
    list.innerHTML = '';
    const entries = rows ?? [];
    $('ledgerEmpty').classList.toggle('hidden', entries.length > 0);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const label = document.createElement('span');
      label.className = 'grow';
      label.textContent = ledgerLabel(entry);
      const when = document.createElement('span');
      when.className = 'sub muted';
      when.style.fontSize = '13px';
      when.style.color = 'var(--text-muted)';
      when.textContent = ledgerDate(entry.created_at);
      row.append(label, when);
      list.appendChild(row);
    }
    $('adsLoading').classList.add('hidden');
    $('view-ads').classList.remove('hidden');
    renderStatus();
  } catch {
    $('adsLoading').classList.add('hidden');
    $('view-error').classList.remove('hidden');
  }
}

async function setActive(on) {
  const sw = $('adsSwitchPage');
  sw.disabled = true;
  try {
    const { data, error } = await supabase.rpc('ads_time_set_active', { p_on: on });
    if (error) throw error;
    status = {
      balance_minutes: Number(data?.balance_minutes ?? status.balance_minutes),
      is_active: data?.is_active === true,
    };
    renderStatus();
  } catch {
    sw.checked = !on;
    sw.disabled = false;
    toast(on
      ? 'No Ads Time balance available yet — watch an ad first.'
      : 'Could not update Ads Time. Please try again.');
  }
}

async function boot() {
  applyAdsGate();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  $('btnAdsRetry').addEventListener('click', load);
  $('adsSwitchPage').addEventListener('change', (e) => setActive(e.target.checked));
  await load();
}

boot();
