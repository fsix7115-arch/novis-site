// The one premium clock for the whole website — a faithful mirror
// of the app's premium_time.dart (usool-set, 2026-11-10): every
// cosmetic lock (bonus accent themes, the golden profile frame)
// reads this single "premium until" timestamp. A rewarded ad extends
// it by 24h, stacked from the current expiry while premium is still
// running. Testing premium is a separate override that also counts
// as premium on (and turns all ads off).
//
// HONESTY RULE (mirrors the app exactly): the grant is credited by
// the rewarded-ad callback. There is no AdMob on web — the app's own
// non-Android builds show the unlock label with the line "Unlocking
// happens in the Android app." and NEVER credit anything locally
// without a real ad. This module does the same: grantRewarded()
// exists for the day a real web rewarded format is connected, and
// nothing on the website calls it today.
import { isTestingPremium } from './testing.js';

const UNTIL_KEY = 'novis_premium_until_ms';
const LEGACY_KEY = 'novis_accent_unlock_until_ms';
export const PREMIUM_GRANT_MS = 24 * 60 * 60 * 1000; // AdsConfig.premiumGrantDuration

function readMs(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// The shared premium expiry (ms epoch), or null. On read it also
/// honours the legacy accent-theme unlock key and keeps the later
/// of the two — same carry-over as the app.
export function premiumUntilMs() {
  const a = readMs(UNTIL_KEY);
  const b = readMs(LEGACY_KEY);
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export function adPremiumActive(nowMs = Date.now()) {
  const until = premiumUntilMs();
  return until != null && until > nowMs;
}

/// Premium from any source: Testing premium (owner) or the ad clock.
export function premiumActive(nowMs = Date.now()) {
  return isTestingPremium() || adPremiumActive(nowMs);
}

/// Where a grant lands: stacked from the current expiry while
/// premium is still running; from now once it has lapsed.
export function stackedPremiumGrant(nowMs, currentUntilMs) {
  const base = currentUntilMs != null && currentUntilMs > nowMs ? currentUntilMs : nowMs;
  return base + PREMIUM_GRANT_MS;
}

/// Credits one rewarded ad: +24h stacked. ONLY a real rewarded-ad
/// reward callback may call this — nothing on the web does today
/// (see the honesty rule above).
export function grantRewarded() {
  const next = stackedPremiumGrant(Date.now(), premiumUntilMs());
  try {
    localStorage.setItem(UNTIL_KEY, String(next));
  } catch { /* cosmetic only */ }
  return next;
}

/// "Premium time left" formatting — ported exactly: whole minutes,
/// rounded up so a fresh grant never reads short. 26h15m under two
/// days, then days.
export function formatPremiumTimeLeft(ms) {
  if (!(ms > 0)) return '0m';
  const minutes = Math.floor((Math.floor(ms / 1000) + 59) / 60);
  if (minutes >= 48 * 60) {
    return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
  }
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/// The one honest unlock affordance for every cosmetic lock — the
/// same label everywhere: "Watch ad to unlock • 24h". On the web
/// (where AdsService is unsupported, exactly like the app's web
/// build) it renders as the label plus the honest line that
/// unlocking happens in the Android app — never a dead button.
export const UNLOCK_LABEL = 'Watch ad to unlock • 24h';
export function renderUnlockNote(container) {
  container.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'unlock-label';
  label.textContent = UNLOCK_LABEL;
  const line = document.createElement('div');
  line.className = 'unlock-line';
  line.textContent = 'Unlocking happens in the Android app.';
  container.append(label, line);
}
