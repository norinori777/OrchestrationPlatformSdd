import OrchestrationList from './components/OrchestrationList'
import Login from './components/Login'
import React, { useState } from 'react'

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(localStorage.getItem('admin_token')))
  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif' }}>
      <h1>Orchestration Admin</h1>
      {!authed ? <Login onLogin={() => setAuthed(true)} /> : <OrchestrationList />}
    </div>
  )
}
