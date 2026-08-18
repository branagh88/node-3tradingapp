// notifications.js

let timer = null;

export function toast(message, type = 'info', duration = 3500) {
  const root = document.querySelector('#toast-root');

  if (!root) {
    console[type === 'error' ? 'error' : 'log'](message);
    return;
  }

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'status');
  el.textContent = String(message ?? '');
  root.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast--visible'));

  timer = setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

export default toast;
