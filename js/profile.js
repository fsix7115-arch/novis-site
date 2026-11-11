// Profile — a faithful web mirror of the app's ProfileScreen +
// ProfileRepository: preset avatars, display name + bio editing,
// the golden profile frame (premium cosmetic), the VISIBLE friend &
// referral code (owner rule: the code must be visible to its owner
// so it can be shared), Novis ID, sign-out. Anonymous guests get the
// app's account pitch — a profile needs a free account, and referral
// only ever belongs to signed-up users.
import { supabase, LS, currentUser, toast } from './supabase.js';
import { applyAdsGate } from './testing.js';
import { premiumActive, renderUnlockNote } from './premium.js';
import { PRESET_GRADIENTS, presetValue, presetIndex, avatarEl } from './avatars.js';

const $ = (id) => document.getElementById(id);
const GOLDEN_KEY = 'novis_golden_frame_selected'; // app's prefs key

let myId = null;
let avatarIndex = 0;
let saving = false;

function goldenSelected() {
  try { return localStorage.getItem(GOLDEN_KEY) === 'true'; } catch { return false; }
}
function goldenFrameOn() {
  return goldenSelected() && premiumActive();
}

function renderAvatar() {
  const preview = $('avatarPreview');
  preview.innerHTML = '';
  preview.appendChild(avatarEl({
    name: $('fieldName').value, avatarUrl: presetValue(avatarIndex),
    size: 84, golden: goldenFrameOn(),
  }));
  const row = $('presetRow');
  row.innerHTML = '';
  PRESET_GRADIENTS.forEach(([a, b], i) => {
    const btn = document.createElement('button');
    btn.className = `preset-pick${i === avatarIndex ? ' selected' : ''}`;
    btn.type = 'button';
    btn.title = `Avatar ${i + 1}`;
    const dot = document.createElement('span');
    dot.className = 'avatar';
    dot.style.width = '40px';
    dot.style.height = '40px';
    dot.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    btn.appendChild(dot);
    btn.addEventListener('click', () => { avatarIndex = i; renderAvatar(); });
    row.appendChild(btn);
  });
}

function renderGolden() {
  const control = $('goldenControl');
  const note = $('goldenNote');
  control.innerHTML = '';
  note.innerHTML = '';
  if (premiumActive()) {
    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = goldenSelected();
    input.addEventListener('change', () => {
      try { localStorage.setItem(GOLDEN_KEY, input.checked ? 'true' : 'false'); } catch { /* cosmetic */ }
      renderGolden();
      renderAvatar();
    });
    const track = document.createElement('span');
    track.className = 'track';
    label.append(input, track);
    control.appendChild(label);
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = goldenSelected()
      ? 'The golden frame is on your profile picture.'
      : 'Premium is on — the golden frame is ready when you are.';
    note.appendChild(p);
  } else {
    const lock = document.createElement('span');
    lock.textContent = '🔒';
    lock.style.fontSize = '18px';
    control.appendChild(lock);
    renderUnlockNote(note);
  }
}

async function load() {
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, bio, avatar_url, friend_code')
    .eq('id', myId).maybeSingle();
  $('fieldName').value = profile?.display_name ?? '';
  $('fieldBio').value = profile?.bio ?? '';
  avatarIndex = presetIndex(profile?.avatar_url) ?? 0;
  $('myFullId').textContent = myId;
  renderAvatar();
  renderGolden();
  let code = profile?.friend_code ?? null;
  if (!code) {
    // The app ensures a code when the profile opens.
    const { data } = await supabase.rpc('ensure_friend_code');
    code = typeof data === 'string' ? data : null;
  }
  $('friendCode').textContent = code ?? '—';
}

async function save() {
  if (saving) return;
  const name = $('fieldName').value.trim();
  const bio = $('fieldBio').value;
  const errEl = $('profileError');
  errEl.classList.add('hidden');
  if (!name) {
    errEl.textContent = 'Please add a display name.';
    errEl.classList.remove('hidden');
    return;
  }
  saving = true;
  $('btnSave').disabled = true;
  try {
    const { error } = await supabase.from('profiles').upsert({
      id: myId,
      display_name: name,
      bio,
      avatar_url: presetValue(avatarIndex),
      last_seen_at: new Date().toISOString(),
    });
    if (error) throw error;
    toast('Profile saved.');
    renderAvatar();
  } catch (e) {
    errEl.textContent = `Could not save: ${e.message ?? e}`;
    errEl.classList.remove('hidden');
  } finally {
    saving = false;
    $('btnSave').disabled = false;
  }
}

async function regenerateCode() {
  const { data, error } = await supabase.rpc('regenerate_friend_code');
  if (error || typeof data !== 'string') {
    toast('Could not generate a new code just now.');
    return;
  }
  $('friendCode').textContent = data;
  const note = $('codeNote');
  note.textContent = 'Your old code no longer works — share the new one.';
  note.classList.remove('hidden');
}

async function signOut() {
  await supabase.auth.signOut();
  try { localStorage.removeItem(LS.choice); } catch { /* ignore */ }
  location.replace('index.html');
}

async function boot() {
  applyAdsGate();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  myId = user.id;
  $('profileLoading').classList.add('hidden');

  if (user.is_anonymous) {
    // Guest pitch — the anon card shows how strangers see them.
    const { data: profile } = await supabase
      .from('profiles').select('display_name, avatar_url')
      .eq('id', myId).maybeSingle();
    $('pitchAvatar').appendChild(avatarEl({
      name: profile?.display_name, avatarUrl: profile?.avatar_url,
      size: 56, golden: goldenFrameOn(),
    }));
    $('pitchName').textContent = profile?.display_name ?? 'Novis guest';
    $('pitchShortId').textContent = myId.slice(0, 8);
    $('view-pitch').classList.remove('hidden');
    return;
  }

  $('view-form').classList.remove('hidden');
  $('fieldName').addEventListener('input', renderAvatar);
  $('btnSave').addEventListener('click', save);
  $('btnNewCode').addEventListener('click', regenerateCode);
  $('btnSignOut').addEventListener('click', signOut);
  $('btnCopyId').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(myId);
      toast('Your Novis ID was copied.');
    } catch {
      toast(`Your Novis ID: ${myId}`);
    }
  });
  await load();
}

boot();
