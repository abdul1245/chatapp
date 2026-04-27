import { useState, useEffect } from 'react'
import {
  collection, query, where, onSnapshot,
  doc, getDoc, getDocs, addDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase'
import NewChatModal from './NewChatModal'

export default function Sidebar({ user, selectedChat, onSelectChat, onLogout }) {
  const [chats, setChats] = useState([])
  const [showModal, setShowModal] = useState(false)
  const [contactNames, setContactNames] = useState({})
  const [myPhone, setMyPhone] = useState('')

  // Load contact names from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`contactNames_${user.uid}`)
    if (stored) setContactNames(JSON.parse(stored))
  }, [user.uid])

  // Load current user's phone number for the header
  useEffect(() => {
    getDoc(doc(db, 'users', user.uid)).then(snap => {
      if (snap.exists()) setMyPhone(snap.data().phoneNumber)
    })
  }, [user.uid])

  // Real-time listener on all chats this user is in
  useEffect(() => {
    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', user.uid)
    )
    const unsub = onSnapshot(q, async snap => {
      const list = await Promise.all(
        snap.docs.map(async d => {
          const data = d.data()
          const otherId = data.participants.find(p => p !== user.uid)
          const otherSnap = await getDoc(doc(db, 'users', otherId))
          const otherPhone = otherSnap.exists() ? otherSnap.data().phoneNumber : 'Unknown'
          return { id: d.id, ...data, otherId, otherPhone }
        })
      )
      // Sort newest first
      list.sort((a, b) => {
        const ta = a.lastMessage?.timestamp?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0
        const tb = b.lastMessage?.timestamp?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0
        return tb - ta
      })
      setChats(list)
    })
    return unsub
  }, [user.uid])

  const getDisplayName = chat =>
    contactNames[chat.otherId] || chat.otherPhone

  const handleCreate = async phone => {
    const trimmed = phone.trim()
    // Look up the user by phone number
    const snap = await getDocs(
      query(collection(db, 'users'), where('phoneNumber', '==', trimmed))
    )
    if (snap.empty) return { error: 'No user found with that number.' }

    const otherDoc = snap.docs[0]
    const otherId = otherDoc.id

    if (otherId === user.uid) return { error: "That's your own number!" }

    // Check for existing chat
    const existing = chats.find(c => c.otherId === otherId)
    if (existing) {
      onSelectChat(existing)
      setShowModal(false)
      return { success: true }
    }

    // Create new chat document
    const ref = await addDoc(collection(db, 'chats'), {
      participants: [user.uid, otherId],
      createdAt: serverTimestamp(),
      lastMessage: null,
    })

    // Select it immediately
    onSelectChat({
      id: ref.id,
      participants: [user.uid, otherId],
      otherId,
      otherPhone: otherDoc.data().phoneNumber,
      lastMessage: null,
    })
    setShowModal(false)
    return { success: true }
  }

  const formatTime = ts => {
    if (!ts) return ''
    const d = ts.toDate()
    const now = new Date()
    if (now - d < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
  }

  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="avatar avatar-sm">
          <span>{myPhone?.[0] ?? '?'}</span>
        </div>
        <span className="sidebar-my-number">{myPhone}</span>
        <div className="sidebar-actions">
          <button
            className="icon-btn"
            title="New chat"
            onClick={() => setShowModal(true)}
          >
            {/* New chat icon */}
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M19.005 3.175H4.674C3.642 3.175 3 3.789 3 4.821V21.02l3.544-3.514h12.461c1.033 0 2.064-1.06 2.064-2.093V4.821c-.001-1.032-1.032-1.646-2.064-1.646zm-4.989 9.869H13v2.016a.5.5 0 01-1 0v-2.016H9.99a.5.5 0 010-1H12V9.869a.5.5 0 011 0v2.175h2.016a.5.5 0 010 1z" />
            </svg>
          </button>
          <button className="icon-btn" title="Log out" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M16 13v-2H7V8l-5 4 5 4v-3z" />
              <path d="M20 3h-9c-1.1 0-2 .9-2 2v4h2V5h9v14h-9v-4H9v4c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chat list */}
      <div className="chats-list">
        {chats.length === 0 && (
          <div className="sidebar-empty">
            <p>No chats yet.</p>
            <p>Click the icon above to start one!</p>
          </div>
        )}
        {chats.map(chat => (
          <div
            key={chat.id}
            className={`chat-row ${selectedChat?.id === chat.id ? 'active' : ''}`}
            onClick={() => onSelectChat(chat)}
          >
            <div className="avatar">
              <span>{getDisplayName(chat)[0]?.toUpperCase()}</span>
            </div>
            <div className="chat-row-info">
              <div className="chat-row-top">
                <span className="chat-row-name">{getDisplayName(chat)}</span>
                <span className="chat-row-time">
                  {formatTime(chat.lastMessage?.timestamp)}
                </span>
              </div>
              <div className="chat-row-preview">
                {chat.lastMessage?.text
                  ? chat.lastMessage.text.length > 38
                    ? chat.lastMessage.text.slice(0, 38) + '…'
                    : chat.lastMessage.text
                  : 'No messages yet'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <NewChatModal onClose={() => setShowModal(false)} onCreate={handleCreate} />
      )}
    </div>
  )
}