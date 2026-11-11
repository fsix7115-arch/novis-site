# Novis — the real website

Plain HTML/CSS/JS (no framework, no build step) served by GitHub Pages.
This is the Novis web experience rebuilt as a true website — native
document scroll and browser zoom — while the Android app stays Flutter.

**Live:** https://fsix7115-arch.github.io/novis-site/

## Same backend, same stranger pool

The site talks to the **same Supabase project** as the app
(`gpvqnkpszdfbqwdqjatx`) and mirrors the app's wire protocol exactly,
so a person on this website and a person on Android are matched into
the same rooms:

- **Matching** — `find_or_join_match` RPC (`p_mode: 'video'`), then
  realtime `UPDATE` watch on the caller's `matchmaking_queue` ticket
  plus a 12-second RPC re-poll (tickets expire server-side).
- **Signaling** — private Supabase Realtime broadcast channel
  `call-<roomId>`, event `signal`. Payloads carry the message kind in
  the **`kind`** key (the envelope owns `type`). Handshake: both sides
  send `ready`; the `offerer` offers on the peer's `ready`, the
  `answerer` echoes `ready` once. ICE candidates arriving before the
  remote description are buffered (max 100). `presence` (mic + hand),
  `unmute-request` (addressed, 30s cooldown) and `hangup` included.
- **Chat** — rows in `public.messages` (insert returns the row;
  realtime `INSERT` on `messages-<roomId>` dedupes the echo), typing
  on the private broadcast channel `chat-<roomId>`.
- **ICE** — `stun:stun.l.google.com:19302`, then the app's
  `turn-credentials` Edge Function list, then Metered's public Open
  Relay pool — same order as `CallRepository.fetchIceServers`.
- **Bookkeeping** — `update_call_status` / `end_room_participation`
  RPCs, best-effort, exactly like the app.

Source of truth for every behavior above: `novis-build/lib/features/`
(`call/`, `matchmaking/`, `chat/`, `auth/`). If the app protocol
changes, change this site in the same commit round.

## Pages

| File | What |
| --- | --- |
| `index.html` + `js/gate.js` | Entry gate: Log in / Sign up / Guest (choice remembered, signed-in users skip it), then ban check → 18+ gate → one-time name ask → Home. Sign-up is instant (email confirmation is off server-side), with the app's temp-mail block check and one-time referral claim. |
| `home.html` + `js/home.js` | Scrollable Home: Start a Video Connection hero, Friends / AI Friend / Ads Time tiles (all live, Phase 2), an (empty until AdSense approval) ad slot, trust strip, Recent chats summary, "Good to know" instructions. Topbar links: My ID / Profile / Settings / Sign out. |
| `call.html` + `js/call.js` | The call: 5-second branded Prepare once per entry → searching → WebRTC 1:1 **and group mesh** (Phase 2, below). Desktop: frames centre (stranger, then you — always last, 16:9), ONE chat docked right at full height, floatable (drag + width/height resize, geometry in `localStorage`). Phone: stranger → chat → you → toolbar; hiding the chat closes the frames up. Pause / Next / End loop in-screen; peer leaving auto-searches again. One continuous session transcript (waiting self-chat is local-only, like the app). |
| `history.html` + `js/history.js` | Recent chats: the finished session's whole transcript as ONE view-only entry, stored on-device (`localStorage` key `novis_local_session_chats`, the app's own store design), auto-deleted 30 minutes after the session ended, max 5 entries, "Clear now" per entry. |
| `ai-friend.html` + `js/ai-friend.js` | AI Friend: pick Darling (male) or Honey (female) — the choice persists server-side (`ai_dost_prefs`). Sends to the live `ai-dost` Edge Function with the app's exact body (`message`, `persona`, last-8 `history`); replies arrive in the user's own language (server-side). Limit state ("That's all for today…"), not-configured state and error+Retry mirror the app. History is in-memory only. |
| `friends.html` + `js/friends.js` | Friends (signed-up users; guests get the account pitch): list from `friends` + `public_profiles`, add-by-code via `add_friend_by_code` with the app's error mapping, unfriend, incoming group invites (pending, last 10 min, realtime) with Accept → seat + join, and hosting a friends group call (pick up to 3, `chat_rooms` mode `group` + invites → `call.html?room=<id>&group=1`). Friend/referral codes are signed-up-only server-side (`account_type = 'email'`). |
| `profile.html` + `js/profile.js` | Profile (signed-up users; guests get the pitch with their public face): preset avatars (`preset:<n>`, the app's 8 gradients), display name + bio (140) editing, golden profile frame (premium cosmetic — switch live only while premium is on; the choice persists and lapses gracefully), Novis ID + Copy, the **visible** friend & referral code (`ensure_friend_code` / `regenerate_friend_code`), sign-out. |
| `settings.html` + `js/settings.js` | Settings: **Speaker on top** (drives group frame order via `localStorage` key `novis_speaker_on_top`), Ads Time balance + ON/OFF (`ads_time_status` / `ads_time_set_active`), Appearance — accent themes (Golden Hour free; Sunset / Emerald / Solar open only while premium is live, selection persists through a lapse), sign-out. |
| `ads-time.html` + `js/ads-time.js` | Ads Time: server balance + ON/OFF toggle + ledger history (`Watched ad +30` / `Referral +15` / `Ad-free time −12`, dates `d MMM, HH:mm`). The balance is credited ONLY by AdMob SSV on Android — this page never credits anything. Earning on web shows the app's own non-Android line: "Watch ads to earn Ads Time in the Android app." Plus the premium-clock status (below). |

## Group calls (Phase 2)

Built into the same `call.html` / `js/call.js` — one engine, the way
the app swaps its 1:1 controller for the group mesh on one screen:

- **Mesh** — a full-mesh `RTCPeerConnection` per pair over the same
  private `call-<roomId>` channel. Join handshake: the joiner
  broadcasts `group-join` (plus one re-announce at +2s); present
  members reply with addressed `group-present` + addressed
  `presence`. **Deterministic offer rule: the lexicographically
  smaller user id offers, once.** SDP over 64 KiB is dropped, ICE is
  buffered per pair (max 100) until the remote description lands,
  and per-pair errors never kill the mesh.
- **Migration** — a `group-join` from a third participant while a 1:1
  call is connecting/connected moves the call into the mesh on the
  SAME room: the 1:1 engine tears down silently (no hangup, no
  status change), the chat and transcript continue untouched.
- **Entry paths** — (a) the **Add** control in a live 1:1 call writes
  the server flag first (`set_room_open_for_join`), then broadcasts
  `room-open`/`room-closed`; nobody enters without the pair's
  permission. (b) While searching, open rooms are polled every 8s
  (`list_open_rooms` — count + opened-at ONLY, never names/ids) and
  offered as Join cards; `join_open_room` seats the joiner first
  (room cap 8, server-side; a removed user can never rejoin).
  (c) Friends invites/hosting land directly in group mode via
  `call.html?room=<id>&group=1` (friends rooms hold 4, server-side).
- **Membership** — `room_participants` roster + realtime watch drive
  tiles, join/left transcript separators and notices; being removed
  ejects the user back to searching with a notice. Leaving: a host
  closes the door first, then `leave_open_room` +
  `end_room_participation`. Group **Next** leaves back to searching
  with no second Prepare; group **End** saves the one session History
  entry first. **Pause does not exist in group mode** (app rule).
- **Frames** — order: pins first (pin order), then the current
  speaker among the unpinned, then join order; **Speaker on top**
  (Settings, default OFF) lifts the speaker above the pins. Own
  frame always last. Desktop: one side stack, height-driven 16:9,
  scrolling past 4 frames; ONE chat docked right (same float system).
  Phone: strangers scroll on top, chat in the middle, own frame
  below, toolbar at the bottom. With 2+ strangers the own frame can
  pop out as a draggable 1:1 square; expand returns it to its slot.
- **Safety** — long-press a participant: Report (6 reasons,
  `submit_report`), Block (`blocks` upsert + local pair drop), and
  host-only Remove (`remove_room_participant`, joiners with role
  `peer` only). A muted participant's badge sends an addressed
  `unmute-request` (30s cooldown). Speaking is a 600ms stats poll
  (audioLevel, 0.12/0.04 hysteresis) driving the speaking rim + chip
  and the frame order.
- One transport adaptation vs Dart: the app creates a fresh
  signaling subscription per engine; the site keeps ONE subscription
  per room across the 1:1→group swap (identical wire behavior —
  same channel, same events, same payloads).

## Premium, Ads Time and the ad gate (Phase 2)

- `js/premium.js` — the ONE premium clock (`premium_time.dart`):
  a `premium until` timestamp in `localStorage`
  (`novis_premium_until_ms`, legacy `novis_accent_unlock_until_ms`
  honoured). One rewarded ad = **+24h, stacked**. Every cosmetic
  lock reads it — bonus accent themes and the golden profile frame —
  and every lock shows the same label: **"Watch ad to unlock •
  24h"**. Core features (video call, chat, Skip, group-join) are
  NEVER locked, and no ad ever appears mid-call.
- **Honesty rule, mirrored from the app:** the grant is credited by
  the rewarded-ad callback on Android. There is no AdMob on web, so
  — exactly like the app's own web build — the unlock affordance on
  this site is the label plus the line "Unlocking happens in the
  Android app." Nothing here fakes a watch or grants premium for
  nothing. `grantRewarded()` exists for the day a real web rewarded
  format is connected; nothing calls it today.
- **Testing premium** (hidden door, below) overrides everything:
  locks open, all ads off site-wide via `applyAdsGate()`.
- **Ad inventory status:** AdSense is still in Google review and
  AdMob is not approved, so no real ads render anywhere yet. The
  Home page carries the (empty) `.ad-slot` placement; real units
  drop in when Google approves, with no code changes needed beyond
  the unit itself.

## Shared code

- `js/config.js` — Supabase URL + anon key. The anon key is
  client-public (it ships in the Android app too); RLS guards data.
- `js/supabase.js` — client + profile/ban helpers (ban check sends
  SHA-256 hashes only and fails open, like the app).
- `js/history-store.js` — the recent-chats store.
- `js/premium.js` — the shared premium clock + unlock affordance (see
  the premium section below).
- `js/accent.js` — applies the stored accent selection before first
  paint (tiny classic script in every page's `<head>`).
- `js/avatars.js` — the app's 8 preset avatar gradients + the golden
  frame rim, shared by Profile/Friends.
- `js/ripple.js` — one delegated listener: every button press gets a
  ripple that starts at the tap point and is clipped to the button's
  own border-radius (all controls carry `overflow: hidden`), so the
  animation never spills outside the button or shifts layout.
- `js/testing.js` — the hidden Testing door, mirroring the app's
  AboutSheet unlock exactly: a small muted ⓘ top-right of the entry
  gate opens the About sheet; triple-tapping the line "All features
  in this build have been tested and verified." (each tap within
  800ms) opens the password prompt. The password is checked as a
  SHA-256 hex compare against the hash stored in the app (hash only,
  never the password). 5 wrong attempts lock this device for 12h.
  Testing premium ON turns all ads off (`shouldShowAds()` /
  `applyAdsGate()` is the switch Phase 2 ads check); the premium
  panel (About sheet, only while premium is on) offers Turn off
  premium, Clear recent chats, and Fresh test start (signs out and
  wipes this device's website data). No visible Testing link exists
  anywhere — the door is hidden by design.
- `css/theme.css` — the app's warm golden-hour palette (`AppColors`)
  as CSS variables; ambient page background is two sunset glows
  drifting slowly (disabled under `prefers-reduced-motion`).
  Premium web fonts: **Fraunces** (display serif — headings, brand
  word) and **Manrope** (body + buttons), loaded from Google Fonts
  with serif / system fallbacks if offline.

## Still outstanding

- Real ad units (AdSense approval pending with Google; AdMob account
  approval is the owner's personal attestation step).
- The new website taking over the `novis-app` address — the Flutter
  web build stays live there until the owner says swap.
- Live-device proof: a real 3-device group media call and web↔Android
  calls can only be proven on the owner's devices, not from CI.

## House rules

English UI text only. No `user-scalable=no` anywhere — the browser's
own zoom and scroll are the point of this site. The logo never sits on
a plain white/black background. There is deliberately **no camera-off
control** in calls (owner rule).
