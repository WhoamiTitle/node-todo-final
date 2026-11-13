export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function createApi() {
  let token = '';
  async function request(path, method = 'GET', body) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(new URL(`./api/${path}`, location.href), {
        method,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError('network_error');
    }
    if (response.status === 204) return null;
    let result;
    try {
      result = await response.json();
    } catch {
      throw new ApiError('invalid_response', response.status);
    }
    if (!response.ok) throw new ApiError(result.error || 'request_failed', response.status);
    return result;
  }
  return {
    setToken: (value) => {
      token = value;
    },
    author: () => request('author/'),
    list: (runId) => request(`tasks/?runId=${encodeURIComponent(runId)}`),
    create: (title, runId) => request('tasks/', 'POST', { title, runId }),
    update: (id, changes) => request(`tasks/${encodeURIComponent(id)}/`, 'PATCH', changes),
    remove: (id) => request(`tasks/${encodeURIComponent(id)}/`, 'DELETE'),
  };
}
