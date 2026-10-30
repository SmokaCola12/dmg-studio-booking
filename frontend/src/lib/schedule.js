// Mirrors the server's booking rules so the booking page can show what fits instantly.
// The server checks everything again when the booking is submitted.

export const overlaps = (busy, start, end) => busy.some((b) => start < b.end && end > b.start);

export function promoFreeHours(paidHours, settings) {
  if (!settings.promo_enabled) return 0;
  return paidHours >= settings.promo_buy_hours ? settings.promo_free_hours : 0;
}

/** For each possible start hour: whether it fits, and whether the free promo hour fits after it. */
export function startOptions({ busy, settings, window, paidHours }) {
  if (!window?.open) return [];
  const out = [];
  const promo = promoFreeHours(paidHours, settings);
  for (let h = settings.open_hour; h < settings.close_hour; h++) {
    const paidEnd = h + paidHours;
    const pastClosing = paidEnd > settings.close_hour;
    const taken = overlaps(busy, h, Math.min(paidEnd, settings.close_hour));
    let ok = h >= window.earliest && !pastClosing && !taken;
    let freeHours = 0;
    if (ok && promo > 0 && paidEnd + promo <= settings.close_hour && !overlaps(busy, paidEnd, paidEnd + promo)) {
      freeHours = promo;
    }
    if (h < window.earliest) ok = false;
    out.push({ hour: h, ok, freeHours, past: h < window.earliest, reason: taken ? 'taken' : pastClosing ? 'closing' : '' });
  }
  return out;
}

export function promoText(settings) {
  if (!settings?.promo_enabled) return '';
  const { promo_buy_hours: buy, promo_free_hours: free } = settings;
  return `Book ${buy} ${buy === 1 ? 'hour' : 'hours'}, get ${free === 1 ? 'the next hour' : `${free} more hours`} free`;
}
