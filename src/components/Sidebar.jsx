import { useState, useEffect, useRef } from 'react'
import {
  collection, query, where, onSnapshot,
  doc, getDoc, getDocs, addDoc, serverTimestamp, updateDoc,
  arrayUnion, arrayRemove, writeBatch,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase'
import { useAppContext } from '../context/AppContext'
import NewChatModal from './NewChatModal'
import { buildDisplayName } from '../profile'

const getStoredContactNames = uid => {
  try {
    return JSON.parse(localStorage.getItem(`contactNames_${uid}`) || '{}')
  } catch {
    return {}
  }
}

const getStoredHiddenChats = uid => {
  try {
    return JSON.parse(localStorage.getItem(`hiddenChats_${uid}`) || '[]')
  } catch {
    return []
  }
}

const chatIsHiddenForUser = (chat, uid, localHiddenIds) => {
  return localHiddenIds.includes(chat.id) || chat.hiddenFor?.includes(uid)
}

const deleteChatWithMessages = async chatId => {
  const messagesSnap = await getDocs(collection(db, 'chats', chatId, 'messages'))
  let batch = writeBatch(db)
  let pendingWrites = 0

  const commitIfNeeded = async force => {
    if (!pendingWrites || (!force && pendingWrites < 450)) return
    await batch.commit()
    batch = writeBatch(db)
    pendingWrites = 0
  }

  for (const messageDoc of messagesSnap.docs) {
    batch.delete(messageDoc.ref)
    pendingWrites += 1
    await commitIfNeeded(false)
  }

  batch.delete(doc(db, 'chats', chatId))
  pendingWrites += 1
  await commitIfNeeded(true)
}

export default function Sidebar({ user, selectedChat, onSelectChat, onLogout, onSettings }) {
  const { tr } = useAppContext()
  const [chats, setChats]               = useState([])
  const [showModal, setShowModal]       = useState(false)
  const [contactNames, setContactNames] = useState(() => getStoredContactNames(user.uid))
  const [myData, setMyData]             = useState(null)
  const [deletingChat, setDeletingChat] = useState(null)
  const [hiddenChats, setHiddenChats] = useState(() => getStoredHiddenChats(user.uid))
  const [uploadingPic, setUploadingPic] = useState(false)
  const picInputRef = useRef(null)
  const chatLoadSeqRef = useRef(0)

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
      const seq = ++chatLoadSeqRef.current
      const localHiddenIds = getStoredHiddenChats(user.uid)
      const rawChats = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      const visibleRawChats = rawChats.filter(chat => !chatIsHiddenForUser(chat, user.uid, localHiddenIds))
      const visibleIds = new Set(visibleRawChats.map(chat => chat.id))
      setChats(prev => prev.filter(chat => visibleIds.has(chat.id)))

      if (selectedChat?.id && !visibleRawChats.some(chat => chat.id === selectedChat.id)) {
        onSelectChat(null)
      }

      const list = await Promise.all(
        visibleRawChats.map(async data => {
          const otherId = data.participants.find(p => p !== user.uid)
          const otherSnap = await getDoc(doc(db, 'users', otherId))
          const otherData = otherSnap.exists() ? otherSnap.data() : {}
          return {
            ...data,
            otherId,
            otherName: buildDisplayName(otherData),
            otherPhone: otherData.phoneNumber || tr.unknown,
            otherPhoto: otherData.photoURL || null,
          }
        })
      )
      if (seq !== chatLoadSeqRef.current) return
      list.sort((a, b) => {
        const ta = a.lastMessage?.timestamp?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0
        const tb = b.lastMessage?.timestamp?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0
        return tb - ta
      })
      setChats(list)
    })
    return unsub
  }, [onSelectChat, selectedChat?.id, user.uid, tr.unknown])

  useEffect(() => {
    if (!hiddenChats.length) return
    hiddenChats.forEach(chatId => {
      updateDoc(doc(db, 'chats', chatId), { hiddenFor: arrayUnion(user.uid) }).catch(() => {})
    })
  }, [hiddenChats, user.uid])

  useEffect(() => {
    const refreshContactNames = () => setContactNames(getStoredContactNames(user.uid))
    window.addEventListener('contactNamesChanged', refreshContactNames)
    window.addEventListener('storage', refreshContactNames)
    return () => {
      window.removeEventListener('contactNamesChanged', refreshContactNames)
      window.removeEventListener('storage', refreshContactNames)
    }
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
      alert(`${tr.profilePictureUploadFailed}: ${err.message}`)
    } finally {
      setUploadingPic(false)
    }
  }

  const getDisplayName = chat => contactNames[chat.otherId] || chat.otherName || chat.otherPhone

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
    if (snap.empty) return { error: tr.noUserFoundWithNumber }
    const otherDoc = snap.docs[0]
    const otherId  = otherDoc.id
    if (otherId === user.uid) return { error: tr.ownNumberError }
    const existingSnap = await getDocs(query(collection(db, 'chats'), where('participants', 'array-contains', user.uid)))
    const existingDoc = existingSnap.docs.find(d => d.data().participants?.includes(otherId))
    if (existingDoc) {
      const data = existingDoc.data()
      if (chatIsHiddenForUser({ id: existingDoc.id, ...data }, user.uid, hiddenChats)) {
        await updateDoc(doc(db, 'chats', existingDoc.id), { hiddenFor: arrayRemove(user.uid) })
        const nextHidden = hiddenChats.filter(id => id !== existingDoc.id)
        setHiddenChats(nextHidden)
        localStorage.setItem(`hiddenChats_${user.uid}`, JSON.stringify(nextHidden))
      }
      onSelectChat({
        id: existingDoc.id,
        ...data,
        otherId,
        otherName: buildDisplayName(otherDoc.data()),
        otherPhone: otherDoc.data().phoneNumber,
        otherPhoto: otherDoc.data().photoURL || null,
      })
      setShowModal(false)
      return { success: true }
    }
    const chatRef = await addDoc(collection(db, 'chats'), {
      participants: [user.uid, otherId],
      hiddenFor: [otherId],
      createdAt: serverTimestamp(),
      lastMessage: null,
    })
    onSelectChat({
      id: chatRef.id,
      participants: [user.uid, otherId],
      otherId,
      otherName: buildDisplayName(otherDoc.data()),
      otherPhone: otherDoc.data().phoneNumber,
      lastMessage: null,
    })
    setShowModal(false)
    return { success: true }
  }

  const confirmDeleteChat = async () => {
    if (!deletingChat) return
    const chatToDelete = deletingChat
    try {
      await deleteChatWithMessages(chatToDelete.id)
      const nextHidden = hiddenChats.filter(id => id !== chatToDelete.id)
      setHiddenChats(nextHidden)
      setChats(prev => prev.filter(chat => chat.id !== chatToDelete.id))
      localStorage.setItem(`hiddenChats_${user.uid}`, JSON.stringify(nextHidden))
      localStorage.removeItem(`del_${user.uid}_${chatToDelete.id}`)
      if (selectedChat?.id === chatToDelete.id) onSelectChat(null)
      setDeletingChat(null)
    } catch (err) {
      alert(`${tr.deleteChat}: ${err.message}`)
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
          title={tr.changeProfilePicture}
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
  <button className="icon-btn" title={tr.settings} onClick={onSettings}>
    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.01 7.01 0 00-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
    </svg>
  </button>
  <button className="icon-btn" title={tr.newChat} onClick={() => setShowModal(true)}>
    <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21">
      <path d="M19.005 3.175H4.674C3.642 3.175 3 3.789 3 4.821V21.02l3.544-3.514h12.461c1.033 0 2.064-1.06 2.064-2.093V4.821c-.001-1.032-1.032-1.646-2.064-1.646zm-4.989 9.869H13v2.016a.5.5 0 01-1 0v-2.016H9.99a.5.5 0 010-1H12V9.869a.5.5 0 011 0v2.175h2.016a.5.5 0 010 1z" />
    </svg>
  </button>
  <button className="icon-btn" title={tr.logout} onClick={onLogout}>
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
            <p>{tr.noChats}<br />{tr.tapIconStartChat}</p>
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
                  ? { image: tr.photo, voice: tr.voiceMessage, document: tr.document }[chat.lastMessage.type] || '...'
                  : chat.lastMessage?.text
                    ? chat.lastMessage.text.length > 36
                      ? chat.lastMessage.text.slice(0, 36) + '...'
                      : chat.lastMessage.text
                    : tr.noMessagesYet}
              </div>
            </div>
            <button
              className="chat-row-delete"
              onClick={e => { e.stopPropagation(); setDeletingChat(chat) }}
              title={tr.deleteChat}
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
              <h2>{tr.deleteChat}</h2>
              <button className="icon-btn" onClick={() => setDeletingChat(null)}>✕</button>
            </div>
            <div className="modal-warning">
              {tr.deleteChatConfirm.replace('{name}', getDisplayName(deletingChat))}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeletingChat(null)}>{tr.cancel}</button>
              <button className="btn-danger" style={{ width: 'auto' }} onClick={confirmDeleteChat}>{tr.deleteForever}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
