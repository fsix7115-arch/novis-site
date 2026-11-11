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
| `home.html` + `js/home.js` | Scrollable Home: Start a Video Connection hero, Friends / AI Friend / Ads Time tiles (Phase 2), trust strip, Recent chats summary, "Good to know" instructions. |
| `call.html` + `js/call.js` | The call: 5-second branded Prepare once per entry → searching → WebRTC 1:1. Desktop: frames centre (stranger, then you — always last, 16:9), ONE chat docked right at full height, floatable (drag + width/height resize, geometry in `localStorage`). Phone: stranger → chat → you → toolbar; hiding the chat closes the frames up. Pause / Next / End loop in-screen; peer leaving auto-searches again. One continuous session transcript (waiting self-chat is local-only, like the app). |
| `history.html` + `js/history.js` | Recent chats: the finished session's whole transcript as ONE view-only entry, stored on-device (`localStorage` key `novis_local_session_chats`, the app's own store design), auto-deleted 30 minutes after the session ended, max 5 entries, "Clear now" per entry. |

## Shared code

- `js/config.js` — Supabase URL + anon key. The anon key is
  client-public (it ships in the Android app too); RLS guards data.
- `js/supabase.js` — client + profile/ban helpers (ban check sends
  SHA-256 hashes only and fails open, like the app).
- `js/history-store.js` — the recent-chats store.
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

## Phase 2 will extend this with

Group calls (room-open joins, mesh, pins/speaker order), the AI Friend
chat page (Darling / Honey via the existing `ai-dost` edge function),
Friends + full Profile/Settings, Ads Time premium unlocks, and AdSense
on the site once approved (the hidden Testing door + premium ad gate
are already live — see `js/testing.js`). Each lands as its own page +
script beside the Phase 1 files, reusing the same protocol layer in
`js/call.js`.

## House rules

English UI text only. No `user-scalable=no` anywhere — the browser's
own zoom and scroll are the point of this site. The logo never sits on
a plain white/black background. There is deliberately **no camera-off
control** in calls (owner rule).
