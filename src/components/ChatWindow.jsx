import { useState, useEffect, useRef } from 'react'
import {
  collection, query, orderBy, onSnapshot,
  addDoc, serverTimestamp, doc, updateDoc, setDoc, getDoc, writeBatch,
} from 'firebase/firestore'
import { db } from '../firebase'
import Message from './Message'

export default function ChatWindow({ chat, currentUser }) {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [contactName, setContactName] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [tempName, setTempName] = useState('')
  const [deletedIds, setDeletedIds] = useState(() => {
    const s = localStorage.getItem(`del_${currentUser.uid}_${chat.id}`)
    return s ? JSON.parse(s) : []
  })
  const bottomRef = useRef(null)

  // Load saved contact name
  useEffect(() => {
    const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
    const name = names[chat.otherId] || chat.otherPhone
    setContactName(name)
    setTempName(name)
  }, [chat.otherId, chat.otherPhone, currentUser.uid])

  // Tell Firestore this user has this chat open
  useEffect(() => {
    setDoc(doc(db, 'status', currentUser.uid), {
      online: true,
      activeChat: chat.id,
      lastSeen: serverTimestamp(),
    })
    return () => {
      // Chat closed — clear activeChat
      setDoc(doc(db, 'status', currentUser.uid), {
        online: true,
        activeChat: null,
        lastSeen: serverTimestamp(),
      })
    }
  }, [chat.id, currentUser.uid])

  // Real-time messages + auto-mark as read
  useEffect(() => {
    const q = query(
      collection(db, 'chats', chat.id, 'messages'),
      orderBy('timestamp', 'asc')
    )
    const unsub = onSnapshot(q, async snap => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))

      // Mark messages sent by the OTHER person as "read"
      const batch = writeBatch(db)
      let hasWork = false
      snap.docs.forEach(d => {
        const data = d.data()
        if (data.senderId !== currentUser.uid && data.status !== 'read') {
          batch.update(doc(db, 'chats', chat.id, 'messages', d.id), { status: 'read' })
          hasWork = true
        }
      })
      if (hasWork) await batch.commit()
    })
    return unsub
  }, [chat.id, currentUser.uid])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!text.trim()) return
    const trimmed = text.trim()
    setText('')

    // Create the message with status "sent"
    const msgRef = await addDoc(collection(db, 'chats', chat.id, 'messages'), {
      senderId: currentUser.uid,
      text: trimmed,
      timestamp: serverTimestamp(),
      status: 'sent',
    })

    // Update chat's lastMessage (shown in sidebar preview)
    await updateDoc(doc(db, 'chats', chat.id), {
      lastMessage: {
        text: trimmed,
        timestamp: serverTimestamp(),
        senderId: currentUser.uid,
      },
    })

    // Check if recipient is currently online or has this chat open
    try {
      const statusSnap = await getDoc(doc(db, 'status', chat.otherId))
      if (statusSnap.exists()) {
        const s = statusSnap.data()
        if (s.online && s.activeChat === chat.id) {
          // Recipient has this chat open — their onSnapshot will mark as "read"
          // We don't need to do anything extra
        } else if (s.online) {
          // Recipient is online but not in this chat → "delivered"
          await updateDoc(
            doc(db, 'chats', chat.id, 'messages', msgRef.id),
            { status: 'delivered' }
          )
        }
        // If offline: stays "sent" until they log in (markDelivered in ChatApp)
      }
    } catch {
      // Non-critical
    }
  }

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const deleteMessage = msgId => {
    const updated = [...deletedIds, msgId]
    setDeletedIds(updated)
    localStorage.setItem(`del_${currentUser.uid}_${chat.id}`, JSON.stringify(updated))
  }

  const saveContactName = () => {
    const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
    names[chat.otherId] = tempName
    localStorage.setItem(`contactNames_${currentUser.uid}`, JSON.stringify(names))
    setContactName(tempName)
    setEditingName(false)
  }

  const visibleMessages = messages.filter(m => !deletedIds.includes(m.id))

  return (
    <div className="chat-window">
      {/* Header */}
      <div className="chat-header">
        <div className="avatar">
          <span>{contactName[0]?.toUpperCase()}</span>
        </div>
        <div className="chat-header-info">
          {editingName ? (
            <div className="name-edit-row">
              <input
                className="name-edit-input"
                value={tempName}
                onChange={e => setTempName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveContactName()}
                autoFocus
              />
              <button className="icon-btn" onClick={saveContactName}>✓</button>
              <button className="icon-btn" onClick={() => setEditingName(false)}>✕</button>
            </div>
          ) : (
            <div
              className="contact-name"
              onClick={() => { setTempName(contactName); setEditingName(true) }}
              title="Click to rename"
            >
              {contactName}
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" style={{ marginLeft: 5, opacity: 0.5 }}>
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </div>
          )}
          <div className="contact-subline">{chat.otherPhone}</div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-area">
        {visibleMessages.length === 0 && (
          <div className="no-messages">Say hello! 👋</div>
        )}
        {visibleMessages.map(msg => (
          <Message
            key={msg.id}
            message={msg}
            isOwn={msg.senderId === currentUser.uid}
            onDelete={() => deleteMessage(msg.id)}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="input-bar">
        <textarea
          className="msg-input"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message"
          rows={1}
        />
        <button
          className="send-btn"
          onClick={sendMessage}
          disabled={!text.trim()}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
            <path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z" />
          </svg>
        </button>
      </div>
    </div>
  )
}