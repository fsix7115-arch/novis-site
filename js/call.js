// Novis video call — a faithful web mirror of the app's direct
// stranger-video flow (novis-build/lib/features/call/presentation/
// controllers/call_controller.dart + matchmaking + signaling + chat
// repositories). Same Supabase backend, same wire protocol, so web
// and Android users share one stranger pool:
//  - matching: find_or_join_match RPC + matchmaking_queue realtime
//    updates + 12s re-poll (queue tickets expire server-side)
//  - signaling: PRIVATE broadcast channel `call-<roomId>`, event
//    'signal', payload key 'kind' (never 'type'), ready/offer/answer/
//    ice handshake, offerer acts on the peer's 'ready', answerer
//    echoes 'ready' once
//  - chat: public.messages rows + INSERT realtime + private typing
//    broadcast on `chat-<roomId>`
import {
  supabase, LS, currentUser, myProfile, fetchPublicProfile, toast,
} from './supabase.js';
import { saveHistory } from './history-store.js';
import { applyAdsGate } from './testing.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('statusDot'), status: $('statusText'), duration: $('duration'),
  remoteVideo: $('remoteVideo'), localVideo: $('localVideo'),
  remotePh: $('remotePlaceholder'), phTitle: $('remoteStateTitle'),
  phText: $('remoteStateText'), prepareCount: $('prepareCount'),
  peerName: $('peerName'), selfName: $('selfName'),
  peerHand: $('peerHandBadge'), peerMute: $('peerMuteBadge'),
  selfHand: $('selfHandBadge'), selfMute: $('selfMuteBadge'),
  pauseBanner: $('pauseBanner'), unmuteBanner: $('unmuteBanner'),
  soundBanner: $('soundBanner'), failBanner: $('failBanner'), failText: $('failText'),
  chatPanel: $('chatPanel'), chatLog: $('chatLog'), chatForm: $('chatForm'),
  chatInput: $('chatInput'), typing: $('typingLine'),
  btnMic: $('btnMic'), micLabel: $('micLabel'), btnFlip: $('btnFlip'),
  btnSpeaker: $('btnSpeaker'), btnHand: $('btnHand'), btnPause: $('btnPause'),
  btnNext: $('btnNext'), btnEnd: $('btnEnd'), btnAdd: $('btnAdd'),
  btnUnmuteNow: $('btnUnmuteNow'), btnUnmuteDismiss: $('btnUnmuteDismiss'),
  openPill: $('openPill'), groupOffers: $('groupOffers'),
  groupStack: $('groupStack'), groupSelfSlot: $('groupSelfSlot'),
  groupNotice: $('groupNotice'), selfFrame: $('selfFrame'), selfSlot: $('selfSlot'),
  speakerWrap: $('speakerToggleWrap'), speakerToggle: $('speakerToggle'),
  sheetOverlay: $('sheetOverlay'), sheetCard: $('sheetCard'),
  popupLayer: $('popupLayer'), btnSelfPop: $('btnSelfPop'), btnSelfExpand: $('btnSelfExpand'),
};

const DEFAULT_STUN = 'stun:stun.l.google.com:19302'; // AppConfig.defaultStunUrl
// Metered Open Relay bonus pool — verbatim from CallRepository.
const OPEN_RELAY = [
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const PREPARE_SECONDS = 5;

// ---- session state -------------------------------------------------
let myId = null;
let phase = 'preparing'; // preparing|searching|connecting|connected|paused|failed|ended
let localStream = null;
let facing = 'user';
let isMuted = false;
let handRaised = false;
let speakerOn = true;
let ending = false;

// ---- per-match state ----------------------------------------------
let pc = null;
let roomId = '';
let peerId = null;
let role = 'answerer';
let signalChannel = null;
let messagesChannel = null;
let typingChannel = null;
let offerSent = false;
let localOfferPending = false;
let readyEchoSent = false;
let remoteDescriptionSet = false;
let pendingCandidates = [];
let connectingMatch = false;
let restarting = false;
let segmentOpen = false;
let peerDisplayName = null;
let peerVideoOn = false;
let durationSeconds = 0;
let durationTimer = null;
let levelTimer = null;
let lastUnmuteRequestAt = 0;

// ---- search state ---------------------------------------------------
let matchChannel = null;
let repollTimer = null;
let prepareTimer = null;
let prepareCountdown = null;
let searchGen = 0;

// ---- transcript (one continuous session log) -----------------------
const transcriptMessages = []; // app ChatMessage JSON shape (+ sender_name)
const transcriptLines = []; // app SessionChatLine JSON shape (+ name)
const peopleJoined = new Set();
const seenMessageIds = new Set();
const names = new Map(); // userId -> display name (public_profiles)

// ---- group state (Phase 2) -----------------------------------------
let inGroup = false;
let friendsRoom = false;
let groupPhase = 'idle'; // idle|joining|connected
let roomOpen = false;
let groupHostId = null;
let groupIce = null;
const gPeers = new Map(); // userId -> mesh peer (RTCPeerConnection state)
const tiles = new Map(); // userId -> group tile DOM state
const roster = new Map(); // userId -> {role, joinedAt, active, removed}
const knownActive = new Set(); // roster members currently in the room
const segOpen = new Set(); // userIds with an open transcript segment
const joinOrder = []; // tile order basis: roster join order
const pinnedIds = []; // viewer-local pins, in pin order
const blockedIds = new Set();
const unmuteAskedAt = new Map(); // userId -> last unmute-request time
const speakingIds = new Set();
let lastSpeakerId = null;
let speakerOnTop = false;
let selfPopped = false;
let membershipChannel = null;
let groupStatsTimer = null;
let groupDurationTimer = null;
let groupDurationSeconds = 0;
let reannounceTimer = null;
let rosterReloadTimer = null;
let offersTimer = null;
let noticeTimer = null;
let sheetTarget = null;
let ejecting = false;

// ===================================================================
// Small helpers
// ===================================================================
function setStatus(text, on = false) {
  els.status.textContent = text;
  els.dot.classList.toggle('on', on);
}

function showPlaceholder(title, text, count = '') {
  els.remotePh.classList.remove('hidden');
  els.phTitle.textContent = title;
  els.phText.textContent = text;
  els.prepareCount.textContent = count;
}

function rpc(name, params) {
  return supabase.rpc(name, params).then(({ error }) => {
    if (error) throw error;
  }).catch(() => {}); // bookkeeping must never break a call
}

// ===================================================================
// Matchmaking (MatchmakingRepository + CallController._searchNext)
// ===================================================================
async function ensureServerProfile() {
  if (!myId) return;
  try {
    await supabase.from('profiles').upsert({
      id: myId, is_age_verified: true, last_seen_at: new Date().toISOString(),
    });
  } catch { /* the RPC error below still tells the truth */ }
}

async function findOrJoin() {
  await ensureServerProfile();
  const { data, error } = await supabase.rpc('find_or_join_match', {
    p_mode: 'video', p_language: 'en', p_interests: [],
  });
  if (error) throw error;
  return {
    isMatched: data?.status === 'matched',
    roomId: data?.room_id ?? null,
    role: data?.role ?? null,
    peerId: data?.peer_id ?? null,
    queueId: data?.queue_id ?? null,
  };
}

function stopSearch() {
  searchGen++;
  clearTimeout(prepareTimer); prepareTimer = null;
  clearInterval(prepareCountdown); prepareCountdown = null;
  clearInterval(repollTimer); repollTimer = null;
  if (matchChannel) { supabase.removeChannel(matchChannel); matchChannel = null; }
}

async function searchNext() {
  if (ending) return;
  setPhase('searching');
  const gen = searchGen;
  try {
    const result = await findOrJoin();
    if (ending || gen !== searchGen || phase !== 'searching') return;
    if (result.isMatched) return connectMatch(result);
    matchChannel = supabase
      .channel(`matchmaking-${myId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'matchmaking_queue',
        filter: `user_id=eq.${myId}`,
      }, (payload) => {
        const row = payload.new;
        if (row?.status === 'matched' && row?.room_id) {
          // A waiting user's role is 'offerer' (MatchResult.fromTicketRow).
          connectMatch({ isMatched: true, roomId: row.room_id, role: 'offerer', peerId: null, queueId: row.id });
        }
      })
      .subscribe();
    repollTimer = setInterval(async () => {
      if (ending || phase !== 'searching') return;
      try {
        // The realtime UPDATE on my own ticket is the primary match
        // signal; if it was missed (slow subscribe, network blip),
        // the RPC alone cannot recover it — it never returns an
        // existing match — so read my own latest ticket row first.
        // The latest row during a search is always from this search:
        // every re-poll inserts a fresh one, and a peer flips it to
        // 'matched' when the pair is made.
        const { data: ticket } = await supabase
          .from('matchmaking_queue')
          .select('id, status, room_id')
          .eq('user_id', myId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (ticket?.status === 'matched' && ticket.room_id) {
          return connectMatch({ isMatched: true, roomId: ticket.room_id, role: 'offerer', peerId: null, queueId: ticket.id });
        }
        const again = await findOrJoin();
        if (again.isMatched) connectMatch(again);
      } catch { /* transient failure: keep waiting */ }
    }, 12000);
  } catch (e) {
    fail(`Connection problem while searching: ${e.message ?? e}`);
  }
}

// ===================================================================
// ICE (CallRepository.fetchIceServers)
// ===================================================================
function normalizeIce(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const urls = entry.urls ?? entry.url;
  if (urls == null) return null;
  const out = { urls };
  if (entry.username != null) out.username = entry.username;
  if (entry.credential != null) out.credential = entry.credential;
  return out;
}

async function fetchIceServers() {
  const servers = [{ urls: DEFAULT_STUN }];
  try {
    const { data, error } = await supabase.functions.invoke('turn-credentials');
    if (!error && data && typeof data === 'object') {
      if (Array.isArray(data.iceServers)) {
        for (const entry of data.iceServers) {
          const n = normalizeIce(entry);
          if (n) servers.push(n);
        }
      } else {
        const n = normalizeIce(data);
        if (n) servers.push(n);
      }
    }
  } catch { /* STUN-only fallback, plus the bonus pool below */ }
  servers.push(...OPEN_RELAY);
  return servers;
}

// ===================================================================
// Signaling (SignalingService) — payload key is 'kind', never 'type'
// ===================================================================
function signalPayload(fields) {
  return {
    kind: fields.kind, senderId: myId, to: fields.to ?? null,
    mediaMode: fields.mediaMode ?? null, muted: fields.muted ?? null,
    handRaised: fields.handRaised ?? null, sdp: fields.sdp ?? null,
    sdpType: fields.sdpType ?? null, candidate: fields.candidate ?? null,
  };
}

async function sendSignal(fields) {
  if (!signalChannel) return;
  try {
    await signalChannel.send({ type: 'broadcast', event: 'signal', payload: signalPayload(fields) });
  } catch { /* best effort, like the app */ }
}

function sendPresence() {
  sendSignal({ kind: 'presence', muted: isMuted, handRaised });
}

// ===================================================================
// Chat (ChatRepository) + session transcript
// ===================================================================
function peerLabel() {
  return peerDisplayName || 'Stranger';
}

function nameOf(userId) {
  return names.get(userId) ?? (userId === peerId ? peerLabel() : 'Stranger');
}

async function resolveName(userId) {
  if (!userId || names.has(userId)) return;
  try {
    const profile = await fetchPublicProfile(userId);
    const name = profile?.display_name?.trim();
    if (name) {
      names.set(userId, name);
      sharpenSeparators(userId, name);
      updateTile(userId);
    }
  } catch { /* decoration only */ }
}

function appendSeparator(userId, verb) {
  const line = {
    user_id: userId, verb,
    at: new Date().toISOString(),
    key: `${userId}-${verb}-${Date.now()}`,
    name: nameOf(userId),
  };
  transcriptLines.push(line);
  const div = document.createElement('div');
  div.className = 'sep';
  div.dataset.sepFor = userId;
  div.textContent = `${line.name} ${verb}`;
  els.chatLog.appendChild(div);
  scrollChat();
}

function sharpenSeparators(userId, name) {
  for (const line of transcriptLines) {
    if (line.user_id === userId) line.name = name;
  }
  for (const div of els.chatLog.querySelectorAll(`[data-sep-for="${userId}"]`)) {
    const verb = div.textContent.trim().split(' ').pop();
    div.textContent = `${name} ${verb}`;
  }
}

function appendMessageBubble({ mine, name, content }) {
  const div = document.createElement('div');
  div.className = `msg ${mine ? 'mine' : 'theirs'}`;
  if (!mine && name) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    div.appendChild(who);
  }
  div.appendChild(document.createTextNode(content));
  els.chatLog.appendChild(div);
  scrollChat();
}

function scrollChat() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function appendRoomMessage(row) {
  if (!row || seenMessageIds.has(row.id)) return;
  seenMessageIds.add(row.id);
  const mine = row.sender_id === myId;
  if (!mine) resolveName(row.sender_id);
  transcriptMessages.push({
    id: row.id, room_id: row.room_id, sender_id: row.sender_id,
    content: row.content, created_at: row.created_at,
    reply_to: row.reply_to ?? null, sender_name: mine ? undefined : nameOf(row.sender_id),
  });
  appendMessageBubble({ mine, name: nameOf(row.sender_id), content: row.content });
}

function appendSelfMessage(content) {
  const msg = {
    id: `local-msg-${Date.now()}-${transcriptMessages.length}`,
    room_id: '', sender_id: myId, content,
    created_at: new Date().toISOString(), reply_to: null,
  };
  transcriptMessages.push(msg);
  appendMessageBubble({ mine: true, content });
}

async function attachChat(rid) {
  const { data: rows } = await supabase
    .from('messages').select().eq('room_id', rid)
    .order('created_at', { ascending: true }).limit(200);
  for (const row of rows ?? []) appendRoomMessage(row);

  messagesChannel = supabase
    .channel(`messages-${rid}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `room_id=eq.${rid}`,
    }, (payload) => appendRoomMessage(payload.new))
    .subscribe();

  typingChannel = supabase
    .channel(`chat-${rid}`, { config: { private: true } })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      const from = payload?.sender_id;
      if (!from || from === myId) return;
      // 1:1: only the matched peer is in the room. Group: anyone in
      // the room may be typing — label them by name.
      if (inGroup || from === peerId) {
        resolveName(from);
        showTyping(nameOf(from));
      }
    })
    .subscribe();
}

let typingTimer = null;
function showTyping(label = peerLabel()) {
  els.typing.textContent = `${label} is typing…`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { els.typing.textContent = ''; }, 2600);
}

let lastTypingSent = 0;
function sendTyping() {
  const now = Date.now();
  if (!typingChannel || now - lastTypingSent < 1500) return;
  lastTypingSent = now;
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { sender_id: myId } }).catch(() => {});
}

els.chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = els.chatInput.value.trim();
  if (!content) return;
  if (content.length > 1000) return toast('Message exceeds 1000 characters');
  els.chatInput.value = '';
  if (roomId) {
    const { data: row, error } = await supabase
      .from('messages')
      .insert({ room_id: roomId, sender_id: myId, content, reply_to: null })
      .select().single();
    if (error) return toast('Message could not be sent.');
    appendRoomMessage(row);
  } else {
    appendSelfMessage(content); // waiting self-chat — local only, like the app
  }
});
els.chatInput.addEventListener('input', sendTyping);

// ===================================================================
// WebRTC + handshake (CallController.initialize / _onSignal)
// ===================================================================
async function resolvePeerId(rid) {
  const { data } = await supabase
    .from('room_participants').select('user_id')
    .eq('room_id', rid).neq('user_id', myId).limit(1);
  return data?.[0]?.user_id ?? null;
}

async function loadPeerProfile(id) {
  try {
    const profile = await fetchPublicProfile(id);
    if (!profile || peerId !== id) return;
    const name = profile.display_name?.trim();
    if (name) {
      peerDisplayName = name;
      names.set(id, name);
      els.peerName.textContent = name;
      sharpenSeparators(id, name);
    }
  } catch { /* decoration only — never let it touch the call */ }
}

async function connectMatch(result) {
  if (connectingMatch || !result.roomId) return;
  connectingMatch = true;
  stopSearch();
  roomId = result.roomId;
  role = result.role ?? 'answerer';
  setPhase('connecting');
  try {
    peerId = result.peerId ?? (await resolvePeerId(roomId));
    if (peerId) {
      segmentOpen = true;
      peopleJoined.add(peerId);
      appendSeparator(peerId, 'joined');
      loadPeerProfile(peerId);
    }
    attachChat(roomId);
    await initializeCall();
    syncRoomOpen(roomId); // the Add toggle reflects the server flag
  } catch (e) {
    fail(`Call setup failed: ${e.message ?? e}`);
  }
}

function subscribeAndWait(channel) {
  // Mirrors the Dart join-wait: resolve on SUBSCRIBED, reject on
  // error/timeout status, resolve silently after 10s.
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 10000);
    channel.subscribe((status) => {
      if (done) return;
      if (status === 'SUBSCRIBED') { done = true; clearTimeout(timer); resolve(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        done = true; clearTimeout(timer);
        reject(new Error(`Could not join signaling channel: ${status}`));
      }
    });
  });
}

async function initializeCall() {
  offerSent = false;
  localOfferPending = false;
  readyEchoSent = false;
  remoteDescriptionSet = false;
  pendingCandidates = [];

  const iceServers = await fetchIceServers();
  pc = new RTCPeerConnection({ iceServers });
  for (const track of (localStream?.getTracks() ?? [])) pc.addTrack(track, localStream);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const c = event.candidate;
    sendSignal({
      kind: 'ice',
      candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
    });
  };
  pc.ontrack = (event) => {
    if (!event.streams.length) return;
    els.remoteVideo.srcObject = event.streams[0];
    playRemote();
    if (event.track.kind === 'video') {
      peerVideoOn = true;
      els.remotePh.classList.add('hidden');
    }
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    switch (pc.connectionState) {
      case 'connected':
        if (phase !== 'connected') {
          setPhase('connected');
          startDurationTimer();
          rpc('update_call_status', { p_room_id: roomId, p_status: 'connected' });
          sendPresence();
          startLevelPoll();
        }
        break;
      case 'failed':
        fail('The connection failed. Please try again.');
        break;
      case 'closed':
        if (!ending && phase !== 'ended' && phase !== 'failed') handlePeerHangup();
        break;
      case 'disconnected':
        setStatus('Reconnecting…'); // often transient; WebRTC recovers or escalates
        break;
    }
  };

  signalChannel = supabase.channel(`call-${roomId}`, {
    config: { private: true, broadcast: { self: false } },
  });
  signalChannel.on('broadcast', { event: 'signal' }, ({ payload }) => {
    if (payload?.senderId && payload.senderId !== myId) dispatchSignal(payload);
  });
  await subscribeAndWait(signalChannel);
  await sendSignal({ kind: 'ready' });
}

/// One dispatch for the room channel (Phase 2): in group mode every
/// signal goes to the mesh handler; in 1:1 mode a `group-join` from a
/// THIRD participant (not me, not my peer) while connecting/connected
/// migrates this call into the group mesh on the same room — exactly
/// the app's CallController rule. Everything else is the 1:1 handler.
function dispatchSignal(msg) {
  if (inGroup) return onGroupSignal(msg);
  if (
    msg.kind === 'group-join' && peerId && msg.senderId !== peerId &&
    (phase === 'connecting' || phase === 'connected')
  ) {
    migrateToGroup();
    return;
  }
  return onSignal(msg);
}

async function onSignal(msg) {
  if (ending) return;
  // Only the matched peer may drive this call; until the peer is
  // resolved, adopt the first stranger sender (the app's same rule).
  if (peerId != null && msg.senderId !== peerId) return;
  if ((msg.sdp?.length ?? 0) > 65536) return;
  if (peerId == null && (msg.kind === 'ready' || msg.kind === 'offer')) {
    peerId = msg.senderId;
    segmentOpen = true;
    peopleJoined.add(peerId);
    appendSeparator(peerId, 'joined');
    loadPeerProfile(peerId);
  }
  try {
    switch (msg.kind) {
      case 'presence':
        if (typeof msg.muted === 'boolean') {
          els.peerMute.classList.toggle('hidden', !msg.muted);
        }
        if (typeof msg.handRaised === 'boolean') {
          els.peerHand.classList.toggle('hidden', !msg.handRaised);
        }
        break;
      case 'unmute-request':
        if (msg.to === myId) els.unmuteBanner.classList.remove('hidden');
        break;
      case 'ready':
        if (role === 'offerer') {
          if (!offerSent) { offerSent = true; await makeOffer(); }
        } else if (!readyEchoSent) {
          readyEchoSent = true;
          await sendSignal({ kind: 'ready' });
        }
        break;
      case 'media-mode':
        if (msg.mediaMode === 'audio') {
          peerVideoOn = false;
          showPlaceholder(peerLabel(), 'Audio only — the stranger turned their camera feed off.');
        }
        break;
      case 'offer': {
        if (localOfferPending && role === 'offerer') return; // glare: offerer wins
        localOfferPending = false;
        await pc.setRemoteDescription({ type: msg.sdpType ?? 'offer', sdp: msg.sdp });
        remoteDescriptionSet = true;
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ kind: 'answer', sdp: answer.sdp, sdpType: answer.type });
        break;
      }
      case 'answer':
        localOfferPending = false;
        await pc.setRemoteDescription({ type: msg.sdpType ?? 'answer', sdp: msg.sdp });
        remoteDescriptionSet = true;
        await flushPendingCandidates();
        break;
      case 'ice': {
        const raw = msg.candidate;
        if (!raw) return;
        const candidate = new RTCIceCandidate({
          candidate: raw.candidate, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex,
        });
        if (remoteDescriptionSet && pc) await pc.addIceCandidate(candidate);
        else if (pendingCandidates.length < 100) pendingCandidates.push(candidate);
        break;
      }
      case 'hangup':
        await handlePeerHangup();
        break;
      case 'room-open':
        applyRoomOpen(true);
        break;
      case 'room-closed':
        applyRoomOpen(false);
        break;
      default:
        break; // remaining group kinds belong to the mesh handler
    }
  } catch (e) {
    if (phase === 'connecting') fail(`Call setup failed: ${e.message ?? e}`);
  }
}

async function makeOffer() {
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  localOfferPending = true;
  await sendSignal({ kind: 'offer', sdp: offer.sdp, sdpType: offer.type });
}

async function flushPendingCandidates() {
  if (!pc) return;
  const pending = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of pending) {
    try { await pc.addIceCandidate(candidate); } catch { /* stale candidates are harmless */ }
  }
}

// ===================================================================
// Loop-backs: peer left / Skip / Pause (CallController._returnToSearching)
// ===================================================================
async function handlePeerHangup() {
  if (inGroup) return; // group departures arrive via membership
  await returnToSearching({ notifyPeer: false });
}

async function returnToSearching({ notifyPeer, pause = false }) {
  if (ending || restarting || inGroup) return;
  if (phase !== 'connecting' && phase !== 'connected') return;
  restarting = true;
  stopSearch();
  const rid = roomId;
  if (notifyPeer && rid) await sendSignal({ kind: 'hangup' });
  if (rid) {
    if (segmentOpen && peerId) appendSeparator(peerId, 'left');
    rpc('update_call_status', { p_room_id: rid, p_status: 'ended' });
    rpc('end_room_participation', { p_room_id: rid });
  }
  roomId = '';
  peerId = null;
  peerDisplayName = null;
  segmentOpen = false;
  applyRoomOpen(false);
  groupHostId = null;
  await teardownPeer();
  connectingMatch = false;
  restarting = false;
  setPhase(pause ? 'paused' : 'searching');
  if (!pause) searchNext();
}

async function teardownPeer() {
  clearInterval(durationTimer); durationTimer = null;
  clearInterval(levelTimer); levelTimer = null;
  durationSeconds = 0;
  els.duration.textContent = '';
  offerSent = false; localOfferPending = false;
  readyEchoSent = false; remoteDescriptionSet = false;
  pendingCandidates = [];
  peerVideoOn = false;
  if (pc) { try { pc.close(); } catch { /* already closed */ } pc = null; }
  if (signalChannel) { await supabase.removeChannel(signalChannel); signalChannel = null; }
  if (messagesChannel) { await supabase.removeChannel(messagesChannel); messagesChannel = null; }
  if (typingChannel) { await supabase.removeChannel(typingChannel); typingChannel = null; }
  els.remoteVideo.srcObject = null;
  els.peerName.textContent = 'Stranger';
  els.peerHand.classList.add('hidden');
  els.peerMute.classList.add('hidden');
  els.typing.textContent = '';
}

async function pauseCall() {
  if (inGroup) return; // Pause is 1:1 only — groups have their own leave flow
  if (phase === 'searching') {
    stopSearch();
    await rpc('cancel_matchmaking');
    setPhase('paused');
    return;
  }
  if (phase !== 'connecting' && phase !== 'connected') return;
  await returnToSearching({ notifyPeer: true, pause: true });
}

// ===================================================================
// Phases + UI
// ===================================================================
function setPhase(next) {
  phase = next;
  els.pauseBanner.classList.toggle('hidden', next !== 'paused');
  els.chatPanel.style.display = next === 'paused' ? 'none' : '';
  els.btnPause.disabled = next === 'preparing' || next === 'paused' || next === 'failed';
  els.btnNext.disabled = !(next === 'connecting' || next === 'connected');
  els.btnAdd.disabled = !(next === 'connecting' || next === 'connected') && !inGroup;
  if (next === 'searching') startOffersPoll(); else stopOffersPoll();
  switch (next) {
    case 'preparing':
      setStatus('Getting ready…');
      showPlaceholder('Getting ready', 'Your camera is on — the call starts in a moment.', String(PREPARE_SECONDS));
      break;
    case 'searching':
      setStatus('Searching…');
      showPlaceholder('Searching for someone…', 'Hang tight — a stranger will appear here.');
      break;
    case 'connecting':
      setStatus('Connecting…');
      showPlaceholder('Connecting…', 'Setting up a secure video connection.');
      break;
    case 'connected':
      setStatus('Connected', true);
      if (peerVideoOn) els.remotePh.classList.add('hidden');
      break;
    case 'paused':
      setStatus('Paused');
      showPlaceholder("You're paused", 'Resume whenever you are ready — no one can reach you now.');
      break;
    case 'failed':
      setStatus('Connection problem');
      break;
  }
}

function fail(message) {
  if (ending) return;
  stopSearch();
  stopOffersPoll();
  phase = 'failed';
  els.failText.textContent = message;
  els.failBanner.classList.remove('hidden');
  // The error must be visible in the main frame too — on a phone the
  // banner sits below the fold.
  showPlaceholder('Connection problem', message);
  setPhaseVisualForFail();
}
function setPhaseVisualForFail() {
  setStatus('Connection problem');
  els.btnPause.disabled = true;
  els.btnNext.disabled = true;
}

function startDurationTimer() {
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    if (phase !== 'connected') return;
    durationSeconds++;
    const m = String(Math.floor(durationSeconds / 60)).padStart(2, '0');
    const s = String(durationSeconds % 60).padStart(2, '0');
    els.duration.textContent = `${m}:${s}`;
  }, 1000);
}

// Local level sampling (muted reminder + hand auto-lower), like the
// app's 700ms stats poll. Stacks that report no source level while
// muted simply never trigger the reminder — it is never simulated.
let localSpeaking = false;
function startLevelPoll() {
  clearInterval(levelTimer);
  levelTimer = setInterval(async () => {
    if (!pc || ending) return;
    let level = null;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (level == null && report.type === 'media-source' && typeof report.audioLevel === 'number') {
          level = report.audioLevel;
        }
      });
    } catch { return; }
    if (level == null) return;
    const speaking = localSpeaking ? level > 0.04 : level >= 0.12;
    localSpeaking = speaking;
    els.selfMute.textContent = isMuted && speaking ? '🔇 You are muted — speaking' : '🔇 Muted';
    if (speaking && handRaised) {
      handRaised = false;
      els.btnHand.classList.remove('active');
      els.selfHand.classList.add('hidden');
      sendPresence();
    }
  }, 700);
}

function playRemote() {
  els.remoteVideo.play().catch(() => {
    // Autoplay with sound was blocked: keep the picture (muted) and
    // offer the one-tap sound fix, like every browser call app.
    els.remoteVideo.muted = true;
    els.remoteVideo.play().catch(() => {});
    els.soundBanner.classList.remove('hidden');
  });
}
$('btnSound').addEventListener('click', () => {
  els.remoteVideo.muted = false;
  els.remoteVideo.play().catch(() => {});
  for (const t of tiles.values()) {
    t.video.muted = false;
    t.video.play().catch(() => {});
  }
  els.soundBanner.classList.add('hidden');
});

// ===================================================================
// Controls
// ===================================================================
els.btnMic.addEventListener('click', () => {
  const tracks = localStream?.getAudioTracks() ?? [];
  if (!tracks.length) return;
  isMuted = !isMuted;
  for (const t of tracks) t.enabled = !isMuted;
  els.btnMic.classList.toggle('off-state', isMuted);
  els.micLabel.textContent = isMuted ? 'Unmute' : 'Mic';
  els.selfMute.classList.toggle('hidden', !isMuted);
  if (!isMuted) els.unmuteBanner.classList.add('hidden');
  sendPresence();
});

els.btnFlip.addEventListener('click', async () => {
  const oldTrack = localStream?.getVideoTracks()[0];
  if (!oldTrack) return;
  const next = facing === 'user' ? 'environment' : 'user';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: next } });
    const newTrack = stream.getVideoTracks()[0];
    // The flipped track feeds the 1:1 pc and every group mesh pair.
    const senders = [];
    if (pc) senders.push(pc.getSenders().find((s) => s.track?.kind === 'video'));
    for (const p of gPeers.values()) {
      senders.push(p.pc.getSenders().find((s) => s.track?.kind === 'video'));
    }
    for (const sender of senders) { if (sender) await sender.replaceTrack(newTrack); }
    oldTrack.stop();
    localStream.removeTrack(oldTrack);
    localStream.addTrack(newTrack);
    facing = next;
    els.localVideo.classList.toggle('self', facing === 'user');
  } catch { /* single-camera devices simply stay put */ }
});

els.btnSpeaker.addEventListener('click', async () => {
  speakerOn = !speakerOn;
  els.btnSpeaker.classList.toggle('active', speakerOn);
  // Web has no earpiece route; where the browser exposes several
  // audio outputs, switch every remote element between them.
  const videos = [els.remoteVideo, ...[...tiles.values()].map((t) => t.video)];
  for (const v of videos) {
    if (typeof v.setSinkId !== 'function') continue;
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      if (outs.length > 1) {
        await v.setSinkId(speakerOn ? (outs.find((d) => d.deviceId === 'default')?.deviceId ?? '') : outs[outs.length - 1].deviceId);
      }
    } catch { /* state toggle only on this browser */ }
  }
});

els.btnHand.addEventListener('click', () => {
  handRaised = !handRaised;
  els.btnHand.classList.toggle('active', handRaised);
  els.selfHand.classList.toggle('hidden', !handRaised);
  sendPresence();
});

els.peerMute.addEventListener('click', async () => {
  if (!peerId) return;
  const now = Date.now();
  if (now - lastUnmuteRequestAt < 30000) return; // app cooldown: 30s
  lastUnmuteRequestAt = now;
  await sendSignal({ kind: 'unmute-request', to: peerId });
  toast('Asked the stranger to unmute.');
});

els.btnUnmuteNow.addEventListener('click', () => { if (isMuted) els.btnMic.click(); els.unmuteBanner.classList.add('hidden'); });
els.btnUnmuteDismiss.addEventListener('click', () => els.unmuteBanner.classList.add('hidden'));

els.btnPause.addEventListener('click', pauseCall);
$('btnResume').addEventListener('click', () => { if (phase === 'paused') searchNext(); });
els.btnAdd.addEventListener('click', toggleRoomOpen);
els.btnNext.addEventListener('click', () => {
  if (inGroup) return groupNext();
  return returnToSearching({ notifyPeer: true });
});
$('btnRetry').addEventListener('click', async () => {
  els.failBanner.classList.add('hidden');
  await teardownPeer();
  connectingMatch = false;
  // Retry re-runs the whole prepare sequence (countdown + a fresh
  // camera request) — jumping straight to search with no camera
  // would fail again at once.
  if (entryMode === 'group' && entryRoomId) return startGroupEntry(entryRoomId);
  startPrepare();
});

async function endSession() {
  if (ending) return;
  ending = true;
  stopSearch();
  stopOffersPoll();
  if (phase === 'searching') await rpc('cancel_matchmaking');
  if (inGroup) {
    // Group End: the history entry is saved below (one entry for the
    // whole session); the mesh leave does its own bookkeeping.
    await leaveGroupMesh();
  } else if (roomId) {
    await sendSignal({ kind: 'hangup' });
    rpc('update_call_status', { p_room_id: roomId, p_status: 'ended' });
    rpc('end_room_participation', { p_room_id: roomId });
  }
  await teardownPeer();
  if (localStream) {
    for (const t of localStream.getTracks()) { try { t.stop(); } catch { /* done */ } }
    localStream = null;
  }
  // One history entry for the whole session (owner rule) — only
  // when the session holds at least one message.
  saveHistory({
    endedAt: new Date(),
    people: peopleJoined.size,
    messages: transcriptMessages,
    lines: transcriptLines,
  });
  location.replace('home.html');
}
els.btnEnd.addEventListener('click', endSession);
$('btnEndFromPause').addEventListener('click', endSession);
$('btnEndFromFail').addEventListener('click', endSession);

window.addEventListener('beforeunload', () => {
  if (ending) return;
  if (inGroup) sendSignal({ kind: 'group-leave' });
  else if (roomId) sendSignal({ kind: 'hangup' });
  if (phase === 'searching') rpc('cancel_matchmaking');
});

// ===================================================================
// GROUP CALLS (Phase 2) — a faithful web mirror of the app's
// group_call_controller.dart + the locked group-join plan. Same
// backend, same room, same wire kinds, so web and Android users
// share groups: full-mesh RTCPeerConnections over the room's
// `call-<roomId>` broadcast channel, deterministic offer rule,
// roster-driven tiles, one shared room chat.
// ===================================================================

// ---- Room open/close (the Add control) ------------------------------
function applyRoomOpen(open) {
  roomOpen = open;
  els.openPill.classList.toggle('hidden', !open);
  els.btnAdd.classList.toggle('active', open);
}

/// On entering a room, read the server flag (no broadcast) — the
/// pair may have opened it before we resolved the match.
async function syncRoomOpen(rid) {
  try {
    const { data } = await supabase
      .from('chat_rooms').select('open_for_join, opened_by')
      .eq('id', rid).maybeSingle();
    if (data && roomId === rid && !inGroup) applyRoomOpen(!!data.open_for_join);
  } catch { /* the toggle re-reads on demand */ }
}

/// The Add control: the server flag is written FIRST
/// (set_room_open_for_join), then local state + the peer is told via
/// 'room-open'/'room-closed'. In group mode the flag alone carries
/// it (members learn through the roster). Same rule in the app.
async function toggleRoomOpen() {
  if (!roomId || ending) return;
  if (!inGroup && phase !== 'connecting' && phase !== 'connected') return;
  const target = !roomOpen;
  const { error } = await supabase.rpc('set_room_open_for_join', {
    p_room_id: roomId, p_open: target,
  });
  if (error) return toast('Could not change that just now.');
  applyRoomOpen(target);
  if (inGroup) {
    if (target) {
      groupHostId = myId;
      toast('Room is open — people nearby can join.');
    }
  } else {
    await sendSignal({ kind: target ? 'room-open' : 'room-closed' });
    if (target) toast('Room is open — people nearby can join this call.');
  }
}

// ---- Open-room discovery while searching ----------------------------
function startOffersPoll() {
  stopOffersPoll();
  if (inGroup || ending) return;
  pollOffers();
  offersTimer = setInterval(pollOffers, 8000); // app cadence: 8s
}
function stopOffersPoll() {
  clearInterval(offersTimer); offersTimer = null;
  if (els.groupOffers) els.groupOffers.innerHTML = '';
}
async function pollOffers() {
  if (phase !== 'searching' || inGroup || ending) return;
  const { data, error } = await supabase.rpc('list_open_rooms');
  if (error || phase !== 'searching' || inGroup) return;
  renderOffers(Array.isArray(data) ? data : []);
}
function renderOffers(rooms) {
  const box = els.groupOffers;
  box.innerHTML = '';
  // Count + opened-at ONLY are disclosed — never names or ids.
  for (const room of rooms.slice(0, 2)) {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(room.open_for_join_at).getTime()) / 60000));
    const card = document.createElement('div');
    card.className = 'offer-card';
    const text = document.createElement('span');
    text.className = 'offer-text';
    text.textContent = `${room.participant_count} people in a group call`;
    const sub = document.createElement('small');
    sub.textContent = mins < 1 ? 'just started' : `running ${mins} min`;
    text.appendChild(sub);
    const join = document.createElement('button');
    join.className = 'btn primary small';
    join.type = 'button';
    join.textContent = 'Join';
    join.addEventListener('click', () => joinOffer(room.room_id));
    card.append(text, join);
    box.appendChild(card);
  }
}

/// Joining an offered group: the RPC seats us FIRST; on failure we
/// simply stay in the search. On success the search ends silently
/// (nobody is connected to us yet) and the mesh takes over.
async function joinOffer(rid) {
  const { error } = await supabase.rpc('join_open_room', { p_room_id: rid });
  if (error) {
    toast('That group is no longer available — still looking.');
    pollOffers();
    return;
  }
  stopSearch();
  await rpc('cancel_matchmaking');
  await enterGroup(rid, {});
}

// ---- Entering group mode --------------------------------------------
/// Fresh entry (join offer / friends invite): creates the room's
/// signaling + chat channels. Migration keeps the 1:1 channels —
/// same room, same chat, one continuous transcript.
async function enterGroup(rid, { migrated = false, friends = false } = {}) {
  inGroup = true;
  friendsRoom = friends;
  groupPhase = 'joining';
  document.body.classList.add('group-mode');
  els.groupStack.classList.remove('hidden');
  phase = 'connected'; // in-call for generic UI; 1:1 paths are inGroup-guarded
  stopOffersPoll();
  updateGroupToolbar();
  placeSelfFrame();
  updateGroupStatus();
  groupIce = await fetchIceServers();
  if (!migrated) {
    roomId = rid;
    attachChat(rid);
    signalChannel = supabase.channel(`call-${rid}`, {
      config: { private: true, broadcast: { self: false } },
    });
    signalChannel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      if (payload?.senderId && payload.senderId !== myId) dispatchSignal(payload);
    });
    await subscribeAndWait(signalChannel);
  }
  if (peerId) segOpen.add(peerId); // the 1:1 peer's segment stays open
  await loadGroupContext(rid);
  if (!inGroup) return; // ejected during the context load
  subscribeMembership(rid);
  await sendSignal({ kind: 'group-join' });
  sendPresence();
  clearTimeout(reannounceTimer);
  reannounceTimer = setTimeout(() => {
    if (inGroup && !ending) sendSignal({ kind: 'group-join' });
  }, 2000);
  startGroupStatsPoll();
  updatePopEligibility();
}

/// 1:1 → group migration: the 1:1 engine tears down SILENTLY (no
/// hangup sent, no call-status change, no end hook) and the mesh
/// takes over the same room — the app's migrateToGroup.
let migrating = false;
async function migrateToGroup() {
  if (inGroup || migrating || !roomId || ending) return;
  migrating = true;
  clearInterval(durationTimer); durationTimer = null;
  clearInterval(levelTimer); levelTimer = null;
  if (pc) {
    const old = pc;
    pc = null;
    try { old.close(); } catch { /* silent by design */ }
  }
  offerSent = false; localOfferPending = false;
  readyEchoSent = false; remoteDescriptionSet = false;
  pendingCandidates = [];
  peerVideoOn = false;
  await enterGroup(roomId, { migrated: true });
  migrating = false;
}

async function loadGroupContext(rid) {
  try {
    const { data: rows } = await supabase
      .from('room_participants')
      .select('user_id, role, joined_at, left_at, removed_at')
      .eq('room_id', rid)
      .order('joined_at', { ascending: true });
    syncRoster(rows ?? [], true);
  } catch { /* the membership watch keeps the roster honest */ }
  try {
    const { data: room } = await supabase
      .from('chat_rooms').select('open_for_join, opened_by')
      .eq('id', rid).maybeSingle();
    if (room) {
      groupHostId = room.opened_by ?? null;
      applyRoomOpen(!!room.open_for_join);
    }
  } catch { /* the Add toggle re-reads on demand */ }
}

function subscribeMembership(rid) {
  if (membershipChannel) supabase.removeChannel(membershipChannel);
  membershipChannel = supabase
    .channel(`room-participants-${rid}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'room_participants',
      filter: `room_id=eq.${rid}`,
    }, scheduleRosterReload)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'room_participants',
      filter: `room_id=eq.${rid}`,
    }, scheduleRosterReload)
    .subscribe();
}

function scheduleRosterReload() {
  clearTimeout(rosterReloadTimer);
  rosterReloadTimer = setTimeout(async () => {
    if (!inGroup || !roomId) return;
    try {
      const { data: rows } = await supabase
        .from('room_participants')
        .select('user_id, role, joined_at, left_at, removed_at')
        .eq('room_id', roomId)
        .order('joined_at', { ascending: true });
      if (rows) syncRoster(rows, false);
    } catch { /* next event retries */ }
  }, 250);
}

/// Roster diff — drives tiles, transcript separators, join/left
/// notices and the eject flow, exactly like the app's membership
/// handling. A user who is removed can never rejoin (server-side).
function syncRoster(rows, initial) {
  let ejected = false;
  for (const row of rows) {
    roster.set(row.user_id, {
      role: row.role,
      joinedAt: row.joined_at,
      active: !row.left_at,
      removed: !!row.removed_at,
    });
    if (row.user_id === myId && row.removed_at) ejected = true;
  }
  // Join order follows the roster's joined_at order.
  joinOrder.length = 0;
  for (const row of rows) {
    if (row.user_id !== myId && !row.left_at) joinOrder.push(row.user_id);
  }
  for (const [uid, m] of roster) {
    if (uid === myId) continue;
    if (m.active && !m.removed) {
      if (!knownActive.has(uid)) {
        knownActive.add(uid);
        peopleJoined.add(uid);
        if (!blockedIds.has(uid)) ensureTile(uid);
        resolveName(uid);
        if (!segOpen.has(uid)) {
          appendSeparator(uid, 'joined');
          segOpen.add(uid);
        }
        if (!initial) showGroupNotice(`${nameOf(uid)} joined`);
      }
    } else if (knownActive.has(uid)) {
      knownActive.delete(uid);
      dropGroupPeer(uid);
      removeTile(uid);
      if (segOpen.has(uid)) {
        appendSeparator(uid, 'left');
        segOpen.delete(uid);
      }
      if (!initial) showGroupNotice(`${nameOf(uid)} left`);
    }
  }
  updateGroupStatus();
  renderGroupOrder();
  updatePopEligibility();
  if (ejected && !ejecting) {
    ejecting = true;
    ejectFromGroup();
  }
}

async function ejectFromGroup() {
  const wasFriendsRoom = friendsRoom;
  await sendSignal({ kind: 'group-leave' });
  teardownGroup();
  toast('You were removed from that group.');
  ejecting = false;
  if (wasFriendsRoom) return location.replace('home.html');
  setPhase('searching');
  searchNext();
}

function showGroupNotice(text) {
  els.groupNotice.textContent = text;
  els.groupNotice.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => els.groupNotice.classList.add('hidden'), 3000);
}

function updateGroupStatus() {
  if (!inGroup) return;
  if (groupPhase === 'connected') {
    setStatus(`Group · ${knownActive.size + 1} here`, true);
  } else {
    setStatus('Joining group…');
  }
}

function updateGroupToolbar() {
  // The group surface has its own leave flow: Pause (1:1 only) is
  // dimmed, never hidden. Next leaves the group back to searching —
  // in a friends room there is no stranger search to return to.
  els.btnPause.disabled = true;
  els.btnNext.disabled = friendsRoom;
  els.btnAdd.disabled = false;
  els.speakerWrap.classList.remove('hidden');
}

// ---- Group mesh (GroupCallController) --------------------------------
function ensureGroupPeer(userId) {
  if (blockedIds.has(userId)) return null;
  let peer = gPeers.get(userId);
  if (peer) return peer;
  const conn = new RTCPeerConnection({ iceServers: groupIce ?? [{ urls: DEFAULT_STUN }] });
  peer = {
    userId, pc: conn, offerSent: false, remoteSet: false,
    pending: [], speaking: false, connected: false,
  };
  gPeers.set(userId, peer);
  for (const track of (localStream?.getTracks() ?? [])) conn.addTrack(track, localStream);
  conn.onicecandidate = (event) => {
    if (!event.candidate) return;
    const c = event.candidate;
    sendSignal({
      kind: 'ice', to: userId,
      candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
    });
  };
  conn.ontrack = (event) => {
    const tile = tiles.get(userId);
    if (!tile || !event.streams.length) return;
    tile.video.srcObject = event.streams[0];
    tile.video.play().catch(() => {
      tile.video.muted = true;
      tile.video.play().catch(() => {});
    });
    if (event.track.kind === 'video') {
      tile.hasVideo = true;
      tile.ph.classList.add('hidden');
    }
  };
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'connected') {
      peer.connected = true;
      if (groupPhase !== 'connected') {
        groupPhase = 'connected';
        updateGroupStatus();
        startGroupDuration();
      }
    } else if (conn.connectionState === 'closed') {
      dropGroupPeer(userId);
    }
    // Per-pair failures never kill the mesh (app rule).
  };
  return peer;
}

/// Deterministic offer rule: for each pair, the lexicographically
/// SMALLER user id creates the offer, and only once.
function maybeGroupOffer(peer) {
  if (!peer || peer.offerSent) return;
  if (!(myId < peer.userId)) return;
  peer.offerSent = true;
  (async () => {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await sendSignal({ kind: 'offer', to: peer.userId, sdp: offer.sdp, sdpType: offer.type });
    } catch { /* per-pair errors are swallowed — the mesh lives on */ }
  })();
}

async function onGroupSignal(msg) {
  if (ending) return;
  if ((msg.sdp?.length ?? 0) > 65536) return; // app drop rule
  const from = msg.senderId;
  if (!from || from === myId) return;
  if (msg.to != null && msg.to !== myId) return; // addressed elsewhere
  try {
    switch (msg.kind) {
      case 'group-join': {
        // Present members answer a joiner: addressed group-present
        // plus an addressed presence push, then pair up.
        await sendSignal({ kind: 'group-present', to: from });
        await sendSignal({ kind: 'presence', to: from, muted: isMuted, handRaised });
        maybeGroupOffer(ensureGroupPeer(from));
        break;
      }
      case 'group-present':
        maybeGroupOffer(ensureGroupPeer(from));
        break;
      case 'offer': {
        const peer = ensureGroupPeer(from);
        if (!peer) return;
        await peer.pc.setRemoteDescription({ type: msg.sdpType ?? 'offer', sdp: msg.sdp });
        peer.remoteSet = true;
        await flushGroupCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await sendSignal({ kind: 'answer', to: from, sdp: answer.sdp, sdpType: answer.type });
        break;
      }
      case 'answer': {
        const peer = gPeers.get(from);
        if (!peer) return;
        await peer.pc.setRemoteDescription({ type: msg.sdpType ?? 'answer', sdp: msg.sdp });
        peer.remoteSet = true;
        await flushGroupCandidates(peer);
        break;
      }
      case 'ice': {
        const peer = gPeers.get(from);
        const raw = msg.candidate;
        if (!peer || !raw) return;
        const candidate = new RTCIceCandidate({
          candidate: raw.candidate, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex,
        });
        if (peer.remoteSet) await peer.pc.addIceCandidate(candidate);
        else if (peer.pending.length < 100) peer.pending.push(candidate);
        break;
      }
      case 'presence': {
        const tile = tiles.get(from);
        if (tile) {
          if (typeof msg.muted === 'boolean') tile.muted = msg.muted;
          if (typeof msg.handRaised === 'boolean') tile.handRaised = msg.handRaised;
          updateTile(from);
        }
        break;
      }
      case 'unmute-request':
        if (msg.to === myId) els.unmuteBanner.classList.remove('hidden');
        break;
      case 'group-leave':
        dropGroupPeer(from);
        break;
      default:
        break; // 'hangup' etc. are meaningless inside the mesh
    }
  } catch { /* per-pair errors are swallowed — the mesh lives on */ }
}

async function flushGroupCandidates(peer) {
  const pending = peer.pending;
  peer.pending = [];
  for (const candidate of pending) {
    try { await peer.pc.addIceCandidate(candidate); } catch { /* stale is harmless */ }
  }
}

/// Close one pair locally (peer left / blocked / removed). The tile
/// is roster-driven and handled by the caller where it applies.
function dropGroupPeer(userId) {
  const peer = gPeers.get(userId);
  if (!peer) return;
  gPeers.delete(userId);
  try { peer.pc.close(); } catch { /* already closed */ }
  if (speakingIds.delete(userId)) renderGroupOrder();
}

// ---- Speaking levels (600ms stats poll, app hysteresis) --------------
function startGroupStatsPoll() {
  clearInterval(groupStatsTimer);
  groupStatsTimer = setInterval(async () => {
    if (!inGroup || ending) return;
    let localLevel = null;
    for (const peer of gPeers.values()) {
      let audioLevel = null;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof report.audioLevel === 'number') {
            audioLevel = report.audioLevel;
          }
          if (localLevel == null && report.type === 'media-source' && typeof report.audioLevel === 'number') {
            localLevel = report.audioLevel;
          }
        });
      } catch { continue; }
      if (audioLevel == null) continue;
      const speaking = peer.speaking ? audioLevel > 0.04 : audioLevel >= 0.12;
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        if (speaking) {
          speakingIds.add(peer.userId);
          lastSpeakerId = peer.userId;
        } else {
          speakingIds.delete(peer.userId);
        }
        updateTile(peer.userId);
        renderGroupOrder();
      }
    }
    if (localLevel != null) {
      const speaking = localSpeaking ? localLevel > 0.04 : localLevel >= 0.12;
      localSpeaking = speaking;
      els.selfMute.textContent = isMuted && speaking ? '🔇 You are muted — speaking' : '🔇 Muted';
      if (speaking && handRaised) {
        handRaised = false;
        els.btnHand.classList.remove('active');
        els.selfHand.classList.add('hidden');
        sendPresence();
      }
    }
  }, 600);
}

function startGroupDuration() {
  clearInterval(groupDurationTimer);
  groupDurationSeconds = 0;
  groupDurationTimer = setInterval(() => {
    if (!inGroup) return;
    groupDurationSeconds++;
    const m = String(Math.floor(groupDurationSeconds / 60)).padStart(2, '0');
    const s = String(groupDurationSeconds % 60).padStart(2, '0');
    els.duration.textContent = `${m}:${s}`;
  }, 1000);
}

// ---- Group tiles: order, pins, layout ---------------------------------
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L14 12l.6 3.4-1.8 1.8-2.3-2.3-3.6 3.6a1 1 0 0 1-1.4 0l-1-1a1 1 0 0 1 0-1.4l3.6-3.6-2.3-2.3 1.8-1.8L11 10l5.5-6.5z" transform="rotate(45 12 12)"/></svg>';

function ensureTile(userId) {
  let tile = tiles.get(userId);
  if (tile) return tile;
  const el = document.createElement('div');
  el.className = 'frame group-tile';
  el.dataset.uid = userId;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  const ph = document.createElement('div');
  ph.className = 'tile-ph';
  ph.innerHTML = '<span class="tile-dots"><i></i><i></i><i></i></span>';
  const speakingBadge = document.createElement('span');
  speakingBadge.className = 'badge speaking-badge hidden';
  speakingBadge.textContent = 'Speaking';
  const handBadge = document.createElement('span');
  handBadge.className = 'badge hand-badge hidden';
  handBadge.textContent = '✋ Hand raised';
  const muteBadge = document.createElement('button');
  muteBadge.className = 'badge mute-badge hidden';
  muteBadge.type = 'button';
  muteBadge.title = 'Ask them to unmute';
  muteBadge.textContent = '🔇 Muted — tap to ask';
  muteBadge.addEventListener('click', () => requestGroupUnmute(userId));
  const chip = document.createElement('span');
  chip.className = 'name-chip';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const nameEl = document.createElement('span');
  nameEl.textContent = 'Stranger';
  chip.append(dot, nameEl);
  const pinBtn = document.createElement('button');
  pinBtn.className = 'pin-btn';
  pinBtn.type = 'button';
  pinBtn.title = 'Pin';
  pinBtn.innerHTML = PIN_SVG;
  pinBtn.addEventListener('click', () => togglePin(userId));
  el.append(video, ph, speakingBadge, handBadge, muteBadge, chip, pinBtn);
  // Long-press opens the participant sheet (app interaction).
  let pressTimer = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => openParticipantSheet(userId), 550);
  });
  for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) {
    el.addEventListener(evt, () => clearTimeout(pressTimer));
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  tile = {
    userId, el, video, ph, speakingBadge, handBadge, muteBadge, nameEl, pinBtn,
    muted: false, handRaised: false, hasVideo: false,
  };
  tiles.set(userId, tile);
  els.groupStack.appendChild(el);
  updateTile(userId);
  return tile;
}

function removeTile(userId) {
  const tile = tiles.get(userId);
  if (!tile) return;
  tiles.delete(userId);
  tile.el.remove();
  const pinIdx = pinnedIds.indexOf(userId);
  if (pinIdx >= 0) pinnedIds.splice(pinIdx, 1);
  speakingIds.delete(userId);
}

function updateTile(userId) {
  const tile = tiles.get(userId);
  if (!tile) return;
  const peer = gPeers.get(userId);
  const speaking = peer?.speaking ?? false;
  tile.el.classList.toggle('speaking', speaking);
  tile.speakingBadge.classList.toggle('hidden', !speaking);
  tile.handBadge.classList.toggle('hidden', !tile.handRaised);
  tile.muteBadge.classList.toggle('hidden', !tile.muted);
  tile.nameEl.textContent = nameOf(userId);
  tile.pinBtn.classList.toggle('pinned', pinnedIds.includes(userId));
  tile.pinBtn.title = pinnedIds.includes(userId) ? 'Unpin' : 'Pin';
}

/// Frame order (app rule): pinned first in pin order, then the
/// current speaker among the unpinned, then everyone else in join
/// order. 'Speaker on top' (default OFF) lifts the speaker above
/// the pins too. My own frame is never in this list — it goes last.
function orderedPeerIds() {
  const present = (id) => tiles.has(id);
  const pins = pinnedIds.filter(present);
  const speaker = lastSpeakerId && speakingIds.has(lastSpeakerId) && present(lastSpeakerId)
    ? lastSpeakerId : null;
  const rest = joinOrder.filter((id) => present(id) && !pins.includes(id) && id !== speaker);
  if (speakerOnTop && speaker) return [speaker, ...pins, ...rest];
  return [...pins, ...(speaker && !pins.includes(speaker) ? [speaker] : []), ...rest];
}

function renderGroupOrder() {
  if (!inGroup) return;
  for (const id of orderedPeerIds()) {
    const tile = tiles.get(id);
    if (tile) els.groupStack.appendChild(tile.el);
  }
  placeSelfFrame();
  layoutGroupTiles();
}

function togglePin(userId) {
  const idx = pinnedIds.indexOf(userId);
  if (idx >= 0) pinnedIds.splice(idx, 1);
  else pinnedIds.push(userId);
  updateTile(userId);
  renderGroupOrder();
}

/// Desktop sizing (app rule): slot height = stack height ÷ count;
/// past 4 frames the slot keeps a minimum height (¼ of the stack,
/// clamped 190–320) and the stack scrolls. Frames stay 16:9,
/// height-driven, centred. Phone CSS takes over below 1024px.
function layoutGroupTiles() {
  if (!inGroup) return;
  const stack = els.groupStack;
  const frames = [...stack.children].filter((el) => el.classList.contains('frame'));
  if (window.innerWidth < 1024) {
    for (const el of frames) {
      el.style.removeProperty('width');
      el.style.removeProperty('height');
    }
    return;
  }
  const n = frames.length;
  const stackH = stack.clientHeight;
  const stackW = stack.clientWidth;
  if (!n || !stackH || !stackW) return;
  let slotH = stackH / n;
  if (n > 4) slotH = Math.max(slotH, Math.min(320, Math.max(190, stackH / 4)));
  for (const el of frames) {
    let h = slotH - 10;
    let w = (h * 16) / 9;
    if (w > stackW - 4) { w = stackW - 4; h = (w * 9) / 16; }
    el.style.width = `${Math.floor(w)}px`;
    el.style.height = `${Math.floor(h)}px`;
  }
}

// ---- Self frame placement + pop-up -------------------------------------
function placeSelfFrame() {
  const frame = els.selfFrame;
  let home;
  if (selfPopped) home = els.popupLayer;
  else if (!inGroup) home = els.selfSlot;
  else home = window.innerWidth >= 1024 ? els.groupStack : els.groupSelfSlot;
  if (frame.parentElement !== home) home.appendChild(frame);
  els.groupSelfSlot.classList.toggle(
    'hidden', !(inGroup && !selfPopped && window.innerWidth < 1024),
  );
  if (!inGroup) {
    frame.style.removeProperty('width');
    frame.style.removeProperty('height');
  }
}

/// The pop-up is offered only with 2+ strangers (app rule), and only
/// ever for my own frame.
function updatePopEligibility() {
  const eligible = inGroup && knownActive.size >= 2;
  els.btnSelfPop.classList.toggle('hidden', !eligible || selfPopped);
  if (!eligible && selfPopped) unpopSelf();
}

function popSelf() {
  if (selfPopped || !inGroup) return;
  selfPopped = true;
  placeSelfFrame();
  const side = Math.max(150, Math.min(176, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.42)));
  const frame = els.selfFrame;
  frame.classList.add('popped');
  frame.style.width = `${side}px`;
  frame.style.height = `${side}px`;
  frame.style.left = `${Math.max(0, window.innerWidth - side - 16)}px`;
  frame.style.top = `${Math.max(0, window.innerHeight - side - 96)}px`;
  els.btnSelfPop.classList.add('hidden');
  els.btnSelfExpand.classList.remove('hidden');
  layoutGroupTiles();
}

function unpopSelf() {
  if (!selfPopped) return;
  selfPopped = false;
  const frame = els.selfFrame;
  frame.classList.remove('popped');
  frame.style.removeProperty('width');
  frame.style.removeProperty('height');
  frame.style.removeProperty('left');
  frame.style.removeProperty('top');
  els.btnSelfExpand.classList.add('hidden');
  placeSelfFrame();
  updatePopEligibility();
  layoutGroupTiles();
}

els.btnSelfPop.addEventListener('click', popSelf);
els.btnSelfExpand.addEventListener('click', unpopSelf);
els.selfFrame.addEventListener('pointerdown', (e) => {
  if (!selfPopped || e.target.closest('button')) return;
  const frame = els.selfFrame;
  const rect = frame.getBoundingClientRect();
  const startX = e.clientX; const startY = e.clientY;
  const move = (ev) => {
    const left = Math.min(Math.max(0, rect.left + ev.clientX - startX), window.innerWidth - rect.width);
    const top = Math.min(Math.max(0, rect.top + ev.clientY - startY), window.innerHeight - rect.height);
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

window.addEventListener('resize', () => {
  if (!inGroup) return;
  placeSelfFrame();
  layoutGroupTiles();
});

// ---- Participant sheet: Report / Block / Remove ------------------------
const REPORT_REASONS = ['harassment', 'nudity', 'spam', 'underage', 'violence', 'other'];

function closeSheet() {
  els.sheetOverlay.classList.add('hidden');
  els.sheetCard.innerHTML = '';
  sheetTarget = null;
}
els.sheetOverlay.addEventListener('click', (e) => {
  if (e.target === els.sheetOverlay) closeSheet();
});

function sheetButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${cls}`.trim();
  btn.type = 'button';
  btn.textContent = label;
  btn.style.width = '100%';
  btn.addEventListener('click', onClick);
  return btn;
}

function openParticipantSheet(userId) {
  if (!inGroup) return;
  sheetTarget = userId;
  const name = nameOf(userId);
  const member = roster.get(userId);
  const canRemove = groupHostId === myId && member?.role === 'peer';
  const card = els.sheetCard;
  card.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'sheet-sub';
  sub.textContent = 'Participant';
  card.append(title, sub);
  card.appendChild(sheetButton(`Report ${name}`, '', () => showReportReasons(userId)));
  card.appendChild(sheetButton(`Block ${name}`, 'danger-outline', () => blockParticipant(userId)));
  if (canRemove) {
    card.appendChild(sheetButton('Remove from group', 'danger-outline', () => confirmRemove(userId)));
  }
  card.appendChild(sheetButton('Cancel', '', closeSheet));
  els.sheetOverlay.classList.remove('hidden');
}

function showReportReasons(userId) {
  const card = els.sheetCard;
  card.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = `Report ${nameOf(userId)}`;
  const sub = document.createElement('div');
  sub.className = 'sheet-sub';
  sub.textContent = 'What happened?';
  card.append(title, sub);
  for (const reason of REPORT_REASONS) {
    card.appendChild(sheetButton(
      reason[0].toUpperCase() + reason.slice(1), '',
      () => submitReport(userId, reason),
    ));
  }
  card.appendChild(sheetButton('Back', '', () => openParticipantSheet(userId)));
}

async function submitReport(userId, reason) {
  const { error } = await supabase.rpc('submit_report', {
    p_room_id: roomId, p_reported_id: userId, p_reason: reason, p_description: null,
  });
  closeSheet();
  toast(error ? 'Could not send the report.' : 'Report sent. Thanks for helping keep Novis safe.');
}

/// Block: same blocks-table upsert as the app; locally the pair is
/// dropped at once and the tile goes away.
async function blockParticipant(userId) {
  const name = nameOf(userId);
  const { error } = await supabase
    .from('blocks')
    .upsert(
      { blocker_id: myId, blocked_id: userId },
      { onConflict: 'blocker_id,blocked_id' },
    );
  closeSheet();
  if (error) return toast('Could not block just now.');
  blockedIds.add(userId);
  dropGroupPeer(userId);
  removeTile(userId);
  renderGroupOrder();
  toast(`${name} blocked.`);
}

function confirmRemove(userId) {
  const card = els.sheetCard;
  card.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = `Remove ${nameOf(userId)}?`;
  const sub = document.createElement('div');
  sub.className = 'sheet-sub';
  sub.textContent = 'They will leave this group and cannot join it again.';
  card.append(title, sub);
  card.appendChild(sheetButton('Remove', 'danger-outline', async () => {
    const { error } = await supabase.rpc('remove_room_participant', {
      p_room_id: roomId, p_target_id: userId,
    });
    closeSheet();
    if (error) return toast('Could not remove them just now.');
    dropGroupPeer(userId);
    removeTile(userId);
    renderGroupOrder();
    toast('Removed from the group.');
  }));
  card.appendChild(sheetButton('Cancel', '', closeSheet));
}

async function requestGroupUnmute(userId) {
  const now = Date.now();
  if (now - (unmuteAskedAt.get(userId) ?? 0) < 30000) return; // 30s cooldown
  unmuteAskedAt.set(userId, now);
  await sendSignal({ kind: 'unmute-request', to: userId });
  toast(`Asked ${nameOf(userId)} to unmute.`);
}

// ---- Leaving the group --------------------------------------------------
/// The app's leave bookkeeping: a host closes the door first, then
/// leave_open_room, then the mesh leave (group-leave broadcast +
/// end_room_participation).
async function leaveGroupMesh() {
  if (!inGroup) return;
  const rid = roomId;
  if (rid && groupHostId === myId && roomOpen) {
    await rpc('set_room_open_for_join', { p_room_id: rid, p_open: false });
  }
  if (rid) {
    await sendSignal({ kind: 'group-leave' });
    await rpc('leave_open_room', { p_room_id: rid });
    await rpc('end_room_participation', { p_room_id: rid });
    // Everyone still here leaves MY session transcript here.
    for (const uid of [...knownActive]) {
      if (segOpen.has(uid)) {
        appendSeparator(uid, 'left');
        segOpen.delete(uid);
      }
    }
  }
  teardownGroup();
}

function teardownGroup() {
  inGroup = false;
  friendsRoom = false;
  groupPhase = 'idle';
  clearInterval(groupStatsTimer); groupStatsTimer = null;
  clearInterval(groupDurationTimer); groupDurationTimer = null;
  clearTimeout(reannounceTimer); reannounceTimer = null;
  clearTimeout(rosterReloadTimer); rosterReloadTimer = null;
  groupDurationSeconds = 0;
  els.duration.textContent = '';
  for (const peer of gPeers.values()) {
    try { peer.pc.close(); } catch { /* already closed */ }
  }
  gPeers.clear();
  for (const tile of tiles.values()) tile.el.remove();
  tiles.clear();
  roster.clear();
  knownActive.clear();
  segOpen.clear();
  joinOrder.length = 0;
  pinnedIds.length = 0;
  blockedIds.clear();
  speakingIds.clear();
  lastSpeakerId = null;
  groupHostId = null;
  applyRoomOpen(false);
  if (membershipChannel) { supabase.removeChannel(membershipChannel); membershipChannel = null; }
  if (messagesChannel) { supabase.removeChannel(messagesChannel); messagesChannel = null; }
  if (typingChannel) { supabase.removeChannel(typingChannel); typingChannel = null; }
  if (signalChannel) { supabase.removeChannel(signalChannel); signalChannel = null; }
  roomId = '';
  peerId = null;
  peerDisplayName = null;
  segmentOpen = false;
  connectingMatch = false;
  if (selfPopped) unpopSelf();
  document.body.classList.remove('group-mode');
  els.groupStack.classList.add('hidden');
  els.speakerWrap.classList.add('hidden');
  placeSelfFrame();
}

/// Group Next (Skip): leave the mesh and go straight back to
/// searching — NO prepare second time (the app rule). The session
/// transcript continues into the next segment.
async function groupNext() {
  if (!inGroup || ending) return;
  await leaveGroupMesh();
  setPhase('searching');
  searchNext();
}

// ---- Speaker on top (shared with Settings; default OFF) ------------------
try {
  speakerOnTop = localStorage.getItem('novis_speaker_on_top') === '1';
} catch { /* default OFF */ }
els.speakerToggle.checked = speakerOnTop;
els.speakerToggle.addEventListener('change', () => {
  speakerOnTop = els.speakerToggle.checked;
  try {
    localStorage.setItem('novis_speaker_on_top', speakerOnTop ? '1' : '0');
  } catch { /* cosmetic preference only */ }
  renderGroupOrder();
});

// ===================================================================
// Floating chat (desktop): drag by header, resize by corner grip,
// geometry persisted — the SAME panel, the slot stays empty.
// ===================================================================
const chatPanel = els.chatPanel;
const grip = $('resizeGrip');
function applyFloatGeometry(geo) {
  chatPanel.style.left = `${geo.left}px`;
  chatPanel.style.top = `${geo.top}px`;
  chatPanel.style.width = `${geo.width}px`;
  chatPanel.style.height = `${geo.height}px`;
}
function floatChat() {
  const saved = JSON.parse(localStorage.getItem(LS.chatFloat) ?? 'null');
  const rect = chatPanel.getBoundingClientRect();
  const geo = saved ?? {
    left: Math.max(8, window.innerWidth - rect.width - 16),
    top: Math.max(8, rect.top), width: 340, height: 440,
  };
  geo.width = Math.min(640, Math.max(280, geo.width));
  geo.height = Math.min(760, Math.max(300, geo.height));
  chatPanel.classList.add('floating');
  applyFloatGeometry(geo);
  grip.classList.remove('hidden');
  $('btnChatFloat').classList.add('hidden');
  $('btnChatDock').classList.remove('hidden');
}
function dockChat() {
  chatPanel.classList.remove('floating');
  chatPanel.style.removeProperty('left');
  chatPanel.style.removeProperty('top');
  chatPanel.style.removeProperty('width');
  chatPanel.style.removeProperty('height');
  grip.classList.add('hidden');
  $('btnChatFloat').classList.remove('hidden');
  $('btnChatDock').classList.add('hidden');
}
function persistFloat() {
  const r = chatPanel.getBoundingClientRect();
  localStorage.setItem(LS.chatFloat, JSON.stringify({
    left: Math.round(r.left), top: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
  }));
}
$('btnChatFloat').addEventListener('click', floatChat);
$('btnChatDock').addEventListener('click', dockChat);
$('btnChatHide').addEventListener('click', () => {
  chatPanel.classList.add('chat-hidden');
  $('btnChatShow').classList.remove('hidden');
});
$('btnChatShow').addEventListener('click', () => {
  chatPanel.classList.remove('chat-hidden');
  $('btnChatShow').classList.add('hidden');
});

$('chatHead').addEventListener('pointerdown', (e) => {
  if (!chatPanel.classList.contains('floating') || e.target.closest('button')) return;
  const startX = e.clientX; const startY = e.clientY;
  const rect = chatPanel.getBoundingClientRect();
  const move = (ev) => {
    const left = Math.min(Math.max(0, rect.left + ev.clientX - startX), window.innerWidth - 120);
    const top = Math.min(Math.max(0, rect.top + ev.clientY - startY), window.innerHeight - 80);
    chatPanel.style.left = `${left}px`;
    chatPanel.style.top = `${top}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    // Edge-snap + clamp on release, like the app.
    const r = chatPanel.getBoundingClientRect();
    let left = r.left; let top = r.top;
    if (Math.abs(window.innerWidth - (left + r.width)) < 18) left = window.innerWidth - r.width;
    if (left < 18) left = 0;
    if (top < 18) top = 0;
    chatPanel.style.left = `${left}px`;
    chatPanel.style.top = `${top}px`;
    persistFloat();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX; const startY = e.clientY;
  const rect = chatPanel.getBoundingClientRect();
  const move = (ev) => {
    const width = Math.min(640, Math.max(280, rect.width + ev.clientX - startX));
    const height = Math.min(760, Math.max(300, rect.height + ev.clientY - startY));
    chatPanel.style.width = `${width}px`;
    chatPanel.style.height = `${height}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    persistFloat();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ===================================================================
// Session start: guards → local preview → 5s prepare → search
// (CallController.startStrangerVideo — prepare runs ONCE per entry)
//
// The 5-second countdown starts the moment the page opens and NEVER
// waits for the camera: the old code awaited getUserMedia() first,
// so an unanswered permission prompt froze the page on "Getting
// ready" forever (no countdown, no camera, no start). Media is now
// requested in parallel with a timeout, and a denied / timed-out /
// busy camera shows a plain-English blocked state with a Retry
// button that re-runs the whole prepare sequence.
// ===================================================================
const MEDIA_TIMEOUT_MS = 10000; // an unanswered prompt must never hang the page
let mediaState = 'idle'; // idle|waiting|ready|blocked
let prepareDone = false;
let mediaReady = false;
let entryMode = 'call'; // call|group
let entryRoomId = '';

function localStreamLive() {
  return !!localStream && localStream.getTracks().some((t) => t.readyState === 'live');
}

function classifyMediaError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
      return { title: 'Camera blocked', text: 'Camera and microphone are blocked. Tap Allow in your browser, then tap Retry.' };
    case 'MediaTimeoutError':
      return { title: 'Waiting for camera', text: 'Camera permission is still waiting. Tap Allow in your browser, then tap Retry.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', text: 'No camera or microphone was found on this device.' };
    case 'NotReadableError':
      return { title: 'Camera is busy', text: 'Your camera is busy in another app or tab. Close it, then tap Retry.' };
    default:
      return { title: 'Connection problem', text: `Call setup failed: ${e?.message ?? e}` };
  }
}

/// One camera/mic attempt with a hard timeout. If the browser's
/// permission prompt is never answered, the timeout wins — and any
/// stream the abandoned attempt eventually yields is stopped at once
/// so the camera never stays on behind our back.
async function requestLocalMedia() {
  let timer = null;
  let abandoned = false;
  const attempt = navigator.mediaDevices.getUserMedia({
    audio: true, video: { facingMode: 'user' },
  });
  attempt.then(
    (stream) => { if (abandoned) for (const t of stream.getTracks()) t.stop(); },
    () => {},
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      const e = new Error('Camera permission is still waiting.');
      e.name = 'MediaTimeoutError';
      reject(e);
    }, MEDIA_TIMEOUT_MS);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function showMediaBlocked(info) {
  fail(info.text);
  setStatus(info.title);
  showPlaceholder(info.title, info.text);
}

/// Media request running alongside the countdown. Success shows the
/// local preview at once and starts the search the moment the
/// countdown has also finished; failure shows the blocked state.
async function acquireLocalMedia() {
  if (localStreamLive()) {
    mediaState = 'ready';
    mediaReady = true;
    els.localVideo.srcObject = localStream;
    els.localVideo.play().catch(() => {});
    maybeStartSearch();
    return;
  }
  mediaState = 'waiting';
  try {
    localStream = await requestLocalMedia();
    mediaState = 'ready';
    mediaReady = true;
    els.localVideo.srcObject = localStream;
    els.localVideo.play().catch(() => {});
    maybeStartSearch();
  } catch (e) {
    mediaState = 'blocked';
    mediaReady = false;
    showMediaBlocked(classifyMediaError(e));
  }
}

/// The 5-second prepare countdown — starts immediately on entry and
/// never waits for the camera. When it hits zero with the camera
/// ready, the search starts; with the camera still pending, the page
/// says so plainly instead of sitting on a frozen "5".
function startPrepareCountdown() {
  clearInterval(prepareCountdown); prepareCountdown = null;
  let left = PREPARE_SECONDS;
  els.prepareCount.textContent = String(left);
  prepareCountdown = setInterval(() => {
    if (phase !== 'preparing') return;
    left = Math.max(0, left - 1);
    els.prepareCount.textContent = left > 0 ? String(left) : '';
    if (left === 0) {
      clearInterval(prepareCountdown); prepareCountdown = null;
      prepareDone = true;
      if (!mediaReady && phase === 'preparing') {
        setStatus('Waiting for camera…');
        showPlaceholder('Waiting for camera', 'Tap Allow when your browser asks — the call starts as soon as the camera is on.');
      }
      maybeStartSearch();
    }
  }, 1000);
}

function maybeStartSearch() {
  if (ending || phase !== 'preparing') return;
  if (!prepareDone || !mediaReady) return;
  searchNext();
}

/// One full prepare run: countdown + camera in parallel. Used at boot
/// and by Retry, so a denied camera can always recover.
function startPrepare() {
  prepareDone = false;
  mediaReady = false;
  mediaState = 'idle';
  setPhase('preparing');
  startPrepareCountdown();
  acquireLocalMedia();
}

/// Group entry (friends invite / hosted room): same camera rules —
/// timeout + blocked state with Retry — then the mesh takes over
/// with no prepare and no search, like the app.
async function startGroupEntry(rid) {
  clearInterval(prepareCountdown); prepareCountdown = null;
  setPhase('preparing');
  setStatus('Joining group…');
  showPlaceholder('Getting ready', 'Your camera is on — joining the group in a moment.');
  try {
    if (!localStreamLive()) {
      localStream = await requestLocalMedia();
    }
    els.localVideo.srcObject = localStream;
    els.localVideo.play().catch(() => {});
  } catch (e) {
    showMediaBlocked(classifyMediaError(e));
    return;
  }
  try {
    const { data: mine } = await supabase
      .from('room_participants')
      .select('left_at, removed_at')
      .eq('room_id', rid).eq('user_id', myId).maybeSingle();
    if (!mine || mine.left_at || mine.removed_at) {
      toast('That group is no longer available.');
      return location.replace('home.html');
    }
  } catch {
    toast('That group is no longer available.');
    return location.replace('home.html');
  }
  await enterGroup(rid, { friends: true });
}

async function boot() {
  applyAdsGate(); // Testing premium hides every ad, site-wide
  // Show the prepare state at once — before the session/profile
  // round-trips — so the countdown is visible the moment the page
  // opens. startPrepare() below restarts it cleanly once the
  // guards pass.
  setPhase('preparing');
  startPrepareCountdown();
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  const profile = await myProfile();
  if (!profile?.display_name?.trim()) return location.replace('index.html');
  myId = user.id;
  els.selfName.textContent = profile.display_name;

  // Direct group entry (friends invite accepted / group hosted from
  // the Friends page): I must already hold an active seat in the
  // room — the mesh then takes over with no prepare, no search.
  const params = new URLSearchParams(location.search);
  if (params.get('group') === '1' && params.get('room')) {
    entryMode = 'group';
    entryRoomId = params.get('room');
    return startGroupEntry(entryRoomId);
  }
  entryMode = 'call';
  entryRoomId = '';
  startPrepare();
}

boot();
