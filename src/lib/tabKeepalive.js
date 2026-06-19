/**
 * Keeps trading engines responsive when the tab is hidden or minimized.
 * Browsers throttle setTimeout in background tabs; WebSocket ticks still arrive.
 */

import derivWS from './derivWS.js';

const listeners = new Set();

function notifyWake() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.warn('[tabKeepalive] listener error', e);
    }
  }
}

let installed = false;
let heartbeat = null;

export function registerTabKeepaliveListener(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installTabKeepalive() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const onVisibility = () => {
    derivWS.setBackgroundMode(document.hidden);
    if (document.hidden) {
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          if (!document.hidden) return;
          notifyWake();
        }, 1000);
      }
    } else {
      notifyWake();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', () => {
    if (!document.hidden) notifyWake();
  });

  onVisibility();
}
