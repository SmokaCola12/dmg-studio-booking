// Small in-memory counters keyed by IP (or any string). One server process, so memory is enough.

const WINDOW_MS = 15 * 60_000;

export function createLimiter({ max, windowMs = WINDOW_MS }) {
  const entries = new Map();

  function current(key, now) {
    const e = entries.get(key);
    if (!e || now - e.first > windowMs) return null;
    return e;
  }

  function purge(now) {
    if (entries.size < 2000) return;
    for (const [k, e] of entries) if (now - e.first > windowMs) entries.delete(k);
  }

  return {
    /** True when `key` has used up its allowance in the current window. */
    blocked(key, now = Date.now()) {
      const e = current(key, now);
      return !!e && e.count >= max;
    },
    /** Counts one use. Returns false (and counts nothing) when the key is already over its allowance. */
    take(key, now = Date.now()) {
      purge(now);
      const e = current(key, now);
      if (!e) {
        entries.set(key, { count: 1, first: now });
        return true;
      }
      if (e.count >= max) return false;
      e.count += 1;
      return true;
    },
    /** Counts one miss (used for failed code + phone matches). */
    add(key, now = Date.now()) {
      purge(now);
      const e = current(key, now);
      if (!e) entries.set(key, { count: 1, first: now });
      else e.count += 1;
    },
    reset() {
      entries.clear();
    },
  };
}

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// Receipt uploads per IP (customers can upload without an account).
export const uploadLimiter = createLimiter({ max: envInt('UPLOAD_RATE_LIMIT', 10) });
// Failed booking code + phone matches per IP, shared by lookup, cancel, reschedule and every payment route. 30 per
// 15 minutes leaves room for several people behind one shared mobile-carrier IP; a blocked IP is refused even with a
// correct code + phone, which is what stops brute-forcing booking codes.
export const lookupFailures = createLimiter({ max: envInt('LOOKUP_FAIL_LIMIT', 30) });
// Test emails sent from the admin Settings page, counted for the whole server (staff share one login).
export const testEmailLimiter = createLimiter({ max: envInt('TEST_EMAIL_RATE_LIMIT', 5), windowMs: 10 * 60_000 });
