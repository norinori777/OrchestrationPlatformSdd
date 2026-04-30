import { useForm } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import { useNavigate } from 'react-router-dom'

const schema = yup.object({
  tenantId: yup.string().required('テナントIDは必須です'),
  userId:   yup.string().required('ユーザーIDは必須です'),
})

type FormData = yup.InferType<typeof schema>

export default function LoginPage() {
  const navigate = useNavigate()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: yupResolver(schema) })

  const onSubmit = (data: FormData) => {
    sessionStorage.setItem('tenantId', data.tenantId)
    sessionStorage.setItem('userId', data.userId)
    navigate('/files')
  }

  return (
    <div
      style={{
        maxWidth: 400,
        margin: '80px auto',
        padding: 24,
        border: '1px solid #d1d5db',
        borderRadius: 8,
        fontFamily: 'sans-serif',
      }}
    >
      <h2 style={{ marginTop: 0 }}>File Storage SaaS — ログイン</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>テナントID</label>
          <input
            {...register('tenantId')}
            defaultValue="tenant-a"
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 4 }}
          />
          {errors.tenantId && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.tenantId.message}</p>
          )}
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 4 }}>ユーザーID</label>
          <input
            {...register('userId')}
            defaultValue="alice"
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 4 }}
          />
          {errors.userId && (
            <p style={{ color: '#dc2626', margin: '4px 0 0', fontSize: 13 }}>{errors.userId.message}</p>
          )}
        </div>
        <button
          type="submit"
          style={{
            width: '100%',
            padding: 10,
            background: '#4f46e5',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 15,
          }}
        >
          ログイン
        </button>
      </form>
    </div>
  )
}
