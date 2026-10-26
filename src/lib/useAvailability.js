import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Loads busy times for a date and refreshes every minute so the board stays current. */
export function useAvailability(date, { refreshMs = 60_000 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reqId = useRef(0);

  const load = useCallback(
    (quiet = false) => {
      if (!date) return;
      const id = ++reqId.current;
      if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
      api
        .availability(date)
        .then((data) => id === reqId.current && setState({ data, error: null, loading: false }))
        .catch((error) => id === reqId.current && setState((s) => ({ ...s, error, loading: false })));
    },
    [date]
  );

  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { ...state, reload: load };
}
