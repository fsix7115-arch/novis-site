// Home — a real scrollable page. Guards bounce to the gate, which
// owns the ban / age / name routing.
import { supabase, LS, currentUser, myProfile, toast } from './supabase.js';
import { loadHistory, minutesLeft } from './history-store.js';

async function boot() {
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  const profile = await myProfile();
  if (!profile?.display_name?.trim()) return location.replace('index.html');

  document.getElementById('view-splash').classList.add('hidden');
  document.getElementById('view-home').classList.remove('hidden');

  const chip = document.getElementById('account-chip');
  chip.textContent = user.is_anonymous
    ? `Guest · ${profile.display_name}`
    : `${profile.display_name} · ${user.email ?? ''}`;

  document.getElementById('btn-id').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      toast('Your Novis ID was copied.');
    } catch {
      toast(`Your Novis ID: ${user.id}`);
    }
  });
  document.getElementById('btn-signout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    localStorage.removeItem(LS.choice);
    location.replace('index.html');
  });
  for (const tile of document.querySelectorAll('[data-soon]')) {
    tile.addEventListener('click', () => toast(tile.dataset.soon));
  }

  const entries = loadHistory();
  if (entries.length > 0) {
    const first = entries[0];
    document.getElementById('recent-summary').textContent =
      `${entries.length} recent chat${entries.length > 1 ? 's' : ''} · latest stays for ${minutesLeft(first)} more minutes`;
    document.getElementById('recent-link').classList.remove('hidden');
  }
}

boot();
