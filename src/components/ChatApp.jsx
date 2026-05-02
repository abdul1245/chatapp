import { useCallback, useEffect, useState } from 'react'
import { signOut } from 'firebase/auth'
import { doc, setDoc, serverTimestamp, collection, getDocs, where, query, writeBatch } from 'firebase/firestore'
import { auth, db } from '../firebase'
import Sidebar from './Sidebar'
import ChatWindow from './ChatWindow'
import Settings from './Settings'
import { GtyLogo } from '../App'

export default function ChatApp({ user, moderation }) {
  const [selectedChat, setSelectedChat]   = useState(null)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [showSettings, setShowSettings]   = useState(false)

  const markDelivered = useCallback(async () => {
    try {
      const chatsSnap = await getDocs(query(collection(db, 'chats'), where('participants', 'array-contains', user.uid)))
      for (const chatDoc of chatsSnap.docs) {
        const msgsSnap = await getDocs(collection(db, 'chats', chatDoc.id, 'messages'))
        const batch = writeBatch(db); let hasWork = false
        msgsSnap.docs.forEach(d => {
          if (d.data().senderId !== user.uid && d.data().status === 'sent') {
            batch.update(doc(db, 'chats', chatDoc.id, 'messages', d.id), { status: 'delivered' })
            hasWork = true
          }
        })
        if (hasWork) await batch.commit()
      }
    } catch { /* non-critical */ }
  }, [user.uid])

  useEffect(() => {
    setDoc(doc(db, 'status', user.uid), { online: true, activeChat: null, lastSeen: serverTimestamp() })
    markDelivered()
    const handleUnload = () => setDoc(doc(db, 'status', user.uid), { online: false, activeChat: null, lastSeen: serverTimestamp() })
    window.addEventListener('beforeunload', handleUnload)
    return () => { window.removeEventListener('beforeunload', handleUnload); handleUnload() }
  }, [markDelivered, user.uid])

  const handleLogout = async () => {
    await setDoc(doc(db, 'status', user.uid), { online: false, activeChat: null, lastSeen: serverTimestamp() })
    await signOut(auth)
  }

  const handleSelectChat = useCallback(chat => {
    setSelectedChat(chat)
    setMobileChatOpen(Boolean(chat))
  }, [])

  return (
    <div className="chat-app">
      <div className={`sidebar ${mobileChatOpen ? 'mobile-hidden' : ''}`}>
        <Sidebar
          key={user.uid}
          user={user}
          selectedChat={selectedChat}
          onSelectChat={handleSelectChat}
          onLogout={handleLogout}
          onSettings={() => setShowSettings(true)}
        />
      </div>

      <div className={`chat-main ${mobileChatOpen ? 'mobile-visible' : ''}`}>
        {selectedChat ? (
          <ChatWindow
            key={selectedChat.id}
            chat={selectedChat}
            currentUser={user}
            moderation={moderation}
            onBack={() => setMobileChatOpen(false)}
          />
        ) : (
          <div className="welcome-screen">
            <div className="welcome-inner">
              <GtyLogo size={90} />
              <h2>GtyChat</h2>
            </div>
          </div>
        )}
      </div>

      {showSettings && <Settings user={user} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
