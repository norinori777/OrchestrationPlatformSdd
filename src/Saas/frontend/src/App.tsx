import { Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import FilesPage from './pages/FilesPage'
import UsersPage from './pages/UsersPage'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/files" element={<FilesPage />} />
      <Route path="/users" element={<UsersPage />} />
      <Route path="*" element={<Navigate to="/files" replace />} />
    </Routes>
  )
}
