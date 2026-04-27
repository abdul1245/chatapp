import { useState } from 'react'

export default function Message({ message, isOwn, onDelete }) {
  const [showMenu, setShowMenu] = useState(false)

  const time = message.timestamp
    ? message.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div
      className={`msg-wrapper ${isOwn ? 'msg-own' : 'msg-other'}`}
      onMouseLeave={() => setShowMenu(false)}
    >
      <div className={`msg-bubble ${isOwn ? 'bubble-sent' : 'bubble-received'}`}>
        <span className="msg-text">{message.text}</span>
        <div className="msg-meta">
          <span className="msg-time">{time}</span>
          {isOwn && <Ticks status={message.status} />}
        </div>

        {showMenu && (
          <div className="msg-menu">
            <button
              onClick={() => { onDelete(); setShowMenu(false) }}
            >
              Delete for me
            </button>
          </div>
        )}
      </div>

      <button
        className="msg-options"
        onClick={() => setShowMenu(v => !v)}
        title="Options"
      >
        ▾
      </button>
    </div>
  )
}

function Ticks({ status }) {
  // Single gray tick = sent
  // Double gray tick = delivered
  // Double blue tick = read
  if (status === 'read') {
    return <span className="ticks ticks-read" title="Read">✓✓</span>
  }
  if (status === 'delivered') {
    return <span className="ticks ticks-delivered" title="Delivered">✓✓</span>
  }
  return <span className="ticks ticks-sent" title="Sent">✓</span>
}