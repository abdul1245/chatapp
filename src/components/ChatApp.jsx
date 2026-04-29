import { useEffect, useState } from 'react'
import { signOut } from 'firebase/auth'
import { doc, setDoc, serverTimestamp, collection, getDocs, where, query, writeBatch } from 'firebase/firestore'
import { auth, db } from '../firebase'
import Sidebar from './Sidebar'
import ChatWindow from './ChatWindow'

export default function ChatApp({ user }) {
  const [selectedChat, setSelectedChat] = useState(null)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)

  useEffect(() => {
    setDoc(doc(db, 'status', user.uid), {
      online: true,
      activeChat: null,
      lastSeen: serverTimestamp(),
    })
    markDelivered()

    const handleUnload = () => {
      setDoc(doc(db, 'status', user.uid), {
        online: false,
        activeChat: null,
        lastSeen: serverTimestamp(),
      })
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => {
      window.removeEventListener('beforeunload', handleUnload)
      handleUnload()
    }
  }, [user.uid])

  const markDelivered = async () => {
    try {
      const chatsSnap = await getDocs(
        query(collection(db, 'chats'), where('participants', 'array-contains', user.uid))
      )
      for (const chatDoc of chatsSnap.docs) {
        const msgsSnap = await getDocs(collection(db, 'chats', chatDoc.id, 'messages'))
        const batch = writeBatch(db)
        let hasWork = false
        msgsSnap.docs.forEach(d => {
          if (d.data().senderId !== user.uid && d.data().status === 'sent') {
            batch.update(doc(db, 'chats', chatDoc.id, 'messages', d.id), { status: 'delivered' })
            hasWork = true
          }
        })
        if (hasWork) await batch.commit()
      }
    } catch { /* non-critical */ }
  }

  const handleLogout = async () => {
    await setDoc(doc(db, 'status', user.uid), {
      online: false, activeChat: null, lastSeen: serverTimestamp(),
    })
    await signOut(auth)
  }

  const handleSelectChat = chat => {
    setSelectedChat(chat)
    setMobileChatOpen(true)
  }

  const handleBackToList = () => {
    setMobileChatOpen(false)
  }

  return (
    <div className="chat-app">
      <div className={`sidebar ${mobileChatOpen ? 'mobile-hidden' : ''}`}>
        <Sidebar
          user={user}
          selectedChat={selectedChat}
          onSelectChat={handleSelectChat}
          onLogout={handleLogout}
        />
      </div>

      <div className={`chat-main ${mobileChatOpen ? 'mobile-visible' : ''}`}>
        {selectedChat ? (
          <ChatWindow
            key={selectedChat.id}
            chat={selectedChat}
            currentUser={user}
            onBack={handleBackToList}
          />
        ) : (
          <div className="welcome-screen">
            <div className="welcome-inner">
              <svg viewBox="0 0 100 100" width="90" height="90" xmlns="http://www.w3.org/2000/svg" opacity="0.18">
                <polygon points="50,4 93,27 93,73 50,96 7,73 7,27" fill="none" stroke="var(--accent)" strokeWidth="3.5" strokeLinejoin="round" />
                <text x="51" y="68" textAnchor="middle" fontSize="46" fontFamily="Syne,sans-serif" fontWeight="800" fill="var(--accent)">G</text>
              </svg>
              <h2>GtyChat</h2>
              <p>Select a chat or start a new one.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}