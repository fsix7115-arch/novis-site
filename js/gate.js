// Entry gate — mirrors the app's EntryGateScreen + splash routing:
// choice remembered, signed-in users skip the gate, then ban gate,
// 18+ gate, one-time name ask, Home (in that order).
import {
  supabase, LS, currentUser, myProfile, upsertProfile, checkBanned, toast,
} from './supabase.js';

const views = ['splash', 'gate', 'login', 'signup', 'age', 'name', 'banned', 'exit'];
function show(name) {
  for (const v of views) {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
  }
}

function formError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

/// Post-entry routing shared by all three entry choices.
async function routeAfterEntry() {
  const user = await currentUser();
  if (!user) return show('gate');
  if (await checkBanned(user)) return show('banned');
  if (localStorage.getItem(LS.age) !== '1') return show('age');
  const profile = await myProfile();
  if (!profile?.display_name?.trim()) return show('name');
  location.href = 'home.html';
}

async function boot() {
  const user = await currentUser();
  if (user) return routeAfterEntry(); // signed-in users skip the gate
  show('gate');
}

document.getElementById('btn-login').addEventListener('click', () => show('login'));
document.getElementById('btn-signup').addEventListener('click', () => show('signup'));
document.getElementById('login-back').addEventListener('click', (e) => { e.preventDefault(); show('gate'); });
document.getElementById('signup-back').addEventListener('click', (e) => { e.preventDefault(); show('gate'); });

document.getElementById('btn-guest').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    e.target.disabled = false;
    return toast(`Guest sign-in failed: ${error.message}`);
  }
  localStorage.setItem(LS.choice, 'guest');
  routeAfterEntry();
});

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('login-error', '');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return formError('login-error', error.message);
  localStorage.setItem(LS.choice, 'login');
  routeAfterEntry();
});

document.getElementById('form-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('signup-error', '');
  const name = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-password').value;
  const referral = document.getElementById('su-referral').value.trim();
  if (name.length < 2 || name.length > 30) {
    return formError('signup-error', 'Pick a name between 2 and 30 characters.');
  }
  // Same temp-mail guard as the app (AuthRepository.signUpWithEmail).
  try {
    const { data: blocked } = await supabase.rpc('is_email_domain_blocked', {
      p_email: email.toLowerCase(),
    });
    if (blocked === true) {
      return formError('signup-error', 'Temporary email addresses are not allowed');
    }
  } catch { /* the server still enforces its own rules at sign-up */ }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return formError('signup-error', error.message);
  if (!data.session) {
    // Only reachable if email confirmation is switched back on
    // server-side; today sign-up returns an instant session.
    const note = document.getElementById('signup-note');
    note.textContent = 'Account created. Please confirm your email, then log in.';
    note.classList.remove('hidden');
    return show('login');
  }
  // Profile sync + one-time referral claim (syncEmailProfileAndReferral).
  await upsertProfile({ account_type: 'email', display_name: name });
  if (referral) {
    const { error: claimError } = await supabase.rpc('claim_referral', { p_code: referral });
    if (claimError) {
      const msg = claimError.message.toLowerCase();
      if (!msg.includes('already') && !msg.includes('own referral')) {
        toast('Referral code could not be applied. Please check the code with the person who shared it.');
      }
    }
  }
  localStorage.setItem(LS.choice, 'signup');
  routeAfterEntry();
});

document.getElementById('btn-age-yes').addEventListener('click', async () => {
  localStorage.setItem(LS.age, '1');
  // Best-effort server record, like AuthRepository.confirmAge.
  await upsertProfile({ is_age_verified: true });
  const profile = await myProfile();
  if (!profile?.display_name?.trim()) return show('name');
  location.href = 'home.html';
});
document.getElementById('btn-age-no').addEventListener('click', () => show('exit'));

document.getElementById('form-name').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('name-error', '');
  const name = document.getElementById('name-input').value.trim();
  if (name.length < 2 || name.length > 30) {
    return formError('name-error', 'Pick a name between 2 and 30 characters.');
  }
  await upsertProfile({ display_name: name });
  location.href = 'home.html';
});

boot();
