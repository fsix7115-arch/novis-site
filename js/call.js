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
  btnNext: $('btnNext'), btnEnd: $('btnEnd'),
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

function appendSeparator(userId, verb) {
  const line = {
    user_id: userId, verb,
    at: new Date().toISOString(),
    key: `${userId}-${verb}-${Date.now()}`,
    name: userId === peerId ? peerLabel() : 'Stranger',
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
  transcriptMessages.push({
    id: row.id, room_id: row.room_id, sender_id: row.sender_id,
    content: row.content, created_at: row.created_at,
    reply_to: row.reply_to ?? null, sender_name: mine ? undefined : peerLabel(),
  });
  appendMessageBubble({ mine, name: peerLabel(), content: row.content });
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
      if (payload?.sender_id && payload.sender_id !== myId && payload.sender_id === peerId) {
        showTyping();
      }
    })
    .subscribe();
}

let typingTimer = null;
function showTyping() {
  els.typing.textContent = `${peerLabel()} is typing…`;
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
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

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
    if (payload?.senderId && payload.senderId !== myId) onSignal(payload);
  });
  await subscribeAndWait(signalChannel);
  await sendSignal({ kind: 'ready' });
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
      default:
        break; // group / room-open kinds are Phase 2 — ignored by 1:1
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
  await returnToSearching({ notifyPeer: false });
}

async function returnToSearching({ notifyPeer, pause = false }) {
  if (ending || restarting) return;
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
  phase = 'failed';
  els.failText.textContent = message;
  els.failBanner.classList.remove('hidden');
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
    const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
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
  // audio outputs, switch the remote element between them.
  const v = els.remoteVideo;
  if (typeof v.setSinkId === 'function') {
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
els.btnNext.addEventListener('click', () => returnToSearching({ notifyPeer: true }));
$('btnRetry').addEventListener('click', async () => {
  els.failBanner.classList.add('hidden');
  await teardownPeer();
  connectingMatch = false;
  searchNext();
});

async function endSession() {
  if (ending) return;
  ending = true;
  stopSearch();
  if (phase === 'searching') await rpc('cancel_matchmaking');
  if (roomId) {
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
  if (roomId) sendSignal({ kind: 'hangup' });
  if (phase === 'searching') rpc('cancel_matchmaking');
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
// ===================================================================
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: { facingMode: 'user' },
    });
  } catch (e) {
    if (e?.name === 'NotAllowedError') {
      fail('Camera and microphone permission is required to make calls. Please allow them and try again.');
    } else {
      fail(`Call setup failed: ${e.message ?? e}`);
    }
    return false;
  }
  els.localVideo.srcObject = localStream;
  return true;
}

async function boot() {
  const user = await currentUser();
  if (!user) return location.replace('index.html');
  if (localStorage.getItem(LS.age) !== '1') return location.replace('index.html');
  const profile = await myProfile();
  if (!profile?.display_name?.trim()) return location.replace('index.html');
  myId = user.id;
  els.selfName.textContent = profile.display_name;

  setPhase('preparing');
  if (!await initLocalMedia()) return;
  let left = PREPARE_SECONDS;
  els.prepareCount.textContent = String(left);
  prepareCountdown = setInterval(() => {
    if (phase !== 'preparing') return;
    left = Math.max(0, left - 1);
    els.prepareCount.textContent = left > 0 ? String(left) : '';
  }, 1000);
  prepareTimer = setTimeout(() => {
    clearInterval(prepareCountdown);
    searchNext();
  }, PREPARE_SECONDS * 1000);
}

boot();
