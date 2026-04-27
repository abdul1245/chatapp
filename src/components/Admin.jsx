import { useState } from 'react'
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, setDoc, collection, getDocs, serverTimestamp } from 'firebase/firestore'
import { secondaryAuth, db } from '../firebase'

const ADMIN_PASS = import.meta.env.VITE_ADMIN_PASSWORD

export default function Admin() {
  const [authed, setAuthed] = useState(false)
  const [adminInput, setAdminInput] = useState('')
  const [users, setUsers] = useState([])
  const [newPhone, setNewPhone] = useState('')
  const [newPass, setNewPass] = useState('')
  const [feedback, setFeedback] = useState({ msg: '', type: '' })

  const enterAdmin = e => {
    e.preventDefault()
    if (adminInput === ADMIN_PASS) {
      setAuthed(true)
      loadUsers()
    } else {
      setFeedback({ msg: 'Wrong admin password.', type: 'error' })
    }
  }

  const loadUsers = async () => {
    const snap = await getDocs(collection(db, 'users'))
    setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  }

  const createUser = async e => {
    e.preventDefault()
    setFeedback({ msg: '', type: '' })
    try {
      const email = `${newPhone.trim()}@chatapp.local`
      // Create in Firebase Auth using the secondary instance
      // (doesn't affect the admin's own session)
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, newPass)
      // Save user record to Firestore
      await setDoc(doc(db, 'users', cred.user.uid), {
        phoneNumber: newPhone.trim(),
        uid: cred.user.uid,
        createdAt: serverTimestamp(),
      })
      // Sign out the secondary auth so it's clean for next creation
      await signOut(secondaryAuth)
      setFeedback({ msg: `✓ User ${newPhone} created!`, type: 'success' })
      setNewPhone('')
      setNewPass('')
      loadUsers()
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        setFeedback({ msg: 'That number already exists.', type: 'error' })
      } else {
        setFeedback({ msg: err.message, type: 'error' })
      }
    }
  }

  if (!authed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">Admin Panel</h1>
          <p className="auth-subtitle">Developer access only</p>
          <form onSubmit={enterAdmin} className="auth-form">
            <div className="field">
              <label>Admin Password</label>
              <input
                type="password"
                value={adminInput}
                onChange={e => setAdminInput(e.target.value)}
                placeholder="Enter admin password"
                required
                autoFocus
              />
            </div>
            {feedback.msg && <div className="error-banner">{feedback.msg}</div>}
            <button type="submit" className="btn-primary">Enter</button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-page">
      <div className="admin-container">
        <h1 className="admin-title">⚙️ Admin Panel</h1>

        <div className="admin-section">
          <h2>Create New User</h2>
          <form onSubmit={createUser} className="admin-form">
            <input
              type="text"
              value={newPhone}
              onChange={e => setNewPhone(e.target.value)}
              placeholder="Phone number (e.g. 0123456789)"
              required
            />
            <input
              type="text"
              value={newPass}
              onChange={e => setNewPass(e.target.value)}
              placeholder="Password"
              required
            />
            <button type="submit" className="btn-primary">Create User</button>
          </form>
          {feedback.msg && (
            <div className={feedback.type === 'success' ? 'success-banner' : 'error-banner'}>
              {feedback.msg}
            </div>
          )}
        </div>

        <div className="admin-section">
          <h2>Registered Users ({users.length})</h2>
          <div className="users-list">
            {users.length === 0 && <p className="empty-note">No users yet.</p>}
            {users.map(u => (
              <div key={u.id} className="user-row">
                <span className="user-phone">📱 {u.phoneNumber}</span>
                <span className="user-uid">uid: {u.id.slice(0, 12)}…</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}