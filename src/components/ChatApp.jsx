import { useEffect } from 'react'
import { signOut } from 'firebase/auth'
import { useState } from 'react'
import {
  doc, setDoc, serverTimestamp,
  collection, getDocs, where, query,
  writeBatch
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import Sidebar from './Sidebar'
import ChatWindow from './ChatWindow'

export default function ChatApp({ user }) {
  const [selectedChat, setSelectedChat] = useState(null)

  useEffect(() => {
    // Mark user as online
    setDoc(doc(db, 'status', user.uid), {
      online: true,
      activeChat: null,
      lastSeen: serverTimestamp(),
    })

    // When this user comes online, mark all messages sent TO them
    // that are still "sent" → upgrade to "delivered"
    markDelivered()

    // Mark offline when closing the tab
    const handleUnload = () => {
      // We use navigator.sendBeacon with REST API here — it's the only
      // reliable way to update Firestore on tab close. For a school project
      // we just do a best-effort Firestore write.
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
        const msgsSnap = await getDocs(
          collection(db, 'chats', chatDoc.id, 'messages')
        )
        const batch = writeBatch(db)
        let hasWork = false
        msgsSnap.docs.forEach(msgDoc => {
          const d = msgDoc.data()
          // Only update messages sent by the OTHER person that are still "sent"
          if (d.senderId !== user.uid && d.status === 'sent') {
            batch.update(doc(db, 'chats', chatDoc.id, 'messages', msgDoc.id), {
              status: 'delivered',
            })
            hasWork = true
          }
        })
        if (hasWork) await batch.commit()
      }
    } catch (e) {
      // Non-critical — silently fail
    }
  }

  const handleLogout = async () => {
    await setDoc(doc(db, 'status', user.uid), {
      online: false,
      activeChat: null,
      lastSeen: serverTimestamp(),
    })
    await signOut(auth)
  }

  return (
    <div className="chat-app">
      <Sidebar
        user={user}
        selectedChat={selectedChat}
        onSelectChat={setSelectedChat}
        onLogout={handleLogout}
      />
      <div className="chat-main">
        {selectedChat ? (
          <ChatWindow
            key={selectedChat.id}
            chat={selectedChat}
            currentUser={user}
          />
        ) : (
          <div className="welcome-screen">
            <div className="welcome-inner">
              <svg viewBox="0 0 24 24" width="80" height="80" fill="var(--accent)" opacity="0.3">
                <path d="M17.498 14.382c-.301-.15-1.767-.867-2.04-.966-.273-.101-.473-.15-.673.15-.197.295-.771.964-.944 1.162-.175.195-.349.21-.646.075-.3-.15-1.263-.465-2.403-1.485-.888-.795-1.484-1.77-1.66-2.07-.174-.3-.019-.465.13-.615.136-.135.301-.345.451-.523.146-.181.194-.301.297-.496.1-.21.049-.375-.025-.524-.075-.15-.672-1.62-.922-2.206-.24-.584-.487-.51-.672-.51-.172-.015-.371-.015-.571-.015-.2 0-.523.074-.797.359-.273.3-1.045 1.02-1.045 2.475s1.07 2.865 1.219 3.075c.149.195 2.105 3.195 5.1 4.485.714.3 1.27.48 1.704.629.714.227 1.365.195 1.88.121.574-.091 1.767-.721 2.016-1.426.255-.705.255-1.29.18-1.425-.074-.135-.27-.21-.57-.345z" />
                <path d="M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.334.101 11.893c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652c1.746.943 3.71 1.444 5.71 1.447h.006c6.585 0 11.946-5.336 11.949-11.896 0-3.176-1.24-6.165-3.48-8.45zm-8.475 18.3h-.005c-1.775 0-3.513-.477-5.031-1.37l-.361-.214-3.741.975.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.896-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.892 9.884z" />
              </svg>
              <h2>ChatApp Web</h2>
              <p>Select a conversation or start a new one.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}