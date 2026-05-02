import { useEffect, useState } from 'react'
import { GtyLogo } from '../App'
import { useAppContext } from '../context/AppContext'

export default function BannedScreen({ moderation, onExpire, onLogout }) {
  const { tr } = useAppContext()
  const [timeLeft, setTimeLeft] = useState(null)

  useEffect(() => {
    if (!moderation.until) return // permanent ban — no countdown

    const tick = () => {
      const left = moderation.until.toMillis() - Date.now()
      if (left <= 0) { onExpire(); return }
      setTimeLeft(left)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [moderation.until, onExpire])

  const fmt = ms => {
    if (!ms) return null
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  const isBan = moderation.type === 'ban'

  return (
    <div className="banned-screen">
      <div className="banned-card">
        <GtyLogo size={56} />
        <div className="banned-icon">{isBan ? '🚫' : '⏳'}</div>
        <div className="banned-title">
          {isBan ? tr.bannedTitle : tr.timedOutTitle}
        </div>
        <div className="banned-desc">
          {moderation.reason
            ? <>{tr.reason}: <strong>{moderation.reason}</strong><br /></>
            : null}
          {isBan && !moderation.until
            ? tr.permanentBan
            : isBan
            ? tr.banTimer
            : tr.timeoutDesc}
        </div>

        {moderation.until && timeLeft !== null && (
          <div className="banned-countdown">{fmt(timeLeft)}</div>
        )}

        <button className="btn-secondary banned-logout" onClick={onLogout}>
          {tr.logout}
        </button>
      </div>
    </div>
  )
}
