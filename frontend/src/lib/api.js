const TOKEN_KEY = 'studio_admin_token';

export class ApiError extends Error {
  constructor(message, { status, fields } = {}) {
    super(message);
    this.status = status;
    this.fields = fields || {};
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
    throw new ApiError(data.error || 'Something went wrong. Try again.', { status: res.status, fields: data.fields });
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
  createBooking: (payload) => request('POST', '/bookings', payload),
  lookupBooking: (code, phone) => request('POST', '/bookings/lookup', { code, phone }),
  cancelBooking: (code, phone) => request('POST', '/bookings/cancel', { code, phone }),
  rescheduleBooking: (code, phone, date, startHour) =>
    request('POST', '/bookings/reschedule', { code, phone, date, startHour }),
};

const a = (method, path, body) => request(method, path, body, { admin: true });

export const adminApi = {
  login: (password) => request('POST', '/admin/login', { password }),
  overview: () => a('GET', '/admin/overview'),
  bookings: (params) => a('GET', `/admin/bookings${query(params)}`),
  booking: (id) => a('GET', `/admin/bookings/${id}`),
  createBooking: (payload) => a('POST', '/admin/bookings', payload),
  updateBooking: (id, patch) => a('PATCH', `/admin/bookings/${id}`, patch),
  schedule: (date) => a('GET', `/admin/schedule${query({ date })}`),
  createBlock: (payload) => a('POST', '/admin/blocks', payload),
  deleteBlock: (id) => a('DELETE', `/admin/blocks/${id}`),
  rooms: () => a('GET', '/admin/rooms'),
  createRoom: (payload) => a('POST', '/admin/rooms', payload),
  updateRoom: (id, payload) => a('PUT', `/admin/rooms/${id}`, payload),
  deleteRoom: (id) => a('DELETE', `/admin/rooms/${id}`),
  settings: () => a('GET', '/admin/settings'),
  saveSettings: (payload) => a('PUT', '/admin/settings', payload),
};
