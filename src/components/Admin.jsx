import { useState } from 'react'
import {
  createUserWithEmailAndPassword,
  signOut,
  signInWithEmailAndPassword,
  updatePassword,
  updateEmail,
} from 'firebase/auth'
import {
  doc, setDoc, getDocs, collection, serverTimestamp,
  updateDoc, deleteDoc, query, where, writeBatch,
} from 'firebase/firestore'
import { secondaryAuth, secondaryDb } from '../firebase'
import { GtyLogo } from '../App'

const ADMIN_PASS = import.meta.env.VITE_ADMIN_PASSWORD

export default function Admin() {
  const [authed, setAuthed]     = useState(false)
  const [adminInput, setAdminInput] = useState('')
  const [users, setUsers]       = useState([])
  const [activeTab, setActiveTab] = useState('users')
  const [feedback, setFeedback] = useState({ msg: '', type: '' })

  const [newPhone, setNewPhone] = useState('')
  const [newPass, setNewPass]   = useState('')

  const [editTarget, setEditTarget]   = useState(null)
  const [editPhone, setEditPhone]     = useState('')
  const [editPass, setEditPass]       = useState('')
  const [editLoading, setEditLoading] = useState(false)

  const [modTarget, setModTarget]       = useState(null)
  const [modType, setModType]           = useState('timeout')
  const [modDuration, setModDuration]   = useState('30')
  const [modUnit, setModUnit]           = useState('minutes')
  const [modForever, setModForever]     = useState(false)
  const [modReason, setModReason]       = useState('')

  const showFeedback = (msg, type = 'success') => {
    setFeedback({ msg, type })
    setTimeout(() => setFeedback({ msg: '', type: '' }), 5000)
  }

  const enterAdmin = e => {
    e.preventDefault()
    if (adminInput === ADMIN_PASS) { setAuthed(true); loadUsers() }
    else showFeedback('Wrong admin password.', 'error')
  }

  const loadUsers = async () => {
    try {
      const snap = await getDocs(collection(secondaryDb, 'users'))
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch (err) {
      showFeedback('Failed to load users: ' + err.message, 'error')
    }
  }

  // ── CREATE ──────────────────────────────────────────────
  const createUser = async e => {
    e.preventDefault()
    try {
      const phone = newPhone.trim()
      const pass  = newPass.trim()
      const email = `${phone}@chatapp.local`

      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pass)

      await setDoc(doc(secondaryDb, 'users', cred.user.uid), {
        phoneNumber: phone,
        uid: cred.user.uid,
        adminPassword: pass,
        createdAt: serverTimestamp(),
      })

      await signOut(secondaryAuth)
      showFeedback(`✓ User ${phone} created!`)
      setNewPhone(''); setNewPass('')
      loadUsers()
    } catch (err) {
      showFeedback(
        err.code === 'auth/email-already-in-use' ? 'Number already exists.' : err.message,
        'error'
      )
    }
  }

  // ── DELETE ──────────────────────────────────────────────
  const deleteUserAccount = async user => {
  if (!window.confirm(`Delete user ${user.phoneNumber}? This cannot be undone.`)) return
  try {
    const savedPass = user.adminPassword
    if (!savedPass) throw new Error('No stored password found for this user.')

    // Sign in as the user first
    const cred = await signInWithEmailAndPassword(
      secondaryAuth, `${user.phoneNumber}@chatapp.local`, savedPass
    )

    // ── Delete Firestore data WHILE still authenticated ──

    // Delete all chats + messages
    const chatsSnap = await getDocs(
      query(collection(secondaryDb, 'chats'), where('participants', 'array-contains', user.id))
    )
    for (const chatDoc of chatsSnap.docs) {
      const msgsSnap = await getDocs(collection(secondaryDb, 'chats', chatDoc.id, 'messages'))
      const batch = writeBatch(secondaryDb)
      msgsSnap.docs.forEach(m => batch.delete(m.ref))
      batch.delete(chatDoc.ref)
      await batch.commit()
    }

    // Delete status doc
    try { await deleteDoc(doc(secondaryDb, 'status', user.id)) } catch { /* may not exist */ }

    // Delete user doc
    await deleteDoc(doc(secondaryDb, 'users', user.id))

    // ── NOW delete from Firebase Auth ──
    await cred.user.delete()
    await signOut(secondaryAuth)

    showFeedback(`✓ User ${user.phoneNumber} fully deleted.`)
    loadUsers()
  } catch (err) {
    showFeedback('Delete failed: ' + err.message, 'error')
  }
}

  // ── EDIT CREDENTIALS ────────────────────────────────────
  const openEdit = user => {
    setEditTarget(user)
    setEditPhone(user.phoneNumber)
    setEditPass('')
  }

  const saveEdit = async () => {
    if (!editTarget) return
    const savedPass = editTarget.adminPassword
    if (!savedPass) {
      showFeedback('No stored password for this user.', 'error')
      return
    }
    setEditLoading(true)
    try {
      const newPhoneTrimmed = editPhone.trim()
      const newPassTrimmed  = editPass.trim()
      const phoneChanged    = newPhoneTrimmed !== editTarget.phoneNumber
      const passChanged     = newPassTrimmed.length > 0

      if (!phoneChanged && !passChanged) {
        showFeedback('Nothing changed.', 'error')
        setEditLoading(false)
        return
      }

      // Sign in as user via secondary auth
      const cred = await signInWithEmailAndPassword(
        secondaryAuth,
        `${editTarget.phoneNumber}@chatapp.local`,
        savedPass
      )

      // Update email (= phone number) if changed
      if (phoneChanged) {
        await updateEmail(cred.user, `${newPhoneTrimmed}@chatapp.local`)
        await updateDoc(doc(secondaryDb, 'users', editTarget.id), {
          phoneNumber: newPhoneTrimmed,
        })
      }

      // Update password if changed
      if (passChanged) {
        await updatePassword(cred.user, newPassTrimmed)
        await updateDoc(doc(secondaryDb, 'users', editTarget.id), {
          adminPassword: newPassTrimmed,
        })
      }

      await signOut(secondaryAuth)

      // Force-logout the user's active session
      await updateDoc(doc(secondaryDb, 'users', editTarget.id), {
        logoutSignal: serverTimestamp(),
      })

      showFeedback(`✓ Updated ${editTarget.phoneNumber}.`)
      setEditTarget(null)
      loadUsers()
    } catch (err) {
      let msg = err.message
      if (err.code === 'auth/invalid-credential') msg = 'Stored password is wrong — update it manually in Firebase Auth Console.'
      if (err.code === 'auth/requires-recent-login') msg = 'Firebase requires a fresh login for this. Try again.'
      showFeedback('Update failed: ' + msg, 'error')
    } finally {
      setEditLoading(false)
    }
  }

  // ── MODERATION ───────────────────────────────────────────
  const applyModeration = async () => {
    if (!modTarget) return
    try {
      let until = null
      if (!modForever) {
        const mult = { minutes: 60, hours: 3600, days: 86400 }
        until = new Date(Date.now() + parseInt(modDuration) * mult[modUnit] * 1000)
      }
      await updateDoc(doc(secondaryDb, 'users', modTarget.id), {
        moderation: {
          type: modType,
          until: until ?? null,
          reason: modReason,
          appliedAt: serverTimestamp(),
        },
      })
      showFeedback(`✓ ${modType === 'ban' ? 'Banned' : 'Timed out'} ${modTarget.phoneNumber}.`)
      setModTarget(null); setModReason('')
      loadUsers()
    } catch (err) {
      showFeedback('Failed: ' + err.message, 'error')
    }
  }

  const liftModeration = async user => {
    try {
      await updateDoc(doc(secondaryDb, 'users', user.id), { moderation: null })
      showFeedback(`✓ Moderation lifted for ${user.phoneNumber}.`)
      loadUsers()
    } catch (err) {
      showFeedback('Failed: ' + err.message, 'error')
    }
  }

  const getStatus = user => {
    const mod = user.moderation
    if (!mod) return 'active'
    const active = !mod.until || (mod.until?.toMillis?.() ?? mod.until) > Date.now()
    if (!active) return 'active'
    return mod.type
  }

  // ── RENDER ───────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <GtyLogo size={56} />
          <h1 className="auth-title">Admin Panel</h1>
          <p className="auth-subtitle">Developer access only</p>
          <form onSubmit={enterAdmin} className="auth-form">
            <div className="field">
              <label>Admin Password</label>
              <input type="password" value={adminInput} onChange={e => setAdminInput(e.target.value)} placeholder="Enter admin password" required autoFocus />
            </div>
            {feedback.msg && <div className="error-banner">{feedback.msg}</div>}
            <button type="submit" className="btn-primary">Enter</button>
          </form>
        </div>
      </div>
    )
  }

  const moderatedUsers = users.filter(u => getStatus(u) !== 'active')

  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <div className="admin-brand"><GtyLogo size={28} /> GtyChat Admin</div>
        <div className="admin-tabs">
          {['users', 'moderation'].map(tab => (
            <button key={tab} className={`admin-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
              {tab === 'users' ? `Users (${users.length})` : `Moderation (${moderatedUsers.length})`}
            </button>
          ))}
        </div>
      </div>

      <div className="admin-content">
        {feedback.msg && (
          <div className={feedback.type === 'success' ? 'success-banner' : 'error-banner'}>
            {feedback.msg}
          </div>
        )}

        {activeTab === 'users' && (
          <>
            <div className="admin-section">
              <div className="admin-section-title">Create New User</div>
              <form onSubmit={createUser} className="admin-form">
                <input type="text" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="Phone number" required />
                <input type="text" value={newPass}  onChange={e => setNewPass(e.target.value)}  placeholder="Password" required />
                <button type="submit" className="btn-primary">Create</button>
              </form>
            </div>

            <div className="admin-section">
              <div className="admin-section-title">All Users</div>
              {users.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No users yet.</p>}
              {users.map(u => {
                const status = getStatus(u)
                return (
                  <div key={u.id} className="user-card">
                    <div className="user-card-info">
                      <div className="user-card-phone">📱 {u.phoneNumber}</div>
                      <div className="user-card-meta">{u.id.slice(0, 14)}…</div>
                    </div>
                    <span className={`user-card-badge badge-${status}`}>{status}</span>
                    <div className="user-card-actions">
                      <button className="action-btn" onClick={() => openEdit(u)}>Edit</button>
                      <button className="action-btn" onClick={() => { setModTarget(u); setModType('timeout') }}>Timeout</button>
                      <button className="action-btn" onClick={() => { setModTarget(u); setModType('ban') }}>Ban</button>
                      <button className="action-btn danger" onClick={() => deleteUserAccount(u)}>Delete</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {activeTab === 'moderation' && (
          <div className="admin-section">
            <div className="admin-section-title">Currently Moderated</div>
            {moderatedUsers.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No active bans or timeouts.</p>}
            {moderatedUsers.map(u => {
              const mod = u.moderation
              const status = getStatus(u)
              return (
                <div key={u.id} className="user-card">
                  <div className="user-card-info">
                    <div className="user-card-phone">📱 {u.phoneNumber}</div>
                    <div className="user-card-meta">
                      {mod?.type?.toUpperCase()} · {mod?.reason || 'No reason'}
                      {mod?.until ? ` · Until ${new Date(mod.until?.toMillis?.() ?? mod.until).toLocaleString()}` : ' · Forever'}
                    </div>
                  </div>
                  <span className={`user-card-badge badge-${status}`}>{status}</span>
                  <button className="action-btn" onClick={() => liftModeration(u)}>Lift</button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editTarget && (
        <div className="modal-overlay" onClick={() => setEditTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit — {editTarget.phoneNumber}</h2>
              <button className="icon-btn" onClick={() => setEditTarget(null)}>✕</button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 300, lineHeight: 1.6 }}>
              Leave password blank to keep unchanged. The user will be force-logged out after saving.
            </p>
            <div className="field">
              <label>New Phone Number</label>
              <input type="text" value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="Phone number" />
            </div>
            <div className="field">
              <label>New Password (blank = keep current)</label>
              <input type="text" value={editPass} onChange={e => setEditPass(e.target.value)} placeholder="New password" />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditTarget(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit} disabled={editLoading}>
                {editLoading ? 'Saving…' : 'Save & Logout User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Moderation modal */}
      {modTarget && (
        <div className="modal-overlay" onClick={() => setModTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{modType === 'ban' ? '🚫 Ban' : '⏳ Timeout'} — {modTarget.phoneNumber}</h2>
              <button className="icon-btn" onClick={() => setModTarget(null)}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['timeout', 'ban'].map(t => (
                <button key={t} className={`admin-tab ${modType === t ? 'active' : ''}`} onClick={() => setModType(t)} style={{ flex: 1 }}>
                  {t === 'ban' ? '🚫 Ban' : '⏳ Timeout'}
                </button>
              ))}
            </div>
            {modType === 'ban' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text-dim)', cursor: 'pointer' }}>
                <input type="checkbox" checked={modForever} onChange={e => setModForever(e.target.checked)} style={{ width: 'auto' }} />
                Permanent ban (forever)
              </label>
            )}
            {(!modForever || modType === 'timeout') && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" value={modDuration} onChange={e => setModDuration(e.target.value)} min="1" style={{ flex: 1 }} />
                <select value={modUnit} onChange={e => setModUnit(e.target.value)} style={{ flex: 1 }}>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
            )}
            <div className="field">
              <label>Reason (optional)</label>
              <input type="text" value={modReason} onChange={e => setModReason(e.target.value)} placeholder="e.g. Spam" />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setModTarget(null)}>Cancel</button>
              <button className="btn-danger" style={{ width: 'auto' }} onClick={applyModeration}>
                Apply {modType === 'ban' ? 'Ban' : 'Timeout'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}