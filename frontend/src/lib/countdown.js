import { useEffect, useMemo, useState } from 'react';

/**
 * Time left until an ISO instant, measured on the server's clock so a wrong phone clock
 * doesn't change it. `serverTime` is the ISO time the server sent with the same response.
 * Returns null while there is nothing to count down to.
 */
export function useCountdown(expiresAt, serverTime) {
  const offset = useMemo(() => {
    const t = serverTime ? Date.parse(serverTime) : NaN;
    return Number.isNaN(t) ? 0 : t - Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTime]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return null;
  return end - (now + offset);
}
