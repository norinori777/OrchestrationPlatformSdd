import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  uploadFile,
  deleteFile,
  getFileRequest,
  type FileRequestRecord,
} from '../api/client'

const FILE_UPLOAD_ORCHESTRATION_ID = 'file-upload-and-routing'

const POLL_INTERVAL_MS = 5_000
const MAX_POLL_ATTEMPTS = 12

type RoutingDisplayResult = {
  category: string
  confidence: number
  reason: string
}

const btnStyle = (bg: string): React.CSSProperties => ({
  padding: '8px 20px',
  background: bg,
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
})

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 8,
  boxSizing: 'border-box',
  border: '1px solid #d1d5db',
  borderRadius: 4,
}

function DeleteForm({ onDelete }: { onDelete: (id: string) => void }) {
  const [fileId, setFileId] = useState('')
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={fileId}
        onChange={(e) => setFileId(e.target.value)}
        placeholder="file-id または requestId"
        style={{ ...inputStyle, flex: 1 }}
      />
      <button onClick={() => { if (fileId) onDelete(fileId) }} style={btnStyle('#dc2626')}>
        削除
      </button>
    </div>
  )
}

function parseRoutingResult(record: FileRequestRecord): RoutingDisplayResult | null {
  const parsedResult = record.parsedResult
  if (!parsedResult || typeof parsedResult !== 'object') {
    return null
  }

  const candidate = parsedResult as Record<string, unknown>
  const routingResult = candidate.routingResult
  if (!routingResult || typeof routingResult !== 'object') {
    return null
  }

  const value = routingResult as Record<string, unknown>
  const category = value.category
  const confidence = value.confidence
  const reason = value.reason

  if (typeof category !== 'string' || typeof confidence !== 'number' || typeof reason !== 'string') {
    return null
  }

  return { category, confidence, reason }
}

function formatConfidence(confidence: number): string {
  if (confidence <= 1) {
    return `${Math.round(confidence * 100)}%`
  }
  return confidence.toFixed(2)
}

export default function FilesPage() {
  const navigate = useNavigate()
  const tenantId = sessionStorage.getItem('tenantId') ?? ''
  const userId   = sessionStorage.getItem('userId') ?? ''
  const [results, setResults] = useState<FileRequestRecord[]>([])
  const [error, setError]     = useState('')
  const [pollTick, setPollTick] = useState(0)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const pollingAttemptsRef = useRef<Record<string, number>>({})

  if (!tenantId) {
    navigate('/login')
    return null
  }

  const fileToBase64 = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index] ?? 0)
    }
    return window.btoa(binary)
  }

  const onUpload = async () => {
    if (!selectedFile) {
      setError('アップロードするファイルを選択してください')
      return
    }

    try {
      setIsUploading(true)
      const result = await uploadFile({
        tenantId,
        userId,
        filename: selectedFile.name,
        fileContentBase64: await fileToBase64(selectedFile),
        size: selectedFile.size,
        contentType: selectedFile.type || 'application/octet-stream',
        orchestrationId: FILE_UPLOAD_ORCHESTRATION_ID,
      })
      pollingAttemptsRef.current[result.requestId] = 0
      setResults((prev) => [{ ...result, parsedResult: null }, ...prev])
      setSelectedFile(null)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setIsUploading(false)
    }
  }

  const onDelete = async (fileId: string) => {
    try {
      const result = await deleteFile(fileId, tenantId, userId)
      setResults((prev) => [{ ...result, parsedResult: null }, ...prev])
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    const pollableRequests = results.filter((record) => {
      const attempts = pollingAttemptsRef.current[record.requestId] ?? 0
      return (record.status === 'pending' || record.status === 'processing') && attempts < MAX_POLL_ATTEMPTS
    })

    if (pollableRequests.length === 0) {
      return undefined
    }

    const refreshRequests = async () => {
      await Promise.all(
        pollableRequests.map(async (record) => {
          const requestId = record.requestId
          const attempts = pollingAttemptsRef.current[requestId] ?? 0
          if (attempts >= MAX_POLL_ATTEMPTS) {
            return
          }

          pollingAttemptsRef.current[requestId] = attempts + 1

          try {
            const latest = await getFileRequest(requestId)
            setResults((prev) => prev.map((item) => (item.requestId === requestId ? { ...item, ...latest } : item)))

            if (latest.status !== 'pending' && latest.status !== 'processing') {
              delete pollingAttemptsRef.current[requestId]
            }
          } catch {
            // polling failures are ignored until the retry budget is exhausted
          }
        }),
      )
    }

    const timer = window.setTimeout(async () => {
      await refreshRequests()
      setPollTick((value) => value + 1)
    }, POLL_INTERVAL_MS)

    return () => window.clearTimeout(timer)
  }, [results, pollTick])

  const renderRoutingResult = (record: FileRequestRecord) => {
    const routingResult = parseRoutingResult(record)
    if (!routingResult) {
      return {
        category: '—',
        confidence: '—',
        reason: record.status === 'pending' || record.status === 'processing' ? '振り分け待ち' : '—',
      }
    }

    return {
      category: routingResult.category,
      confidence: formatConfidence(routingResult.confidence),
      reason: routingResult.reason,
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24, fontFamily: 'sans-serif' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>ファイル保管</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#6b7280', fontSize: 13 }}>{tenantId} / {userId}</span>
          <button onClick={() => navigate('/users')} style={btnStyle('#4f46e5')}>ユーザー管理</button>
          <button
            onClick={() => { sessionStorage.clear(); navigate('/login') }}
            style={btnStyle('#6b7280')}
          >
            ログアウト
          </button>
        </div>
      </div>

      {/* ファイル保管フォーム */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void onUpload()
        }}
        style={{ marginBottom: 28, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}
      >
        <h3 style={{ marginTop: 0 }}>ファイルを保管</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>アップロードするファイル</label>
          <input
            type="file"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            style={inputStyle}
          />
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            選択したファイルを SaaS から送信し、Platform 側で保存と振り分けを行います。
          </p>
          {selectedFile && (
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>
              選択中: {selectedFile.name} ({selectedFile.type || 'application/octet-stream'})
            </p>
          )}
        </div>
        <button type="submit" style={btnStyle('#4f46e5')} disabled={isUploading}>
          {isUploading ? '送信中...' : '保管リクエスト送信'}
        </button>
      </form>

      {/* 削除テスト */}
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>削除テスト</h3>
        <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 8px' }}>
          requestId を指定して削除イベントを発行します
        </p>
        <DeleteForm onDelete={onDelete} />
      </div>

      {/* エラー表示 */}
      {error && (
        <p style={{ color: '#dc2626', background: '#fef2f2', padding: 12, borderRadius: 4 }}>{error}</p>
      )}

      {/* 結果一覧 */}
      {results.length > 0 && (
        <div>
          <h3>送信履歴</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>requestId</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>status</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>カテゴリ</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>信頼度</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>理由</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.requestId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.requestId}</td>
                  <td style={{ padding: '8px 12px' }}>{r.status}</td>
                  {(() => {
                    const routingResult = renderRoutingResult(r)
                    return (
                      <>
                        <td style={{ padding: '8px 12px' }}>{routingResult.category}</td>
                        <td style={{ padding: '8px 12px' }}>{routingResult.confidence}</td>
                        <td style={{ padding: '8px 12px', whiteSpace: 'pre-wrap' }}>{routingResult.reason}</td>
                      </>
                    )
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
