import { useEffect, useState, useRef } from 'react'
import { useAppContext } from '../context/AppContext'

export default function Message({ message, isOwn, onDelete, onDeleteForEveryone, canDeleteForEveryone }) {
  const { tr } = useAppContext()
  const text = (key, values = {}) =>
    Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, value), tr[key] || '')
  const [showMenu, setShowMenu] = useState(false)
  const [confirmDeleteEveryone, setConfirmDeleteEveryone] = useState(false)
  const closeMenuTimerRef = useRef(null)

  const clearCloseMenuTimer = () => {
    if (!closeMenuTimerRef.current) return
    clearTimeout(closeMenuTimerRef.current)
    closeMenuTimerRef.current = null
  }

  const scheduleCloseMenu = () => {
    clearCloseMenuTimer()
    closeMenuTimerRef.current = setTimeout(() => {
      setShowMenu(false)
      closeMenuTimerRef.current = null
    }, 1500)
  }

  useEffect(() => clearCloseMenuTimer, [])

  const time = message.timestamp
    ? message.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  const type = message.type || 'text'
  const isDeletedForEveryone = Boolean(message.deletedForEveryone)
  const deletedNotice = isOwn
    ? tr.deletedForEveryoneByYou
    : text('deletedForEveryoneByUser', { name: message.deletedForEveryoneByName || tr.thisUser })

  return (
    <div
      className={`msg-wrapper ${isOwn ? 'msg-own' : 'msg-other'}`}
      onMouseEnter={clearCloseMenuTimer}
      onMouseLeave={scheduleCloseMenu}
    >
      <div className={`msg-bubble ${isOwn ? 'bubble-sent' : 'bubble-received'} ${isDeletedForEveryone ? 'bubble-system-deleted' : ''}`}>
        {isDeletedForEveryone ? (
          <span className="msg-deleted-notice">{deletedNotice}</span>
        ) : (
          <>
            {type === 'text' && <span className="msg-text">{message.text}</span>}
            {type === 'call' && <CallMessage message={message} tr={tr} />}
            {type === 'image' && <ImageMessage url={message.url} tr={tr} />}
            {type === 'voice' && <VoiceMessage url={message.url} duration={message.duration} />}
            {type === 'document' && (
              <DocumentMessage url={message.url} name={message.fileName} size={message.fileSize} tr={tr} />
            )}
          </>
        )}

        <div className="msg-meta">
          <span className="msg-time">{time}</span>
          {isOwn && <Ticks status={message.status} tr={tr} />}
        </div>

      </div>

      <button className="msg-options" onClick={() => { clearCloseMenuTimer(); setShowMenu(v => !v) }}>▾</button>
      {showMenu && (
        <div className="msg-menu" onMouseEnter={clearCloseMenuTimer} onMouseLeave={scheduleCloseMenu}>
          <button onClick={() => { clearCloseMenuTimer(); onDelete(); setShowMenu(false) }}>
            {tr.deleteForMe}
          </button>
          {canDeleteForEveryone && (
            <button
              className="msg-menu-danger"
              onClick={() => {
                clearCloseMenuTimer()
                setShowMenu(false)
                setConfirmDeleteEveryone(true)
              }}
            >
              {tr.deleteForEveryone}
            </button>
          )}
        </div>
      )}

      {confirmDeleteEveryone && (
        <div className="profile-confirm-overlay" onClick={() => setConfirmDeleteEveryone(false)}>
          <div className="profile-confirm-card" onClick={e => e.stopPropagation()}>
            <h3>{tr.deleteForEveryoneTitle}</h3>
            <p>{tr.deleteForEveryoneWarn}</p>
            <div className="profile-confirm-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteEveryone(false)}>{tr.cancel}</button>
              <button
                className="btn-danger"
                onClick={() => {
                  onDeleteForEveryone()
                  setConfirmDeleteEveryone(false)
                }}
              >
                {tr.deleteForEveryone}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Ticks({ status, tr }) {
  if (status === 'read')      return <span className="ticks ticks-read"      title={tr.read}>✓✓</span>
  if (status === 'delivered') return <span className="ticks ticks-delivered" title={tr.delivered}>✓✓</span>
  return <span className="ticks ticks-sent" title={tr.sent}>✓</span>
}

function CallMessage({ message, tr }) {
  const isVideo = message.callType === 'video'
  const text = (key, values = {}) =>
    Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, value), tr[key] || '')
  const statusLabel = {
    ringing: tr.callStatusRinging,
    accepted: tr.callStatusAccepted,
    declined: tr.callStatusDeclined,
    canceled: tr.callStatusCanceled,
    unanswered: tr.callStatusUnanswered,
    ended: tr.callStatusAcceptedEnded,
    failed: tr.callStatusFailed,
    left: tr.callStatusEnded,
  }[message.callStatus] || message.callStatus
  const callText = message.callerName || message.receiverName
    ? text('callMessageText', {
      caller: message.callerName || tr.unknownUser,
      receiver: message.receiverName || tr.unknownUser,
      kind: isVideo ? tr.callKindVideo : tr.callKindVoice,
      status: statusLabel,
    })
    : message.text
  return (
    <span className="msg-call">
      <span className="msg-call-icon" aria-hidden="true">
        {isVideo ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M17 10.5V6c0-1.1-.9-2-2-2H5C3.9 4 3 4.9 3 6v12c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-4.5l4 4v-11l-4 4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
          </svg>
        )}
      </span>
      <span className="msg-call-text">{callText}</span>
    </span>
  )
}

function ImageMessage({ url, tr }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <img src={url} className="msg-image" onClick={() => setOpen(true)} alt={tr.sentImage} />
      {open && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, cursor: 'pointer' }}
          onClick={() => setOpen(false)}
        >
          <img src={url} style={{ maxWidth: '92vw', maxHeight: '90vh', borderRadius: 8 }} alt="" />
        </div>
      )}
    </>
  )
}

function VoiceMessage({ url, duration }) {
  const audioRef = useRef(null)
  const [playing, setPlaying]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [current, setCurrent]   = useState(0)
  const [total, setTotal]       = useState(duration || 0)

  const toggle = () => {
    if (!audioRef.current) return
    if (playing) { audioRef.current.pause(); setPlaying(false) }
    else { audioRef.current.play(); setPlaying(true) }
  }

  const fmt = s => {
    if (!s || isNaN(s)) return '0:00'
    const m = Math.floor(s / 60), sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2,'0')}`
  }

  return (
    <div className="msg-voice">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => {
          if (!audioRef.current) return
          setCurrent(audioRef.current.currentTime)
          setProgress(audioRef.current.duration ? (audioRef.current.currentTime / audioRef.current.duration) * 100 : 0)
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) setTotal(audioRef.current.duration)
        }}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrent(0) }}
      />
      <button className="voice-play-btn" onClick={toggle}>
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
        )}
      </button>
      <div className="voice-waveform">
        <div className="voice-waveform-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="voice-duration">{fmt(playing || current > 0 ? current : total)}</span>
    </div>
  )
}

function DocumentMessage({ url, name, size, tr }) {
  const fmtSize = b => {
    if (!b) return ''
    if (b < 1024) return `${b} B`
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`
    return `${(b/1048576).toFixed(1)} MB`
  }
  return (
    <div className="msg-doc">
      <div className="doc-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>
        </svg>
      </div>
      <div className="doc-info">
        <div className="doc-name">{name || tr.documentLabel}</div>
        {size && <div className="doc-size">{fmtSize(size)}</div>}
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer" className="doc-download" download={name}>
        {tr.download}
      </a>
    </div>
  )
}
