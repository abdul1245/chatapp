import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import {
  collection, query, orderBy, onSnapshot,
  addDoc, serverTimestamp, doc, updateDoc, setDoc, getDoc, getDocs, writeBatch,
  arrayUnion, arrayRemove,
  where,
  runTransaction,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase'
import Message from './Message'
import { useAppContext } from '../context/AppContext'
import { buildDisplayName } from '../profile'

const getStoredDeletedIds = (uid, chatId) => {
  try {
    return JSON.parse(localStorage.getItem(`del_${uid}_${chatId}`) || '[]')
  } catch {
    return []
  }
}

const isDeletedForUser = (message, uid, localDeletedIds) => {
  return localDeletedIds.includes(message.id) || message.deletedFor?.includes(uid)
}

const DELETE_FOR_EVERYONE_MS = 5 * 60 * 1000

const canDeleteMessageForEveryone = (message, uid) => {
  if (!message || message.deletedForEveryone || message.type === 'call') return false
  if (message.senderId !== uid) return false
  const sentAt = message.timestamp?.toMillis?.()
  if (!sentAt) return false
  return Date.now() - sentAt <= DELETE_FOR_EVERYONE_MS
}

const messageDate = message => message.timestamp?.toDate?.() ?? null

const dateKey = date => {
  if (!date) return ''
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

const startOfLocalDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate())

const dateSeparatorLabel = (date, tr) => {
  const today = startOfLocalDay(new Date())
  const target = startOfLocalDay(date)
  const dayDiff = Math.round((today - target) / 86400000)

  if (dayDiff === 0) return tr.today
  if (dayDiff === 1) return tr.yesterday
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function PublicProfileModal({
  profile,
  displayName,
  fallbackPhone,
  contactPhoto,
  customName,
  suggestedName,
  isBlockedByMe,
  isBlocked,
  onSaveCustomName,
  onBlock,
  onUnblock,
  onClose,
  tr,
}) {
  const [photoOpen, setPhotoOpen] = useState(false)
  const [nameValue, setNameValue] = useState(customName)
  const [confirmAction, setConfirmAction] = useState(null)
  const firstName = String(profile?.name || '').trim()
  const lastName = String(profile?.lastName || '').trim()
  const fullName = [firstName, lastName].filter(Boolean).join(' ')
  const phoneNumber = profile?.phoneNumber || fallbackPhone || '-'
  const initials = (displayName || phoneNumber || '?')[0]?.toUpperCase()
  const renderAvatar = className => (
    <div className={className}>
      {contactPhoto ? <img src={contactPhoto} alt="" /> : <span>{initials}</span>}
    </div>
  )
  const saveName = () => onSaveCustomName(nameValue)
  const confirmTitle = confirmAction === 'block' ? tr.blockThisUserTitle : tr.unblockThisUserTitle
  const confirmMessage = confirmAction === 'block'
    ? tr.blockThisUserMessage
    : tr.unblockThisUserMessage

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal public-profile-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tr.contactInfo}</h2>
          <button className="icon-btn" onClick={onClose}>x</button>
        </div>

        <div className="public-profile-hero">
          <button
            type="button"
            className="public-profile-avatar-button"
            onClick={() => setPhotoOpen(true)}
            title={tr.openProfilePicture}
            aria-label={tr.openProfilePicture}
          >
            {renderAvatar('public-profile-avatar')}
          </button>
          <div className="public-profile-name">{displayName || phoneNumber}</div>
          <div className="public-profile-phone">{phoneNumber}</div>
        </div>

        <div className="public-profile-list">
          <label className="public-profile-name-field">
            <span>{tr.customName}</span>
            <input
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              placeholder={suggestedName}
            />
          </label>
          <div className="public-profile-row">
            <span>{tr.nameLabel}</span>
            <strong>{fullName || '-'}</strong>
          </div>
          <div className="public-profile-row">
            <span>{tr.phoneLabel}</span>
            <strong>{phoneNumber}</strong>
          </div>
        </div>

        <div className="public-profile-actions">
          <button
            className={isBlockedByMe ? 'btn-secondary block-toggle-btn' : 'btn-danger block-toggle-btn'}
            onClick={() => setConfirmAction(isBlockedByMe ? 'unblock' : 'block')}
          >
            {isBlockedByMe ? tr.unblockUser : tr.blockUser}
          </button>
          {isBlocked && (
            <div className="public-profile-block-note">
              {tr.messagingCallsBlockedActive}
            </div>
          )}
        </div>
      </div>
      {confirmAction && (
        <div className="profile-confirm-overlay" onClick={e => e.stopPropagation()}>
          <div className="profile-confirm-card">
            <h3>{confirmTitle}</h3>
            <p>{confirmMessage}</p>
            <div className="profile-confirm-actions">
              <button className="btn-secondary" onClick={() => setConfirmAction(null)}>{tr.cancel}</button>
              <button
                className={confirmAction === 'block' ? 'btn-danger' : 'btn-primary'}
                onClick={() => {
                  if (confirmAction === 'block') onBlock()
                  else onUnblock()
                  setConfirmAction(null)
                }}
              >
                {confirmAction === 'block' ? tr.blockUser : tr.unblockUser}
              </button>
            </div>
          </div>
        </div>
      )}
      {photoOpen && (
        <div className="profile-photo-viewer" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="profile-photo-close"
            onClick={() => setPhotoOpen(false)}
            title={tr.close}
            aria-label={tr.closeProfilePicture}
          >
            x
          </button>
          {renderAvatar('profile-photo-large')}
        </div>
      )}
    </div>
  )
}

export default function ChatWindow({ chat, currentUser, moderation, onBack, onStartCall }) {
  const { tr } = useAppContext()
  const textTpl = (key, values = {}) =>
    Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, value), tr[key] || '')
  const [messages, setMessages]       = useState([])
  const [text, setText]               = useState('')
  const [otherProfile, setOtherProfile] = useState(null)
  const [liveChat, setLiveChat] = useState(chat)
  const getContactNameState = useCallback(profile => {
    const suggested = buildDisplayName(profile) || chat.otherName || chat.otherPhone
    try {
      const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
      return {
        suggested,
        initial: String(names[chat.otherId] || '').trim() || suggested,
      }
    } catch {
      return { suggested, initial: suggested }
    }
  }, [chat.otherId, chat.otherName, chat.otherPhone, currentUser.uid])
  const { suggested: suggestedContactName, initial: initialContactName } = useMemo(() => {
    return getContactNameState(otherProfile)
  }, [getContactNameState, otherProfile])
  const [contactName, setContactName] = useState(initialContactName)
  const [otherPhoto, setOtherPhoto]   = useState(null)
  const [showProfile, setShowProfile] = useState(false)
  const [uploading, setUploading]     = useState(false)
  const [recording, setRecording]     = useState(false)
  const [recTime, setRecTime]         = useState(0)
  const [deletedIds, setDeletedIds]   = useState(() => getStoredDeletedIds(currentUser.uid, chat.id))

  const bottomRef    = useRef(null)
  const fileInputRef = useRef(null)
  const mediaRecRef  = useRef(null)
  const timerRef     = useRef(null)
  const chunksRef    = useRef([])
  const effectiveChat = liveChat || chat
  const blockedBy = effectiveChat.blockedBy || []
  const isBlockedByMe = blockedBy.includes(currentUser.uid)
  const isBlockedByOther = blockedBy.includes(chat.otherId)
  const isBlocked = isBlockedByMe || isBlockedByOther
  const blockNotice = isBlockedByMe
    ? tr.blockedByMeNotice
    : tr.blockedByOtherNotice
  const isTimedOut = moderation?.type === 'timeout'
  const sendingDisabled = isTimedOut || isBlocked

  // Load contact profile
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'users', chat.otherId), snap => {
      const data = snap.exists() ? snap.data() : null
      setOtherProfile(data)
      setOtherPhoto(data?.photoURL || null)
      const nextName = getContactNameState(data).initial
      setContactName(nextName)
    })
    return unsub
  }, [chat.otherId, getContactNameState])

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'chats', chat.id), snap => {
      if (snap.exists()) setLiveChat({ id: snap.id, ...snap.data() })
    })
    return unsub
  }, [chat.id])

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
    if (!deletedIds.length) return
    deletedIds.forEach(msgId => {
      updateDoc(doc(db, 'chats', chat.id, 'messages', msgId), { deletedFor: arrayUnion(currentUser.uid) }).catch(() => {})
    })
  }, [chat.id, currentUser.uid, deletedIds])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const isMobile = window.matchMedia?.('(max-width: 768px), (pointer: coarse)').matches
      bottomRef.current?.scrollIntoView({
        behavior: prefersReducedMotion || isMobile ? 'auto' : 'smooth',
        block: 'end',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [messages.length])

  // Send text message
  const publishChatMessage = async lastMessage => {
    await updateDoc(doc(db, 'chats', chat.id), {
      lastMessage,
      hiddenFor: arrayRemove(currentUser.uid, chat.otherId),
      clearedFor: arrayRemove(currentUser.uid, chat.otherId),
    })
  }

  const sendMessage = async () => {
    if (sendingDisabled) return
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
    await publishChatMessage({ text: trimmed, type: 'text', timestamp: serverTimestamp(), senderId: currentUser.uid, messageId: msgRef.id })
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
  if (sendingDisabled) return
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
    await publishChatMessage({ type, timestamp: serverTimestamp(), senderId: currentUser.uid, messageId: msgRef.id })
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
    if (sendingDisabled) return
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
    await publishChatMessage({ type: 'voice', timestamp: serverTimestamp(), senderId: currentUser.uid, messageId: msgRef.id })
    upgradeStatus(msgRef.id)
  } catch (err) {
    console.error('Voice upload error:', err)
    alert(`${tr.voiceUploadFailed}: ${err.message}`)
  } finally {
    setUploading(false)
  }
}

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendingDisabled) sendMessage() }
  }

  const deleteMessage = async msgId => {
    setDeletedIds(prev => {
      const updated = [...new Set([...prev, msgId])]
      localStorage.setItem(`del_${currentUser.uid}_${chat.id}`, JSON.stringify(updated))
      return updated
    })
    try {
      await updateDoc(doc(db, 'chats', chat.id, 'messages', msgId), { deletedFor: arrayUnion(currentUser.uid) })
    } catch (err) {
      alert(`${tr.deleteForMe}: ${err.message}`)
    }
  }

  const deleteMessageForEveryone = async message => {
    if (!canDeleteMessageForEveryone(message, currentUser.uid)) return

    try {
      const userSnap = await getDoc(doc(db, 'users', currentUser.uid))
      const userData = userSnap.exists() ? userSnap.data() : {}
      const deleterName = buildDisplayName(userData) || userData.phoneNumber || tr.thisUser
      const messageRef = doc(db, 'chats', chat.id, 'messages', message.id)
      const chatRef = doc(db, 'chats', chat.id)

      await runTransaction(db, async transaction => {
        const messageSnap = await transaction.get(messageRef)
        const chatSnap = await transaction.get(chatRef)
        if (!messageSnap.exists()) return

        const currentMessage = { id: messageSnap.id, ...messageSnap.data() }
        if (!canDeleteMessageForEveryone(currentMessage, currentUser.uid)) return

        transaction.update(messageRef, {
          deletedForEveryone: true,
          deletedForEveryoneBy: currentUser.uid,
          deletedForEveryoneByName: deleterName,
          deletedForEveryoneAt: serverTimestamp(),
          text: '',
          url: '',
        })

        const currentLast = chatSnap.exists() ? chatSnap.data().lastMessage : null
        if (currentLast?.messageId === message.id) {
          transaction.update(chatRef, {
            lastMessage: {
              text: textTpl('deletedMessageLast', { name: deleterName }),
              type: 'system',
              timestamp: serverTimestamp(),
              senderId: currentUser.uid,
              messageId: message.id,
            },
          })
        }
      })
    } catch (err) {
      alert(`${tr.deleteForEveryoneFailed}: ${err.message}`)
    }
  }

  const saveContactName = nextName => {
    const names = JSON.parse(localStorage.getItem(`contactNames_${currentUser.uid}`) || '{}')
    const trimmedName = String(nextName || '').trim()
    if (trimmedName) {
      names[chat.otherId] = trimmedName
    } else {
      delete names[chat.otherId]
    }
    localStorage.setItem(`contactNames_${currentUser.uid}`, JSON.stringify(names))
    window.dispatchEvent(new Event('contactNamesChanged'))
    setContactName(trimmedName || suggestedContactName)
  }

  const endOpenCallsForBlock = async () => {
    const callsSnap = await getDocs(query(collection(db, 'calls'), where('participants', 'array-contains', currentUser.uid)))
    const batch = writeBatch(db)
    let hasWork = false

    callsSnap.docs.forEach(callDoc => {
      const call = callDoc.data()
      const isThisChat = call.chatId === chat.id || call.participants?.includes(chat.otherId)
      if (!isThisChat || !['ringing', 'active'].includes(call.status)) return

      batch.update(callDoc.ref, {
        status: 'ended',
        endReason: 'blocked',
        endedBy: currentUser.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      hasWork = true
    })

    if (hasWork) await batch.commit()
  }

  const blockUser = async () => {
    await updateDoc(doc(db, 'chats', chat.id), { blockedBy: arrayUnion(currentUser.uid) })
    await endOpenCallsForBlock()
  }

  const unblockUser = async () => {
    await updateDoc(doc(db, 'chats', chat.id), { blockedBy: arrayRemove(currentUser.uid) })
  }

  const visibleMessages = messages.filter(m => !isDeletedForUser(m, currentUser.uid, deletedIds))
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

        <div
          className="chat-profile-trigger"
          role="button"
          tabIndex={0}
          title={tr.theirProfile}
          onClick={() => setShowProfile(true)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setShowProfile(true)
            }
          }}
        >
        <div className="avatar profile-open-avatar">
          {otherPhoto
            ? <img src={otherPhoto} alt="" />
            : <span>{contactName[0]?.toUpperCase()}</span>}
        </div>

        <div className="chat-header-info">
          <div className="contact-name">{contactName}</div>
          <div className="contact-subline">
            {chat.otherPhone}
          </div>
        </div>
        </div>

        <div className="chat-call-actions">
          <button
            className="icon-btn"
            title={tr.voiceCall}
            onClick={() => onStartCall?.(chat, 'voice')}
            disabled={sendingDisabled}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19">
              <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title={tr.videoCall}
            onClick={() => onStartCall?.(chat, 'video')}
            disabled={sendingDisabled}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21">
              <path d="M17 10.5V6c0-1.1-.9-2-2-2H5C3.9 4 3 4.9 3 6v12c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-4.5l4 4v-11l-4 4z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-area" style={{ position: 'relative' }}>
        {uploading && <div className="uploading-bar">{tr.uploading}</div>}
        {visibleMessages.length === 0 && (
          <div className="no-messages">{tr.noMessages}</div>
        )}
        {visibleMessages.map((msg, index) => {
          const currentDate = messageDate(msg)
          const previousDate = index > 0 ? messageDate(visibleMessages[index - 1]) : null
          const showDateSeparator = currentDate && dateKey(currentDate) !== dateKey(previousDate)

          return (
            <div className="message-day-group" key={msg.id}>
              {showDateSeparator && (
                <div className="message-date-separator">
                  <span>{dateSeparatorLabel(currentDate, tr)}</span>
                </div>
              )}
              <Message
                message={msg}
                isOwn={msg.senderId === currentUser.uid}
                onDelete={() => deleteMessage(msg.id)}
                onDeleteForEveryone={() => deleteMessageForEveryone(msg)}
                canDeleteForEveryone={canDeleteMessageForEveryone(msg, currentUser.uid)}
              />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="input-bar">
        {isBlocked && (
          <div className="block-compose-notice">
            {blockNotice}
          </div>
        )}
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
            <button className="icon-btn" title={tr.sendFileImage} onClick={() => fileInputRef.current?.click()} disabled={sendingDisabled}>
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
              placeholder={isBlocked ? tr.blockedPlaceholder : isTimedOut ? tr.timedOutPlaceholder : tr.messagePlaceholder}
              disabled={sendingDisabled}
              rows={1}
            />

            {text.trim() ? (
              <button className="send-btn" onClick={sendMessage} disabled={sendingDisabled}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z" />
                </svg>
              </button>
            ) : (
              <button className="icon-btn" title={tr.recordVoice} onClick={startRecording} disabled={sendingDisabled}
                style={{ color: 'var(--accent-bright)' }}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="21" height="21">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {showProfile && (
        <PublicProfileModal
          profile={otherProfile}
          displayName={contactName}
          fallbackPhone={chat.otherPhone}
          contactPhoto={otherPhoto}
          customName={contactName}
          suggestedName={suggestedContactName}
          isBlockedByMe={isBlockedByMe}
          isBlocked={isBlocked}
          onSaveCustomName={saveContactName}
          onBlock={blockUser}
          onUnblock={unblockUser}
          onClose={() => setShowProfile(false)}
          tr={tr}
        />
      )}
    </div>
  )
}
