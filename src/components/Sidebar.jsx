import { useState, useEffect, useRef } from 'react'
import {
  collection, query, where, onSnapshot,
  doc, getDoc, getDocs, addDoc, serverTimestamp, deleteDoc, writeBatch, updateDoc,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase'
import { GtyLogo } from '../App'
import NewChatModal from './NewChatModal'

export default function Sidebar({ user, selectedChat, onSelectChat, onLogout }) {
  const [chats, setChats]               = useState([])
  const [showModal, setShowModal]       = useState(false)
  const [contactNames, setContactNames] = useState({})
  const [myData, setMyData]             = useState(null)
  const [deletingChat, setDeletingChat] = useState(null)
  const [uploadingPic, setUploadingPic] = useState(false)
  const picInputRef = useRef(null)

  useEffect(() => {
    const stored = localStorage.getItem(`contactNames_${user.uid}`)
    if (stored) setContactNames(JSON.parse(stored))
  }, [user.uid])

  // Listen to own user doc in real-time so avatar updates immediately
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'users', user.uid), snap => {
      if (snap.exists()) setMyData(snap.data())
    })
    return unsub
  }, [user.uid])

  useEffect(() => {
    const q = query(collection(db, 'chats'), where('participants', 'array-contains', user.uid))
    const unsub = onSnapshot(q, async snap => {
      const list = await Promise.all(
        snap.docs.map(async d => {
          const data = d.data()
          const otherId = data.participants.find(p => p !== user.uid)
          const otherSnap = await getDoc(doc(db, 'users', otherId))
          const otherData = otherSnap.exists() ? otherSnap.data() : {}
          return {
            id: d.id,
            ...data,
            otherId,
            otherPhone: otherData.phoneNumber || 'Unknown',
            otherPhoto: otherData.photoURL || null,
          }
        })
      )
      list.sort((a, b) => {
        const ta = a.lastMessage?.timestamp?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0
        const tb = b.lastMessage?.timestamp?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0
        return tb - ta
      })
      setChats(list)
    })
    return unsub
  }, [user.uid])

  // ── Profile picture upload (always changes YOUR OWN picture) ──
  const handlePicChange = async e => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploadingPic(true)
    try {
      const storageRef = ref(storage, `profilePictures/${user.uid}`)
      const snapshot = await uploadBytes(storageRef, file)
      const url = await getDownloadURL(snapshot.ref)
      // Always writes to YOUR OWN uid — not the other person's
      await updateDoc(doc(db, 'users', user.uid), { photoURL: url })
    } catch (err) {
      alert('Profile picture upload failed: ' + err.message)
    } finally {
      setUploadingPic(false)
    }
  }

  const getDisplayName = chat => contactNames[chat.otherId] || chat.otherPhone

  const formatTime = ts => {
    if (!ts) return ''
    const d = ts.toDate()
    const now = new Date()
    if (now - d < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
  }

  const handleCreate = async phone => {
    const trimmed = phone.trim()
    const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', trimmed)))
    if (snap.empty) return { error: 'No user found with that number.' }
    const otherDoc = snap.docs[0]
    const otherId  = otherDoc.id
    if (otherId === user.uid) return { error: "That's your own number!" }
    const existing = chats.find(c => c.otherId === otherId)
    if (existing) { onSelectChat(existing); setShowModal(false); return { success: true } }
    const chatRef = await addDoc(collection(db, 'chats'), {
      participants: [user.uid, otherId],
      createdAt: serverTimestamp(),
      lastMessage: null,
    })
    onSelectChat({
      id: chatRef.id,
      participants: [user.uid, otherId],
      otherId,
      otherPhone: otherDoc.data().phoneNumber,
      lastMessage: null,
    })
    setShowModal(false)
    return { success: true }
  }

  const confirmDeleteChat = async () => {
    if (!deletingChat) return
    try {
      const msgsSnap = await getDocs(collection(db, 'chats', deletingChat.id, 'messages'))
      const batch = writeBatch(db)
      msgsSnap.docs.forEach(m => batch.delete(m.ref))
      await batch.commit()
      await deleteDoc(doc(db, 'chats', deletingChat.id))
      localStorage.removeItem(`del_${user.uid}_${deletingChat.id}`)
      if (selectedChat?.id === deletingChat.id) onSelectChat(null)
      setDeletingChat(null)
    } catch (err) {
      alert('Failed to delete: ' + err.message)
    }
  }

  return (
    <>
      {/* Header */}
      <div className="sidebar-header">
        {/* Your own avatar — click to change profile picture */}
        <div
          className="avatar avatar-sm"
          onClick={() => picInputRef.current?.click()}
          title="Change your profile picture"
          style={{ cursor: 'pointer' }}
        >
          {myData?.photoURL
            ? <img src={myData.photoURL} alt="" />
            : <span>{(myData?.phoneNumber || '?')[0].toUpperCase()}</span>}
          <div className="avatar-edit-overlay">
            {uploadingPic ? '…' : '✎'}
          </div>
        </div>

        {/* Hidden file input — only uploads to user.uid (your own) */}
        <input
          ref={picInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handlePicChange}
        />

        <span className="sidebar-brand">GtyChat</span>

        <div className="sidebar-actions">
          <button className="icon-btn" title="New chat" onClick={() => setShowModal(true)}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21">
              <path d="M19.005 3.175H4.674C3.642 3.175 3 3.789 3 4.821V21.02l3.544-3.514h12.461c1.033 0 2.064-1.06 2.064-2.093V4.821c-.001-1.032-1.032-1.646-2.064-1.646zm-4.989 9.869H13v2.016a.5.5 0 01-1 0v-2.016H9.99a.5.5 0 010-1H12V9.869a.5.5 0 011 0v2.175h2.016a.5.5 0 010 1z" />
            </svg>
          </button>
          <button className="icon-btn" title="Log out" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19">
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
            <GtyLogo size={40} />
            <p>No chats yet.<br />Tap the icon above to start one.</p>
          </div>
        )}
        {chats.map(chat => (
          <div
            key={chat.id}
            className={`chat-row ${selectedChat?.id === chat.id ? 'active' : ''}`}
            onClick={() => onSelectChat(chat)}
          >
            <div className="avatar">
              {chat.otherPhoto
                ? <img src={chat.otherPhoto} alt="" />
                : <span>{getDisplayName(chat)[0]?.toUpperCase()}</span>}
            </div>
            <div className="chat-row-info">
              <div className="chat-row-top">
                <span className="chat-row-name">{getDisplayName(chat)}</span>
                <span className="chat-row-time">{formatTime(chat.lastMessage?.timestamp)}</span>
              </div>
              <div className="chat-row-preview">
                {chat.lastMessage?.type && chat.lastMessage.type !== 'text'
                  ? { image: '📷 Photo', voice: '🎤 Voice message', document: '📎 Document' }[chat.lastMessage.type] || '…'
                  : chat.lastMessage?.text
                    ? chat.lastMessage.text.length > 36
                      ? chat.lastMessage.text.slice(0, 36) + '…'
                      : chat.lastMessage.text
                    : 'No messages yet'}
              </div>
            </div>
            <button
              className="chat-row-delete"
              onClick={e => { e.stopPropagation(); setDeletingChat(chat) }}
              title="Delete chat"
            >🗑</button>
          </div>
        ))}
      </div>

      {showModal && (
        <NewChatModal onClose={() => setShowModal(false)} onCreate={handleCreate} />
      )}

      {deletingChat && (
        <div className="modal-overlay" onClick={() => setDeletingChat(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Chat</h2>
              <button className="icon-btn" onClick={() => setDeletingChat(null)}>✕</button>
            </div>
            <div className="modal-warning">
              ⚠️ This will permanently delete your chat with <strong>{getDisplayName(deletingChat)}</strong> and all messages in it. This cannot be undone.
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeletingChat(null)}>Cancel</button>
              <button className="btn-danger" style={{ width: 'auto' }} onClick={confirmDeleteChat}>Delete forever</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}