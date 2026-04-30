import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import { useNavigate } from 'react-router-dom'
import { uploadFile, deleteFile, type RequestResult } from '../api/client'

const schema = yup.object({
  filename:    yup.string().required('ファイル名は必須です'),
  storagePath: yup.string().required('保管パスは必須です'),
  contentType: yup.string().optional(),
})

type FormData = yup.InferType<typeof schema>

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

export default function FilesPage() {
  const navigate = useNavigate()
  const tenantId = sessionStorage.getItem('tenantId') ?? ''
  const userId   = sessionStorage.getItem('userId') ?? ''
  const [results, setResults] = useState<RequestResult[]>([])
  const [error, setError]     = useState('')

  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormData>({
    resolver: yupResolver(schema),
  })

  if (!tenantId) {
    navigate('/login')
    return null
  }

  const onUpload = async (data: FormData) => {
    try {
      const result = await uploadFile({ tenantId, userId, ...data })
      setResults((prev) => [result, ...prev])
      reset()
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }

  const onDelete = async (fileId: string) => {
    try {
      const result = await deleteFile(fileId, tenantId, userId)
      setResults((prev) => [result, ...prev])
      setError('')
    } catch (e) {
      setError(String(e))
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
        onSubmit={handleSubmit(onUpload)}
        style={{ marginBottom: 28, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}
      >
        <h3 style={{ marginTop: 0 }}>ファイルを保管</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>ファイル名</label>
          <input {...register('filename')} placeholder="report.pdf" style={inputStyle} />
          {errors.filename && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.filename.message}</p>
          )}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>保管パス</label>
          <input {...register('storagePath')} placeholder="/uploads/report.pdf" style={inputStyle} />
          {errors.storagePath && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.storagePath.message}</p>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>Content-Type（任意）</label>
          <input {...register('contentType')} placeholder="application/pdf" style={inputStyle} />
        </div>
        <button type="submit" style={btnStyle('#4f46e5')}>保管リクエスト送信</button>
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
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.requestId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.requestId}</td>
                  <td style={{ padding: '8px 12px' }}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
