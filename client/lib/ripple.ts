/**
 * Attaches Material-style ripple effect to all matching elements.
 * Uses event delegation on the document for dynamically rendered elements.
 */
const RIPPLE_SELECTORS = '.tmux-card, .btn-accent, .btn-secondary, .btn-danger, .tab-btn, .extra-key';

export function initRipple(): void {
  document.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>(RIPPLE_SELECTORS);
    if (!target) return;

    // Ensure host class is present (for overflow: hidden)
    target.classList.add('ripple-host');

    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}
