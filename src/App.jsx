import { useState, useEffect, useRef, useId } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import Login from './components/Login'
import Admin from './components/Admin'
import ChatApp from './components/ChatApp'
import BannedScreen from './components/BannedScreen'
import { useAppContext } from './context/AppContext'

export function GtyLogo({ size = 48, wordmark = false }) {
  const logoId = useId().replace(/:/g, '')
  const gradId = `${logoId}-grad`
  const glowId = `${logoId}-glow`

  return (
    <svg
      className={`gty-logo ${wordmark ? 'gty-logo-wordmark' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradId} x1="16" y1="10" x2="86" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="58%" stopColor="var(--accent-dim)" />
          <stop offset="100%" stopColor="var(--sky)" />
        </linearGradient>
        <linearGradient id={glowId} x1="24" y1="24" x2="76" y2="76" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#dff7ff" />
        </linearGradient>
      </defs>
      <rect x="10" y="10" width="80" height="80" rx="24" fill={`url(#${gradId})`} />
      <path d="M66 25H43c-9.9 0-18 7.4-18 16.5S33.1 58 43 58h7.5l13.4 9.6c1.5 1.1 3.6-.2 3.4-2.1L66.4 58C76 57.8 84 50.5 84 41.5 84 32.4 75.9 25 66 25Z" fill="#ffffff" opacity=".32" />
      <path d="M35 32h26c8.3 0 15 6.2 15 13.8s-6.7 13.8-15 13.8h-8.3L39.9 69c-1.7 1.2-4-.2-3.7-2.2l1.1-7.7C30.3 58 25 52.4 25 45.8 25 38.2 31.7 32 35 32Z" fill={`url(#${glowId})`} />
      <path d="M39 43h22M39 52h14" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" opacity=".95" />
      <circle cx="66" cy="52" r="5" fill="var(--sky)" />
      <path d="M19 25c4.1-5.4 9.8-9 16.5-10.4" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity=".26" />
    </svg>
  )
}

export default function App() {
  const { setLang, setTheme, setThemeColor } = useAppContext()
  const [user, setUser]             = useState(undefined)
  const [moderation, setModeration] = useState(null)
  const sessionStart                = useRef(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => {
      if (u) sessionStart.current = Date.now() // reset on every login
      setUser(u)
      if (!u) setModeration(null)
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(doc(db, 'users', user.uid), snap => {
      if (!snap.exists()) return
      const data = snap.data()
      if (data.language) setLang(data.language)
      if (data.theme) setTheme(data.theme)
      if (data.themeColor) setThemeColor(data.themeColor)
      if (data.logoutSignal?.toMillis?.() > sessionStart.current) {
        signOut(auth); return
      }
      const mod = data.moderation
      if (mod) {
        const active = !mod.until || (mod.until?.toMillis?.() ?? 0) > Date.now()
        if (active) { setModeration(mod); return }
      }
      setModeration(null)
    })
    return unsub
  }, [user, setLang, setTheme, setThemeColor])

  if (user === undefined) {
    return (
      <div className="loading-screen">
        <GtyLogo size={64} />
        <div className="loading-bar"><div className="loading-fill" /></div>
      </div>
    )
  }

  if (user && moderation?.type === 'ban') {
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
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/"      element={user ? <ChatApp user={user} moderation={moderation} /> : <Navigate to="/login" />} />
      <Route path="*"      element={<Navigate to="/" />} />
    </Routes>
  )
}
