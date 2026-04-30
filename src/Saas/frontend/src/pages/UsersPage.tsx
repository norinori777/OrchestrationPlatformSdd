import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import { useNavigate } from 'react-router-dom'
import { createUser, deleteUser, type RequestResult } from '../api/client'

const schema = yup.object({
  email: yup.string().email('有効なメールアドレスを入力してください').required('メールは必須です'),
  name:  yup.string().required('名前は必須です'),
  role:  yup.string().oneOf(['admin', 'operator', 'viewer']).default('viewer'),
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

function DeleteUserForm({ onDelete }: { onDelete: (id: string) => void }) {
  const [uid, setUid] = useState('')
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={uid}
        onChange={(e) => setUid(e.target.value)}
        placeholder="user-id"
        style={{ ...inputStyle, flex: 1 }}
      />
      <button onClick={() => { if (uid) onDelete(uid) }} style={btnStyle('#dc2626')}>
        削除
      </button>
    </div>
  )
}

export default function UsersPage() {
  const navigate  = useNavigate()
  const tenantId  = sessionStorage.getItem('tenantId') ?? ''
  const userId    = sessionStorage.getItem('userId') ?? ''
  const [results, setResults] = useState<RequestResult[]>([])
  const [error, setError]     = useState('')

  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormData>({
    resolver: yupResolver(schema),
    defaultValues: { role: 'viewer' },
  })

  if (!tenantId) {
    navigate('/login')
    return null
  }

  const onCreateUser = async (data: FormData) => {
    try {
      const result = await createUser({ tenantId, userId, ...data })
      setResults((prev) => [result, ...prev])
      reset()
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }

  const onDeleteUser = async (targetUserId: string) => {
    try {
      const result = await deleteUser(targetUserId, tenantId, userId)
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
        <h2 style={{ margin: 0 }}>ユーザー管理</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#6b7280', fontSize: 13 }}>{tenantId} / {userId}</span>
          <button onClick={() => navigate('/files')} style={btnStyle('#4f46e5')}>ファイル管理</button>
          <button
            onClick={() => { sessionStorage.clear(); navigate('/login') }}
            style={btnStyle('#6b7280')}
          >
            ログアウト
          </button>
        </div>
      </div>

      {/* ユーザー追加フォーム */}
      <form
        onSubmit={handleSubmit(onCreateUser)}
        style={{ marginBottom: 28, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}
      >
        <h3 style={{ marginTop: 0 }}>ユーザーを追加</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>メールアドレス</label>
          <input {...register('email')} placeholder="user@example.com" style={inputStyle} />
          {errors.email && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.email.message}</p>
          )}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>名前</label>
          <input {...register('name')} placeholder="山田 太郎" style={inputStyle} />
          {errors.name && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.name.message}</p>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>ロール</label>
          <select {...register('role')} style={inputStyle}>
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button type="submit" style={btnStyle('#4f46e5')}>ユーザー追加リクエスト送信</button>
      </form>

      {/* 削除テスト */}
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>削除テスト</h3>
        <DeleteUserForm onDelete={onDeleteUser} />
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
