import { store } from './store';
import { connect, disconnect } from './ws';
import { showToast } from './toast';

const serverUrlInput = () => document.getElementById('setting-server-url') as HTMLInputElement;
const tokenInput = () => document.getElementById('setting-token') as HTMLInputElement;
const connectBtn = () => document.getElementById('btn-connect') as HTMLButtonElement;
const themeToggle = () => document.getElementById('btn-theme-toggle') as HTMLButtonElement;
const thumbSlider = () => document.getElementById('setting-thumb-height') as HTMLInputElement;
const thumbLabel = () => document.getElementById('thumb-height-label') as HTMLElement;
const thumbRefreshSelect = () =>
  document.getElementById('setting-thumb-refresh') as HTMLSelectElement;
const fontSlider = () => document.getElementById('setting-font-size') as HTMLInputElement;
const fontLabel = () => document.getElementById('font-size-label') as HTMLElement;

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute('content', dark ? '#18181b' : '#ffffff');
  }
}

export function initSettings(): void {
  // Load stored values
  serverUrlInput().value = store.get('serverUrl');
  tokenInput().value = store.get('token');
  applyTheme(store.get('darkMode'));

  // Thumbnail height slider
  const slider = thumbSlider();
  const label = thumbLabel();
  const initThumb = store.get('thumbHeight');
  slider.value = String(initThumb);
  label.textContent = initThumb === 0 ? 'Off' : `${initThumb}%`;
  slider.addEventListener('input', () => {
    const val = parseInt(slider.value, 10);
    label.textContent = val === 0 ? 'Off' : `${val}%`;
    store.set('thumbHeight', val);
  });

  // Thumbnail refresh select
  const refreshSel = thumbRefreshSelect();
  refreshSel.value = String(store.get('thumbRefresh'));
  refreshSel.addEventListener('change', () => {
    store.set('thumbRefresh', parseInt(refreshSel.value, 10));
  });

  // Font size slider
  const fSlider = fontSlider();
  const fLabel = fontLabel();
  const initFont = store.get('fontSize');
  fSlider.value = String(initFont);
  fLabel.textContent = `${initFont}px`;
  fSlider.addEventListener('input', () => {
    const val = parseInt(fSlider.value, 10);
    fLabel.textContent = `${val}px`;
    store.set('fontSize', val);
  });

  // Theme toggle
  themeToggle().addEventListener('click', () => {
    const newValue = !store.get('darkMode');
    store.set('darkMode', newValue);
    applyTheme(newValue);
  });

  // Connect button
  connectBtn().addEventListener('click', () => {
    const url = serverUrlInput().value.trim();
    const token = tokenInput().value.trim();

    if (!url) {
      showToast('Enter a server URL', 'error');
      return;
    }

    store.set('serverUrl', url);
    store.set('token', token);
    disconnect();
    connect(url, token);
    showToast('Connecting...');
  });

  // Update connection button based on status
  store.subscribe((state, key) => {
    if (key === 'status') {
      const btn = connectBtn();
      switch (state.status) {
        case 'connected':
          btn.textContent = 'Reconnect';
          break;
        case 'connecting':
          btn.textContent = 'Connecting...';
          break;
        case 'disconnected':
          btn.textContent = 'Connect';
          break;
      }
    }
  });
}
