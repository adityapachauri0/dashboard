const API = '/api/v1';

export const getUser = () => JSON.parse(localStorage.getItem('user') || 'null');
export const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
export function logout() {
  localStorage.removeItem('user');
  window.location.href = '/login';
}

export async function api(path, { method = 'GET', body, formData } = {}) {
  const user = getUser();
  const headers = {};
  if (user?.token) headers.Authorization = `Bearer ${user.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) { logout(); throw new Error('session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function download(path, filename) {
  const user = getUser();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${user?.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
