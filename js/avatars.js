// Preset gradient avatars — mirrors the app's avatar_presets.dart.
// Stored in profiles.avatar_url as 'preset:<n>' — no uploads, no
// storage bucket. The golden rim is the premium golden profile
// frame (renders only while premium is on; callers decide).
export const PRESET_GRADIENTS = [
  ['#00e5ff', '#7c4dff'],
  ['#ff9100', '#ff4081'],
  ['#00e676', '#00bfa5'],
  ['#ffd600', '#ff9100'],
  ['#448aff', '#00e5ff'],
  ['#e040fb', '#7c4dff'],
  ['#ff5252', '#ff9100'],
  ['#69f0ae', '#448aff'],
];

export function presetValue(index) {
  return `preset:${index}`;
}

export function presetIndex(avatarUrl) {
  if (!avatarUrl || !avatarUrl.startsWith('preset:')) return null;
  const n = Number.parseInt(avatarUrl.slice('preset:'.length), 10);
  if (!Number.isInteger(n) || n < 0 || n >= PRESET_GRADIENTS.length) return null;
  return n;
}

export function gradientCss(avatarUrl) {
  const [a, b] = PRESET_GRADIENTS[presetIndex(avatarUrl) ?? 0];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/// A circular preset avatar element: gradient + first initial.
export function avatarEl({ name, avatarUrl, size = 48, golden = false }) {
  const el = document.createElement('span');
  el.className = `avatar${golden ? ' golden' : ''}`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.42)}px`;
  el.style.background = gradientCss(avatarUrl);
  el.textContent = name?.trim() ? [...name.trim()][0].toUpperCase() : '?';
  return el;
}
