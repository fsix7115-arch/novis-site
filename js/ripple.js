// Bounded press ripple — one delegated listener for the whole site.
// The ripple starts at the tap point and is clipped to the button's
// own border-radius (every interactive control has overflow:hidden),
// so it never spills outside the button or shifts layout. Works with
// mouse and touch (pointerdown); the span removes itself after the
// animation. No framework, no dependency.
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('button, a.btn');
  if (!el || el.disabled) return;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.width = d + 'px';
  s.style.height = d + 'px';
  s.style.left = (e.clientX - r.left - d / 2) + 'px';
  s.style.top = (e.clientY - r.top - d / 2) + 'px';
  el.appendChild(s);
  const done = () => s.remove();
  s.addEventListener('animationend', done, { once: true });
  setTimeout(done, 800); // safety net if the animation never fires
}, { passive: true });
