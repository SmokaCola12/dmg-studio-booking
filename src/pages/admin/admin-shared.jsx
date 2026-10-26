import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const AdminContext = createContext(null);
export const useAdmin = () => useContext(AdminContext);

/** Runs an async loader and keeps { data, error, loading } with a reload function. */
export function useLoader(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const req = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  const load = useCallback(
    (quiet = false) => {
      const id = ++req.current;
      if (!quiet) setState((s) => ({ ...s, loading: true }));
      return run()
        .then((data) => {
          if (id === req.current) setState({ data, error: null, loading: false });
          return data;
        })
        .catch((error) => {
          if (id === req.current) setState((s) => ({ ...s, error, loading: false }));
        });
    },
    [run]
  );

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="a-head">
      <div className="a-head-text">
        <h1 className="a-title">{title}</h1>
        {sub && <p className="a-sub">{sub}</p>}
      </div>
      {children && <div className="a-head-actions">{children}</div>}
    </div>
  );
}

export function LoadError({ error, onRetry }) {
  return (
    <div className="notice notice-bad a-error">
      <span>{error?.message || 'This didn’t load.'}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-outline" onClick={() => onRetry()}>
          Try again
        </button>
      )}
    </div>
  );
}

/** All hours the studio could be open, for selects. */
export const HOURS_0_24 = Array.from({ length: 25 }, (_, i) => i);
