import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const SiteContext = createContext(null);

/** Loads rooms, booking rules and the studio clock once for the public pages. */
export function SiteProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const load = useCallback(() => {
    setState((s) => ({ ...s, status: s.data ? 'refreshing' : 'loading' }));
    api
      .site()
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => setState((s) => ({ status: s.data ? 'ready' : 'error', data: s.data, error })));
  }, []);

  useEffect(load, [load]);

  return <SiteContext.Provider value={{ ...state, reload: load }}>{children}</SiteContext.Provider>;
}

export const useSite = () => useContext(SiteContext);
