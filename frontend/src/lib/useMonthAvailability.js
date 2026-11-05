import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * Day-by-day status for one month ('YYYY-MM'): open, few, full or closed.
 * Ignores stale replies and refreshes every minute while the tab is visible.
 */
export function useMonthAvailability(month, { refreshMs = 60_000 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reqId = useRef(0);

  const load = useCallback(
    (quiet = false) => {
      if (!month) return;
      const id = ++reqId.current;
      if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
      api
        .availabilityMonth(month)
        .then((data) => id === reqId.current && setState({ data, error: null, loading: false }))
        .catch((error) => id === reqId.current && setState((s) => ({ ...s, error, loading: false })));
    },
    [month]
  );

  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  // Never hand back another month's data while this one is loading.
  const data = state.data && state.data.month === month ? state.data : null;
  return { data, error: state.error, loading: state.loading, reload: load };
}
