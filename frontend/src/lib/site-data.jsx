import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { site } from '../config/site.js';

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

const CONTACT_KEYS = ['address', 'landmark', 'mapsQuery', 'phone', 'email', 'messenger', 'socials'];

/** Merges owner-edited contact details over the defaults in config/site.js, field by field. */
export function mergeContact(contact) {
  const out = { ...site };
  for (const k of CONTACT_KEYS) {
    const v = contact?.[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** The static site config with the owner's saved contact details applied. Never blocks render. */
export function useStudioInfo() {
  const ctx = useContext(SiteContext);
  const contact = ctx?.data?.content?.contact;
  return useMemo(() => mergeContact(contact), [contact]);
}

/** Gallery photos uploaded in the admin, or an empty list. */
export function useGallery() {
  const ctx = useContext(SiteContext);
  return ctx?.data?.content?.gallery || [];
}
