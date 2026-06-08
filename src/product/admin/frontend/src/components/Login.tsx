import React, { useState } from 'react'
import { login } from '../api'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState('admin')
  const [pass, setPass] = useState('password')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      const res = await login(user, pass)
      localStorage.setItem('admin_token', res.token)
      onLogin()
    } catch (err) {
      alert('Login failed')
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 12 }}>
      <label>Username: <input value={user} onChange={e => setUser(e.target.value)} /></label>
      <label style={{ marginLeft: 8 }}>Password: <input type="password" value={pass} onChange={e => setPass(e.target.value)} /></label>
      <button style={{ marginLeft: 8 }} type="submit">Login</button>
    </form>
  )
}
