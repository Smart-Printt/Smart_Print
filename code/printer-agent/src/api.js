'use strict';

// Talks to the SmartPrint backend as a shop staff account. Logs in on start
// and again whenever the short-lived access token has expired (401).

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function createApi({ baseUrl, email, password, fetchImpl = (...args) => fetch(...args) }) {
  let token = null;
  let user = null;

  async function login() {
    const res = await fetchImpl(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, body.message || body.error?.message || 'Login failed');
    }
    token = body.data.token;
    user = body.data.user;
    if (user.role !== 'SHOP_STAFF' || !user.shopId) {
      throw new ApiError(403, 'AGENT_EMAIL must be a shop staff account assigned to a shop');
    }
    return user;
  }

  async function request(method, path, { raw = false, retried = false } = {}) {
    if (!token) await login();
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new ApiError(0, `Cannot reach SmartPrint (${err.message})`);
    }
    if (res.status === 401 && !retried) {
      token = null;
      return request(method, path, { raw, retried: true });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.message || body.error?.message || `HTTP ${res.status}`);
    }
    if (raw) return res;
    const body = await res.json();
    return body.data;
  }

  return {
    login,
    get user() {
      return user;
    },
    async currentJob(shopId) {
      return (await request('GET', `/api/shops/${shopId}/queue/current`)).current;
    },
    // Resolves null when nothing is waiting (404) or something is already
    // printing at this shop (409).
    async startNext(shopId) {
      try {
        return (await request('POST', `/api/shops/${shopId}/queue/start-next`)).queue;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) return null;
        throw err;
      }
    },
    async getOrder(orderId) {
      return (await request('GET', `/api/orders/${orderId}`)).order;
    },
    // Shop staff get the PDF made from Word/Excel/PowerPoint uploads.
    async downloadDocument(documentId) {
      const res = await request('GET', `/api/documents/${documentId}/download`, { raw: true });
      return {
        contentType: res.headers.get('content-type') || '',
        data: Buffer.from(await res.arrayBuffer()),
      };
    },
    async complete(shopId, queueId) {
      return (await request('PATCH', `/api/shops/${shopId}/queue/${queueId}/complete`)).queue;
    },
  };
}

module.exports = { ApiError, createApi };
