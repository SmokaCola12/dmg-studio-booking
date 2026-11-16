const TOKEN_KEY = 'studio_admin_token';

export class ApiError extends Error {
  constructor(message, { status, fields, code } = {}) {
    super(message);
    this.status = status;
    this.fields = fields || {};
    // 'buffer' on a 409 means the time only clashes with another booking's cleaning time (staff can override).
    this.code = code || '';
  }
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export const adminToken = {
  get: readToken,
  set(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode: the session lasts until the tab closes */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

async function request(method, path, body, { admin = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) headers.Authorization = `Bearer ${readToken()}`;

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('Can’t reach the studio server. Check your connection and try again.', { status: 0 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (admin && res.status === 401) {
      adminToken.clear();
      window.dispatchEvent(new Event('admin:logout'));
    }
    throw new ApiError(data.error || 'Something went wrong. Try again.', { status: res.status, fields: data.fields, code: data.code });
  }
  return data;
}

/** Sends raw bytes (an image) instead of JSON. Used for gallery uploads. */
async function upload(path, blob) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': blob.type, Authorization: `Bearer ${readToken()}` },
      body: blob,
    });
  } catch {
    throw new ApiError('Can’t reach the studio server. Check your connection and try again.', { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      adminToken.clear();
      window.dispatchEvent(new Event('admin:logout'));
    }
    throw new ApiError(data.error || 'The upload didn’t work. Try again.', { status: res.status, fields: data.fields });
  }
  return data;
}

/** Header values must be plain printable ASCII, or fetch refuses them. */
const asciiHeader = (s, max = 200) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);

/**
 * POST with extra headers and an optional raw body (an image). No body means no Content-Type.
 * Used for receipt uploads, which carry the booking code and phone in headers so they stay out of URLs.
 */
async function sendRaw(path, blob, headers = {}, { admin = false } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (blob) h['Content-Type'] = blob.type || 'application/octet-stream';
  if (admin) h.Authorization = `Bearer ${readToken()}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', headers: h, body: blob || undefined });
  } catch {
    throw new ApiError('Can’t reach the studio server. Check your connection and try again.', { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (admin && res.status === 401) {
      adminToken.clear();
      window.dispatchEvent(new Event('admin:logout'));
    }
    throw new ApiError(data.error || 'The upload didn’t work. Try again.', { status: res.status, fields: data.fields, code: data.code });
  }
  return data;
}

/** Loads a private image (a receipt) with the admin token and returns an object URL for <img src>. Revoke it when done. */
async function adminImageUrl(path) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${readToken()}` } });
  } catch {
    throw new ApiError('Can’t reach the studio server.', { status: 0 });
  }
  if (!res.ok) {
    if (res.status === 401) {
      adminToken.clear();
      window.dispatchEvent(new Event('admin:logout'));
    }
    throw new ApiError('The screenshot didn’t load.', { status: res.status });
  }
  return URL.createObjectURL(await res.blob());
}

const query = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const api = {
  site: () => request('GET', '/site'),
  availability: (date) => request('GET', `/availability${query({ date })}`),
  availabilityMonth: (month) => request('GET', `/availability/month${query({ month })}`),
  createBooking: (payload) => request('POST', '/bookings', payload),
  lookupBooking: (code, phone) => request('POST', '/bookings/lookup', { code, phone }),
  cancelBooking: (code, phone) => request('POST', '/bookings/cancel', { code, phone }),
  // startMinute is 0 or 30. Public routes never send overrideBuffer; only staff can.
  rescheduleBooking: (code, phone, date, startHour, startMinute = 0) =>
    request('POST', '/bookings/reschedule', { code, phone, date, startHour, startMinute }),
  // GCash payment. The QR comes back as an SVG string with the exact amount inside.
  paymentQr: (code, phone) => request('POST', '/bookings/payment-qr', { code, phone }),
  // ref is what the customer left in the field. ocr = what the browser read off the screenshot
  // ({ ref: digits, amount: "210.00" }), sent as hints only: the studio still checks the payment in GCash.
  // The checks here are the server's own: X-Receipt-Ref is 8 to 20 digits and nothing else.
  uploadProof: (code, phone, file, ref = '', ocr = {}) =>
    sendRaw('/bookings/payment-proof', file, {
      'X-Booking-Code': asciiHeader(code, 20),
      'X-Booking-Phone': asciiHeader(phone, 30),
      ...(ref ? { 'X-Payment-Ref': asciiHeader(ref, 40) } : {}),
      ...(typeof ocr.ref === 'string' && /^\d{8,20}$/.test(ocr.ref) ? { 'X-Receipt-Ref': ocr.ref } : {}),
      ...(typeof ocr.amount === 'string' && /^\d{1,7}\.\d{2}$/.test(ocr.amount) ? { 'X-Receipt-Amount': ocr.amount } : {}),
    }),
  // "Pay later": gives the held slot back.
  releaseBooking: (code, phone) => request('POST', '/bookings/release', { code, phone }),
};

const a = (method, path, body) => request(method, path, body, { admin: true });

export const adminApi = {
  login: (password) => request('POST', '/admin/login', { password }),
  overview: () => a('GET', '/admin/overview'),
  bookings: (params) => a('GET', `/admin/bookings${query(params)}`),
  booking: (id) => a('GET', `/admin/bookings/${id}`),
  // payload/patch may carry startMinute (0 or 30) and, after a 409 with code 'buffer' was confirmed, overrideBuffer: true.
  createBooking: (payload) => a('POST', '/admin/bookings', payload),
  updateBooking: (id, patch) => a('PATCH', `/admin/bookings/${id}`, patch),
  schedule: (date) => a('GET', `/admin/schedule${query({ date })}`),
  calendar: (month) => a('GET', `/admin/calendar${query({ month })}`),
  createBlock: (payload) => a('POST', '/admin/blocks', payload),
  deleteBlock: (id) => a('DELETE', `/admin/blocks/${id}`),
  rooms: () => a('GET', '/admin/rooms'),
  createRoom: (payload) => a('POST', '/admin/rooms', payload),
  updateRoom: (id, payload) => a('PUT', `/admin/rooms/${id}`, payload),
  deleteRoom: (id) => a('DELETE', `/admin/rooms/${id}`),
  settings: () => a('GET', '/admin/settings'),
  saveSettings: (payload) => a('PUT', '/admin/settings', payload),
  // Sends a test email to the saved staff address. 409 code 'mail_not_configured' / 'no_recipient', 502 'mail_failed', 429.
  sendTestEmail: () => a('POST', '/admin/settings/test-email', {}),
  content: () => a('GET', '/admin/content'),
  saveContact: (payload) => a('PUT', '/admin/content/contact', payload),
  uploadPhoto: (blob, alt = '') => upload(`/admin/gallery${query({ alt })}`, blob),
  updatePhoto: (id, alt) => a('PATCH', `/admin/gallery/${id}`, { alt }),
  reorderGallery: (ids) => a('PUT', '/admin/gallery/order', { ids }),
  deletePhoto: (id) => a('DELETE', `/admin/gallery/${id}`),
  // GCash payments (staff confirm each one against the GCash app)
  payments: (params) => a('GET', `/admin/payments${query(params)}`),
  confirmPayment: (id, body = {}) => a('POST', `/admin/payments/${id}/confirm`, body),
  paymentNotReceived: (id, body = {}) => a('POST', `/admin/payments/${id}/not-received`, body),
  // Balance of a 50% booking: cash needs no file; GCash needs a screenshot of that payment.
  balancePayment: (id, { method, file, amount, note }) =>
    sendRaw(
      `/admin/payments/${id}/balance`,
      method === 'gcash' ? file : null,
      {
        'X-Balance-Method': method,
        ...(amount ? { 'X-Balance-Amount': String(amount) } : {}),
        ...(note ? { 'X-Note': asciiHeader(note) } : {}),
      },
      { admin: true }
    ),
  recordRefund: (id, body) => a('POST', `/admin/payments/${id}/refund`, body),
  proofImageUrl: (proofId) => adminImageUrl(`/admin/payments/proofs/${proofId}`),
  gcashQr: () => a('GET', '/admin/settings/gcash-qr'),
  saveGcashQr: (payload) => a('PUT', '/admin/settings/gcash-qr', { payload }),
  deleteGcashQr: () => a('DELETE', '/admin/settings/gcash-qr'),
  previewGcashQr: (amount) => a('POST', '/admin/settings/gcash-qr/preview', { amount }),
};
