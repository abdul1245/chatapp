import { useState, useEffect, useMemo, useRef } from 'react'
import {
  collection, query, orderBy, onSnapshot,
  addDoc, serverTimestamp, doc, updateDoc, setDoc, getDoc, writeBatch,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase'
import Message from './Message'
import { useAppContext } from '../context/AppContext'
import { buildDisplayName } from '../profile'

export default function ChatWindow({ chat, currentUser, moderation, onBack }) {
  const { tr } = useAppContext()
  const [messages, setMessages]       = useState([])
  const [text, setText]               = useState('')
  const [editingName, setEditingName] = useState(false)
  const [otherProfile, setOtherProfile] = useState(null)
  const suggestedContactName = useMemo(() => {
    return buildDisplayName(otherProfile) || chat.otherName || chat.otherPhone
  }, [chat.otherName, chat.otherPhone, otherProfile])
  const initialContactName = useMemo(() => {
    try {
      const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
      return String(names[chat.otherId] || '').trim() || suggestedContactName
    } catch {
      return suggestedContactName
    }
  }, [chat.otherId, currentUser.uid, suggestedContactName])
  const [contactName, setContactName] = useState(initialContactName)
  const [tempName, setTempName]       = useState(initialContactName)
  const [otherPhoto, setOtherPhoto]   = useState(null)
  const [uploading, setUploading]     = useState(false)
  const [recording, setRecording]     = useState(false)
  const [recTime, setRecTime]         = useState(0)
  const [deletedIds, setDeletedIds]   = useState(() => {
    const s = localStorage.getItem(`del_${currentUser.uid}_${chat.id}`)
    return s ? JSON.parse(s) : []
  })

  const bottomRef    = useRef(null)
  const fileInputRef = useRef(null)
  const mediaRecRef  = useRef(null)
  const timerRef     = useRef(null)
  const chunksRef    = useRef([])
  const isTimedOut = moderation?.type === 'timeout'

  useEffect(() => {
    setContactName(initialContactName)
    setTempName(initialContactName)
  }, [initialContactName])

  // Load contact profile
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'users', chat.otherId), snap => {
      const data = snap.exists() ? snap.data() : null
      setOtherProfile(data)
      setOtherPhoto(data?.photoURL || null)
    })
    return unsub
  }, [chat.otherId])

  // Mark this chat as open in the status doc
  useEffect(() => {
    setDoc(doc(db, 'status', currentUser.uid), {
      online: true,
      activeChat: chat.id,
      lastSeen: serverTimestamp(),
    })
    return () => {
      setDoc(doc(db, 'status', currentUser.uid), {
        online: true,
        activeChat: null,
        lastSeen: serverTimestamp(),
      })
    }
  }, [chat.id, currentUser.uid])

  // Real-time messages + mark as read
  useEffect(() => {
    const q = query(collection(db, 'chats', chat.id, 'messages'), orderBy('timestamp', 'asc'))
    const unsub = onSnapshot(q, async snap => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      const batch = writeBatch(db)
      let hasWork = false
      snap.docs.forEach(d => {
        if (d.data().senderId !== currentUser.uid && d.data().status !== 'read') {
          batch.update(doc(db, 'chats', chat.id, 'messages', d.id), { status: 'read' })
          hasWork = true
        }
      })
      if (hasWork) await batch.commit()
    })
    return unsub
  }, [chat.id, currentUser.uid])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Send text message
  const sendMessage = async () => {
    if (isTimedOut) return
    if (!text.trim()) return
    const trimmed = text.trim()
    setText('')
    const msgRef = await addDoc(collection(db, 'chats', chat.id, 'messages'), {
      senderId: currentUser.uid,
      type: 'text',
      text: trimmed,
      timestamp: serverTimestamp(),
      status: 'sent',
    })
    await updateDoc(doc(db, 'chats', chat.id), {
      lastMessage: { text: trimmed, type: 'text', timestamp: serverTimestamp(), senderId: currentUser.uid },
    })
    upgradeStatus(msgRef.id)
  }

  const upgradeStatus = async msgId => {
    try {
      const statusSnap = await getDoc(doc(db, 'status', chat.otherId))
      if (statusSnap.exists()) {
        const s = statusSnap.data()
        if (s.online && s.activeChat !== chat.id) {
          await updateDoc(doc(db, 'chats', chat.id, 'messages', msgId), { status: 'delivered' })
        }
      }
    } catch { /* non-critical */ }
  }

  // Send file (image or document)
  const handleFileChange = async e => {
  if (isTimedOut) return
  const file = e.target.files?.[0]
  if (!file) return
  e.target.value = ''

  const isImage = file.type.startsWith('image/')
  const type = isImage ? 'image' : 'document'

  setUploading(true)
  try {
    const storageRef = ref(storage, `chatFiles/${chat.id}/${Date.now()}_${file.name}`)

    const snapshot = await uploadBytes(storageRef, file)

    const url = await getDownloadURL(snapshot.ref)

    if (!url) throw new Error(tr.uploadFailed)

    const msgRef = await addDoc(collection(db, 'chats', chat.id, 'messages'), {
      senderId: currentUser.uid,
      type,
      url,
      fileName: file.name,
      fileSize: file.size,
      timestamp: serverTimestamp(),
      status: 'sent',
    })
    await updateDoc(doc(db, 'chats', chat.id), {
      lastMessage: { type, timestamp: serverTimestamp(), senderId: currentUser.uid },
    })
    upgradeStatus(msgRef.id)
  } catch (err) {
    console.error('File upload error:', err)
    alert(`${tr.uploadFailed}: ${err.message}`)
  } finally {
    setUploading(false)
  }
}

  // Voice recording
  const startRecording = async () => {
    if (isTimedOut) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = e => chunksRef.current.push(e.data)
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        await uploadVoice(blob, recTime)
        setRecTime(0)
      }
      mr.start()
      mediaRecRef.current = mr
      setRecording(true)
      timerRef.current = setInterval(() => setRecTime(t => t + 1), 1000)
    } catch {
      alert(tr.microphonePermissionDenied)
    }
  }

  const stopRecording = () => {
    if (mediaRecRef.current) {
      mediaRecRef.current.stop()
      mediaRecRef.current = null
      clearInterval(timerRef.current)
      setRecording(false)
    }
  }

  const uploadVoice = async (blob, duration) => {
  setUploading(true)
  try {
    const storageRef = ref(storage, `chatFiles/${chat.id}/${Date.now()}_voice.webm`)
    const snapshot = await uploadBytes(storageRef, blob)
    const url = await getDownloadURL(snapshot.ref)

    if (!url) throw new Error(tr.voiceUploadFailed)

    const msgRef = await addDoc(collection(db, 'chats', chat.id, 'messages'), {
      senderId: currentUser.uid,
      type: 'voice',
      url,
      duration,
      timestamp: serverTimestamp(),
      status: 'sent',
    })
    await updateDoc(doc(db, 'chats', chat.id), {
      lastMessage: { type: 'voice', timestamp: serverTimestamp(), senderId: currentUser.uid },
    })
    upgradeStatus(msgRef.id)
  } catch (err) {
    console.error('Voice upload error:', err)
    alert(`${tr.voiceUploadFailed}: ${err.message}`)
  } finally {
    setUploading(false)
  }
}

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isTimedOut) sendMessage() }
  }

  const deleteMessage = msgId => {
    const updated = [...deletedIds, msgId]
    setDeletedIds(updated)
    localStorage.setItem(`del_${currentUser.uid}_${chat.id}`, JSON.stringify(updated))
  }

  const saveContactName = () => {
    const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
    const trimmedName = tempName.trim()
    if (trimmedName) {
      names[chat.otherId] = trimmedName
    } else {
      delete names[chat.otherId]
    }
    localStorage.setItem(`contactNames_${currentUser.uid}`, JSON.stringify(names))
    window.dispatchEvent(new Event('contactNamesChanged'))
    setContactName(trimmedName || suggestedContactName)
    setTempName(trimmedName || suggestedContactName)
    setEditingName(false)
  }

  const visibleMessages = messages.filter(m => !deletedIds.includes(m.id))
  const fmtRec = s => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`

  return (
    <div className="chat-window">
      {/* Header */}
      <div className="chat-header">
        <button className="icon-btn chat-header-back" onClick={onBack} title={tr.backTitle}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>

        <div className="avatar" onClick={() => {}} title={tr.theirProfile}>
          {otherPhoto
            ? <img src={otherPhoto} alt="" />
            : <span>{contactName[0]?.toUpperCase()}</span>}
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
              title={tr.clickToRename}
            >
              {contactName}
              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" opacity="0.4">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </div>
          )}
          <div className="contact-subline">{chat.otherPhone}</div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-area" style={{ position: 'relative' }}>
        {uploading && <div className="uploading-bar">{tr.uploading}</div>}
        {visibleMessages.length === 0 && (
          <div className="no-messages">{tr.noMessages}</div>
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
        {isTimedOut && (
          <div className="timeout-compose-notice">
            {tr.timedOutComposeNotice}
          </div>
        )}
        {recording ? (
          <>
            <div className="recording-bar">
              <div className="rec-dot" />
              <span className="rec-timer">{fmtRec(recTime)}</span>
              <span className="rec-label">{tr.recording}</span>
            </div>
            <button className="icon-btn" title={tr.stopAndSend} onClick={stopRecording}
              style={{ color: 'var(--danger)', background: 'var(--danger-bg)' }}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          </>
        ) : (
          <>
            {/* Attachment */}
            <button className="icon-btn" title={tr.sendFileImage} onClick={() => fileInputRef.current?.click()} disabled={isTimedOut}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="21" height="21">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt" />

            <textarea
              className="msg-input"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isTimedOut ? tr.timedOutPlaceholder : tr.messagePlaceholder}
              disabled={isTimedOut}
              rows={1}
            />

            {text.trim() ? (
              <button className="send-btn" onClick={sendMessage} disabled={isTimedOut}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z" />
                </svg>
              </button>
            ) : (
              <button className="icon-btn" title={tr.recordVoice} onClick={startRecording} disabled={isTimedOut}
                style={{ color: 'var(--accent-bright)' }}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
