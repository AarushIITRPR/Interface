(function exposeSessionApi(global) {
  async function request(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed with status ${response.status}.`);
    }

    return response.json();
  }

  global.SessionAPI = Object.freeze({
    health: () => request('/api/health'),
    loadMediaConfig: () => request('/api/media-config'),
    saveMediaConfig: (config) => request('/api/media-config', {
      method: 'PUT',
      body: JSON.stringify(config)
    }),
    saveSession: (session) => request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(session)
    })
  });
})(window);
