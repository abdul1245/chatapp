import { useState, useRef, useEffect } from 'react'

export default function Message({ message, isOwn, onDelete }) {
  const [showMenu, setShowMenu] = useState(false)

  const time = message.timestamp
    ? message.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  const type = message.type || 'text'

  return (
    <div
      className={`msg-wrapper ${isOwn ? 'msg-own' : 'msg-other'}`}
      onMouseLeave={() => setShowMenu(false)}
    >
      <div className={`msg-bubble ${isOwn ? 'bubble-sent' : 'bubble-received'}`}>
        {type === 'text' && <span className="msg-text">{message.text}</span>}
        {type === 'image' && <ImageMessage url={message.url} />}
        {type === 'voice' && <VoiceMessage url={message.url} duration={message.duration} />}
        {type === 'document' && (
          <DocumentMessage url={message.url} name={message.fileName} size={message.fileSize} />
        )}

        <div className="msg-meta">
          <span className="msg-time">{time}</span>
          {isOwn && <Ticks status={message.status} />}
        </div>

        {showMenu && (
          <div className="msg-menu">
            <button onClick={() => { onDelete(); setShowMenu(false) }}>
              Delete for me
            </button>
          </div>
        )}
      </div>

      <button className="msg-options" onClick={() => setShowMenu(v => !v)}>▾</button>
    </div>
  )
}

function Ticks({ status }) {
  if (status === 'read')      return <span className="ticks ticks-read"      title="Read">✓✓</span>
  if (status === 'delivered') return <span className="ticks ticks-delivered" title="Delivered">✓✓</span>
  return <span className="ticks ticks-sent" title="Sent">✓</span>
}

function ImageMessage({ url }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <img src={url} className="msg-image" onClick={() => setOpen(true)} alt="Sent image" />
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

function DocumentMessage({ url, name, size }) {
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
        <div className="doc-name">{name || 'Document'}</div>
        {size && <div className="doc-size">{fmtSize(size)}</div>}
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer" className="doc-download" download={name}>
        ↓ Download
      </a>
    </div>
  )
}