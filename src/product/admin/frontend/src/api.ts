import axios from 'axios';

// Vite exposes env vars via import.meta.env. Support `VITE_ADMIN_API_URL`,
// otherwise default to localhost:4006 which the admin API is currently running on.
const base = (import.meta as any).env?.VITE_ADMIN_API_URL ?? 'http://localhost:4006';

function client() {
  const token = localStorage.getItem('admin_token');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return axios.create({ baseURL: base, headers });
}

export const listOrchestrations = async (page = 0, perPage = 10) => {
  const res = await client().get(`/orchestrations`, { params: { page, perPage } });
  return res.data as { total: number; items: any[] };
}

export const getOrchestration = async (id: string) => {
  const res = await client().get(`/orchestrations/${encodeURIComponent(id)}`);
  return res.data;
}

export const listVersions = async (id: string) => {
  const res = await client().get(`/orchestrations/${encodeURIComponent(id)}/versions`);
  return res.data;
}

export const getVersion = async (id: string, vid: string) => {
  const res = await client().get(`/orchestrations/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}`);
  return res.data;
}

export const restoreVersion = async (id: string, vid: string) => {
  const res = await client().post(`/orchestrations/${encodeURIComponent(id)}/restore/${encodeURIComponent(vid)}`);
  return res.data;
}

export const upsertOrchestration = async (id: string, payload: any) => {
  const res = await client().post(`/orchestrations/${encodeURIComponent(id)}`, payload);
  return res.data;
}

export const deleteOrchestration = async (id: string) => {
  const res = await client().delete(`/orchestrations/${encodeURIComponent(id)}`);
  return res.status === 204;
}

export const login = async (username: string, password: string) => {
  const res = await axios.post(`${base}/login`, { username, password });
  return res.data;
}
