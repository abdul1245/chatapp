import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'
import Login from './components/Login'
import Admin from './components/Admin'
import ChatApp from './components/ChatApp'

export default function App() {
  const [user, setUser] = useState(undefined) // undefined = still loading

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => setUser(u))
    return unsub
  }, [])

  if (user === undefined) {
    return (
      <div className="loading-screen">
        <div className="loading-logo">💬</div>
        <div className="loading-bar"><div className="loading-fill" /></div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/" element={user ? <ChatApp user={user} /> : <Navigate to="/login" />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}