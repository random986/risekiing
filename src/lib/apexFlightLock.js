/**
 * Global single-flight latch — one apex contract in transit at a time.
 * Hard auto-release after 3s prevents permanent stalling after any loss or network hiccup.
 */

const TICK_SETTLE_MS = 950;      // Normal post-place hold (tick duration)
const MAX_LOCK_MS    = 3000;     // Hard ceiling — lock ALWAYS releases within 3s

let _inFlight     = false;
let _releaseTimer = null;
let _armedAt      = 0;

function _clearTimer() {
  if (_releaseTimer) {
    clearTimeout(_releaseTimer);
    _releaseTimer = null;
  }
}

function syncWindow() {
  if (typeof window !== 'undefined') {
    window.isApexOrderInFlight = _inFlight;
  }
}

export function isApexOrderInFlight() {
  // Auto-expire stale locks that somehow outlived their timer
  if (_inFlight && _armedAt > 0 && Date.now() - _armedAt > MAX_LOCK_MS) {
    _inFlight = false;
    _armedAt  = 0;
    _clearTimer();
    syncWindow();
  }
  return _inFlight;
}

export function setApexOrderInFlight(value) {
  _inFlight = !!value;
  _armedAt  = value ? Date.now() : 0;
  syncWindow();
  _clearTimer();
  // If setting true, always arm the hard ceiling so it cannot stick
  if (_inFlight) {
    _releaseTimer = setTimeout(() => {
      _inFlight = false;
      _armedAt  = 0;
      syncWindow();
    }, MAX_LOCK_MS);
  }
}

/** Arm lock until tick duration elapses (default ~1s), hard ceiling 3s. */
export function armApexOrderInFlight(ms = TICK_SETTLE_MS) {
  const holdMs = Math.min(ms, MAX_LOCK_MS);
  setApexOrderInFlight(true);
  // Override with shorter hold if ms < MAX_LOCK_MS
  _clearTimer();
  _releaseTimer = setTimeout(() => {
    _inFlight = false;
    _armedAt  = 0;
    syncWindow();
  }, holdMs);
}

export function tryAcquireApexLock() {
  if (isApexOrderInFlight()) return false;   // isApexOrderInFlight() auto-expires stale locks
  setApexOrderInFlight(true);
  return true;
}
