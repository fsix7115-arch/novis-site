// Friends — a faithful web mirror of the app's FriendsRepository +
// FriendsScreen + group invites: friends list (public profiles
// only), add-by-code with the app's exact error mapping, unfriend,
// incoming group invites (accept → seat + join the room), and
// hosting a friends group call (pick up to 3 — the room holds 4).
// Friends need a signed-up account; guests get the pitch.
import { supabase, LS, currentUser, fetchPublicProfile, toast } from './supabase.js';
import { applyAdsGate } from './testing.js';
import { avatarEl } from './avatars.js';

const $ = (id) => document.getElementById(id);
const MAX_GROUP_FRIENDS = 3; // GroupCallRepository.maxParticipants = 4

let myId = null;
let friends = []; // PublicProfile rows, newest first
let selecting = false;
const selected = new Set();
let invitesChannel = null;

function friendlyError(e) {
  const msg = String(e?.message ?? e ?? '');
  if (msg.includes('Invalid friend code')) return 'Invalid friend code';
  if (msg.includes('yourself')) return 'You cannot add yourself';
  if (msg.includes('Profile required')) return 'Create an account first to add friends';
  return 'Could not add friend. Check the code and try again.';
}

/// add_friend_by_code — null on success, else the app's message.
async function addFriendByCode(code) {
  try {
    const { data, error } = await supabase.rpc('add_friend_by_code', {
      p_code: code.trim().toUpperCase(),
    });
    if (error) throw error;
    if (data?.added === true) return null;
    return 'Could not add friend. Check the code and try again.';
  } catch (e) {
    return friendlyError(e);
  }
}

/// Unfriend deletes both direction rows the client can reach (the
/// reverse delete harmlessly no-ops if RLS does not allow it).
async function unfriend(friendId) {
  await supabase.from('friends').delete().eq('user_id', myId).eq('friend_id', friendId);
  try {
    await supabase.from('friends').delete().eq('user_id', friendId).eq('friend_id', myId);
  } catch { /* allowed to fail silently, like the app */ }
}

async function loadFriends() {
  const { data: rows } = await supabase
    .from('friends').select('friend_id')
    .eq('user_id', myId)
    .order('created_at', { ascending: false });
  const ids = (rows ?? []).map((r) => r.friend_id);
  if (!ids.length) {
    friends = [];
    return renderFriends();
  }
  const { data: profiles } = await supabase
    .from('public_profiles').select().in('id', ids);
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  friends = ids.map((id) => byId.get(id)).filter(Boolean);
  renderFriends();
}

function renderFriends() {
  const list = $('friendsList');
  list.innerHTML = '';
  $('friendsEmpty').classList.toggle('hidden', friends.length > 0);
  for (const f of friends) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.appendChild(avatarEl({ name: f.display_name, avatarUrl: f.avatar_url, size: 44 }));
    const grow = document.createElement('span');
    grow.className = 'grow';
    const nameEl = document.createElement('div');
    nameEl.style.fontWeight = '700';
    nameEl.textContent = f.display_name ?? 'Stranger';
    grow.appendChild(nameEl);
    if (f.bio) {
      const bio = document.createElement('div');
      bio.className = 'sub';
      bio.textContent = f.bio;
      grow.appendChild(bio);
    }
    row.appendChild(grow);
    if (selecting) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.style.width = '20px';
      check.style.height = '20px';
      check.checked = selected.has(f.id);
      check.addEventListener('change', () => {
        if (check.checked) {
          if (selected.size >= MAX_GROUP_FRIENDS) {
            check.checked = false;
            return toast('Group calls hold 4 people — you plus 3 friends.');
          }
          selected.add(f.id);
        } else {
          selected.delete(f.id);
        }
        $('btnStartGroup').disabled = selected.size === 0;
      });
      row.appendChild(check);
    } else {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.type = 'button';
      btn.textContent = 'Unfriend';
      let armed = false;
      let armTimer = null;
      btn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          btn.textContent = 'Tap again to unfriend';
          armTimer = setTimeout(() => { armed = false; btn.textContent = 'Unfriend'; }, 3000);
          return;
        }
        clearTimeout(armTimer);
        await unfriend(f.id);
        selected.delete(f.id);
        await loadFriends();
        toast('Friend removed.');
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
  $('startRow').classList.toggle('hidden', !selecting);
  $('btnStartGroup').disabled = selected.size === 0;
}

/// Host a friends group call: create the room, seat myself, invite
/// the selected friends, and go straight in (video only — the
/// owner's video-only rule; the app's voice option is not offered).
async function startGroupCall() {
  if (!selected.size) return;
  const btn = $('btnStartGroup');
  btn.disabled = true;
  try {
    const { data: room, error } = await supabase
      .from('chat_rooms').insert({ mode: 'group' }).select('id').single();
    if (error) throw error;
    const roomId = room.id;
    const { error: seatError } = await supabase
      .from('room_participants')
      .insert({ room_id: roomId, user_id: myId, role: 'peer' });
    if (seatError) throw seatError;
    for (const toId of selected) {
      await supabase.from('group_invites').insert({
        room_id: roomId, from_id: myId, to_id: toId, is_video: true,
      });
    }
    location.href = `call.html?room=${roomId}&group=1`;
  } catch (e) {
    toast(`Could not start the group call: ${e.message ?? e}`);
    btn.disabled = false;
  }
}

// ---- Incoming group invites ------------------------------------------
async function loadInvites() {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: rows } = await supabase
    .from('group_invites').select()
    .eq('to_id', myId).eq('status', 'pending')
    .gt('created_at', since)
    .order('created_at', { ascending: false });
  const invites = rows ?? [];
  $('invitesCard').classList.toggle('hidden', invites.length === 0);
  const list = $('invitesList');
  list.innerHTML = '';
  for (const invite of invites) {
    const profile = await fetchPublicProfile(invite.from_id).catch(() => null);
    const name = profile?.display_name?.trim() || 'A friend';
    const row = document.createElement('div');
    row.className = 'list-row';
    row.appendChild(avatarEl({ name, avatarUrl: profile?.avatar_url, size: 44 }));
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = `${name} invited you to a group video call`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'Join them now — the room waits for no one.';
    grow.appendChild(sub);
    const accept = document.createElement('button');
    accept.className = 'btn primary small';
    accept.type = 'button';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => respondInvite(invite, true));
    const decline = document.createElement('button');
    decline.className = 'icon-btn';
    decline.type = 'button';
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => respondInvite(invite, false));
    row.append(grow, accept, decline);
    list.appendChild(row);
  }
}

async function respondInvite(invite, accept) {
  await supabase
    .from('group_invites')
    .update({ status: accept ? 'accepted' : 'declined' })
    .eq('id', invite.id);
  if (!accept) {
    toast('Invitation declined.');
    return loadInvites();
  }
  // Seat myself in the room (unique room+user — a repeat is a no-op),
  // then go straight into the group call page.
  const { error } = await supabase
    .from('room_participants')
    .insert({ room_id: invite.room_id, user_id: myId, role: 'peer' });
  if (error && error.code !== '23505') {
    toast('That group is no longer available.');
    return loadInvites();
  }
  location.href = `call.html?room=${invite.room_id}&group=1`;
}

function watchInvites() {
  if (invitesChannel) supabase.removeChannel(invitesChannel);
  invitesChannel = supabase
    .channel(`group-invites-in-${myId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'group_invites',
      filter: `to_id=eq.${myId}`,
    }, () => loadInvites())
    .subscribe();
}

async function boot() {
  applyAdsGate();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  myId = user.id;
  $('friendsLoading').classList.add('hidden');

  if (user.is_anonymous) {
    $('view-pitch').classList.remove('hidden');
    return;
  }
  $('view-friends').classList.remove('hidden');

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('addInput').value;
    if (!code.trim()) return;
    const problem = await addFriendByCode(code);
    if (problem) return toast(problem);
    $('addInput').value = '';
    toast('Friend added.');
    await loadFriends();
  });
  $('btnSelectMode').addEventListener('click', () => {
    selecting = !selecting;
    if (!selecting) selected.clear();
    $('btnSelectMode').textContent = selecting ? 'Cancel' : 'Start group call';
    $('selectHint').classList.toggle('hidden', !selecting);
    renderFriends();
  });
  $('btnStartGroup').addEventListener('click', startGroupCall);

  await loadFriends();
  await loadInvites();
  watchInvites();
}

boot();
