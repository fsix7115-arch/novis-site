// Accent theme application — mirrors the app's accent_themes.dart:
// the default 'Golden Hour' accent is always free; the bonus accents
// (Sunset / Emerald / Solar) can only be SELECTED while premium time
// is running (Settings enforces that), but a stored selection always
// applies — if premium lapses, the selection stays until the user
// picks another (no jarring swap). This tiny classic script runs in
// <head> so the chosen accent is in place before first paint.
(function () {
  try {
    var idx = parseInt(localStorage.getItem('novis_accent_index') || '0', 10);
    var accents = [
      null, // Golden Hour — the built-in default, no override
      ['#ff9100', '#ff4081'], // Sunset
      ['#00e676', '#00bfa5'], // Emerald
      ['#ffd600', '#ff9100'], // Solar
    ];
    var a = accents[idx];
    if (!a) return;
    document.documentElement.style.setProperty('--sunset-orange', a[0]);
    document.documentElement.style.setProperty('--sunset-violet', a[1]);
  } catch (e) { /* defaults stay; cosmetic only */ }
})();
