const BASE = '/api'

export interface RequestResult {
  requestId: string
  status: string
  result?: string
}

export interface FileRequestRecord extends RequestResult {
  tenantId?: string
  userId?: string
  action?: string
  resource?: string
  payload?: unknown
  parsedResult?: unknown
  createdAt?: string
  updatedAt?: string
}

export async function uploadFile(data: {
  tenantId: string
  userId: string
  filename: string
  fileContentBase64: string
  size?: number
  contentType?: string
  orchestrationId?: string
}): Promise<RequestResult> {
  const res = await fetch(`${BASE}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}

export async function deleteFile(
  fileId: string,
  tenantId: string,
  userId: string,
): Promise<RequestResult> {
  const res = await fetch(`${BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, userId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}

export async function getFileRequest(requestId: string): Promise<FileRequestRecord> {
  const res = await fetch(`${BASE}/files/${encodeURIComponent(requestId)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}

export async function createUser(data: {
  tenantId: string
  userId: string
  email: string
  name: string
  role?: string
}): Promise<RequestResult> {
  const res = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}

export async function deleteUser(
  targetUserId: string,
  tenantId: string,
  userId: string,
): Promise<RequestResult> {
  const res = await fetch(`${BASE}/users/${encodeURIComponent(targetUserId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, userId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}
