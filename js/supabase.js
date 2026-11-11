// Shared Supabase client + account helpers for the Novis website.
// Same project, same auth, same tables/RPCs as the Android app —
// see novis-build/lib/features/auth + profile repositories.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const supabase = createClient(
  window.NOVIS_CONFIG.supabaseUrl,
  window.NOVIS_CONFIG.supabaseAnonKey,
);

export const LS = {
  choice: 'novis_entry_choice', // EntryGateStore equivalent: login | signup | guest
  age: 'novis_age_confirmed',
  chatFloat: 'novis_chat_float', // floating chat geometry {left, top, width, height}
};

export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export async function myProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, account_type')
    .eq('id', user.id)
    .maybeSingle();
  return data;
}

/// Another user's public face (public_profiles view — display fields
/// only, never email). Mirrors ProfileRepository.fetchPublicProfile.
export async function fetchPublicProfile(id) {
  const { data } = await supabase
    .from('public_profiles')
    .select()
    .eq('id', id)
    .maybeSingle();
  return data;
}

export async function upsertProfile(fields) {
  const user = await currentUser();
  if (!user) return;
  await supabase.from('profiles').upsert({
    id: user.id,
    last_seen_at: new Date().toISOString(),
    ...fields,
  });
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// Ban gate (AuthRepository.checkCurrentUserBanned): hashes only are
/// sent and it fails open — an RPC error must never lock out a good
/// user. The device hash is a stable per-browser value; it cannot
/// equal the Android fingerprint, so only an email-hash ban can match
/// here — same one-way protection the app gets from its email hash.
export async function checkBanned(user) {
  try {
    let deviceId = localStorage.getItem('novis_device_id');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('novis_device_id', deviceId);
    }
    const { data } = await supabase.rpc('check_ban', {
      p_email_hash: user?.email ? await sha256Hex(user.email.trim().toLowerCase()) : null,
      p_device_hash: await sha256Hex(deviceId + navigator.userAgent),
    });
    return data === true;
  } catch {
    return false;
  }
}

let toastTimer = null;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
