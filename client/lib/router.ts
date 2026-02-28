import { store, type Tab } from './store';

const views: Record<Tab, HTMLElement | null> = {
  tmux: null,
  settings: null,
};

const tabBtns: HTMLButtonElement[] = [];
const onTabChange: Array<(tab: Tab) => void> = [];

export function onTab(fn: (tab: Tab) => void): () => void {
  onTabChange.push(fn);
  return () => {
    const i = onTabChange.indexOf(fn);
    if (i >= 0) onTabChange.splice(i, 1);
  };
}

export function switchTab(tab: Tab): void {
  store.set('tab', tab);

  // Update views
  for (const [key, el] of Object.entries(views)) {
    if (el) {
      el.classList.toggle('hidden', key !== tab);
    }
  }

  // Update tab buttons
  tabBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  onTabChange.forEach((fn) => fn(tab));
}

export function initRouter(): void {
  views.tmux = document.getElementById('view-tmux');
  views.settings = document.getElementById('view-settings');

  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    tabBtns.push(btn);
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as Tab;
      if (tab) switchTab(tab);
    });
  });

  switchTab('tmux');
}
