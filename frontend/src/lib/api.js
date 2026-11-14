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
  content: () => a('GET', '/admin/content'),
  saveContact: (payload) => a('PUT', '/admin/content/contact', payload),
  uploadPhoto: (blob, alt = '') => upload(`/admin/gallery${query({ alt })}`, blob),
  updatePhoto: (id, alt) => a('PATCH', `/admin/gallery/${id}`, { alt }),
  reorderGallery: (ids) => a('PUT', '/admin/gallery/order', { ids }),
  deletePhoto: (id) => a('DELETE', `/admin/gallery/${id}`),
};
