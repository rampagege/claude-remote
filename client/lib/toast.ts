let activeToast: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: 'info' | 'error' = 'info'): void {
  // Remove existing
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(-8px)';

  document.body.appendChild(el);
  activeToast = el;

  // Animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  });

  // Auto-hide
  hideTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-8px)';
    setTimeout(() => {
      el.remove();
      if (activeToast === el) activeToast = null;
    }, 300);
  }, 3000);
}
