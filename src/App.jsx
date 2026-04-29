import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import Login from './components/Login'
import Admin from './components/Admin'
import ChatApp from './components/ChatApp'
import BannedScreen from './components/BannedScreen'

// The GtyChat logo as a reusable component
export function GtyLogo({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gty-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      {/* Hexagon */}
      <polygon
        points="50,4 93,27 93,73 50,96 7,73 7,27"
        fill="none"
        stroke="url(#gty-grad)"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      {/* Inner glow ring */}
      <polygon
        points="50,14 85,33 85,67 50,86 15,67 15,33"
        fill="rgba(139,92,246,0.07)"
        stroke="rgba(139,92,246,0.15)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* G letter */}
      <text
        x="51"
        y="68"
        textAnchor="middle"
        fontSize="46"
        fontFamily="Syne, sans-serif"
        fontWeight="800"
        fill="url(#gty-grad)"
      >
        G
      </text>
    </svg>
  )
}

export default function App() {
  const [user, setUser] = useState(undefined)
  const [moderation, setModeration] = useState(null)
  const sessionStart = useRef(Date.now())

 useEffect(() => {
  const unsub = onAuthStateChanged(auth, u => {
    if (u) {
      // Reset session clock to NOW so any old logoutSignal won't trigger
      sessionStart.current = Date.now()
    }
    setUser(u)
    if (!u) setModeration(null)
  })
  return unsub
}, [])

  // Listen to user doc for bans, timeouts, and forced logouts
  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(doc(db, 'users', user.uid), snap => {
      if (!snap.exists()) return
      const data = snap.data()

      // Force logout if admin changed credentials
      if (data.logoutSignal?.toMillis?.() > sessionStart.current) {
        signOut(auth)
        return
      }

      // Check moderation
      const mod = data.moderation
      if (mod) {
        const isActive = !mod.until || mod.until.toMillis() > Date.now()
        if (isActive) { setModeration(mod); return }
      }
      setModeration(null)
    })
    return unsub
  }, [user])

  if (user === undefined) {
    return (
      <div className="loading-screen">
        <GtyLogo size={64} />
        <div className="loading-bar"><div className="loading-fill" /></div>
      </div>
    )
  }

  if (user && moderation) {
    return (
      <BannedScreen
        moderation={moderation}
        onExpire={() => setModeration(null)}
        onLogout={() => signOut(auth)}
      />
    )
  }

  return (
    <Routes>
      <Route path="/login"  element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/admin"  element={<Admin />} />
      <Route path="/"       element={user ? <ChatApp user={user} /> : <Navigate to="/login" />} />
      <Route path="*"       element={<Navigate to="/" />} />
    </Routes>
  )
}