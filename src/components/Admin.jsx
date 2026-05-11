import { useState } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { secondaryAuth, secondaryDb } from '../firebase'
import { GtyLogo } from '../App'
import { LangThemePicker } from './Login'
import { useAppContext } from '../context/AppContext'
import { buildBirthday, buildDisplayName, formatBirthday, parseBirthday } from '../profile'
import PasswordInput from './PasswordInput'
import { sendAccountEmail } from '../email'

const ADMIN_PASS = import.meta.env.VITE_ADMIN_PASSWORD

const emptyEdit = {
  type: 'profile',
  value: '',
  name: '',
  lastName: '',
  birthDay: '',
  birthMonth: '',
  birthYear: '',
}
const emptyModeration = { type: 'timeout', duration: '30', unit: 'minutes', forever: false, reason: '' }
const emptyNewUser = {
  phoneNumber: '',
  contactEmail: '',
  password: '',
  language: 'en',
  name: '',
  lastName: '',
  birthDay: '',
  birthMonth: '',
  birthYear: '',
}
const isAdminPhone = value => /^\d+$/.test(value.trim())
const deletedLogPackageId = 'lastDeleted'
const batchLimit = 450
const sendAccountEmailQuietly = (...args) =>
  args[0]
    ? sendAccountEmail(...args).catch(err => console.warn('Account email failed:', err))
    : Promise.resolve()

export default function Admin() {
  const { tr, lang, theme, themeColor, languages } = useAppContext()
  const [authed, setAuthed] = useState(false)
  const [adminInput, setAdminInput] = useState('')
  const [users, setUsers] = useState([])
  const [logs, setLogs] = useState([])
  const [deletedLogs, setDeletedLogs] = useState([])
  const [deletedLogsMeta, setDeletedLogsMeta] = useState(null)
  const [showingDeletedLogs, setShowingDeletedLogs] = useState(false)
  const [activeTab, setActiveTab] = useState('users')
  const [search, setSearch] = useState('')
  const [feedback, setFeedback] = useState({ msg: '', type: '' })
  const [busy, setBusy] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [editForm, setEditForm] = useState(emptyEdit)
  const [newUserForm, setNewUserForm] = useState(() => ({ ...emptyNewUser, language: lang }))
  const [modTarget, setModTarget] = useState(null)
  const [modForm, setModForm] = useState(emptyModeration)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [now] = useState(() => Date.now())
  const text = (key, values = {}) =>
    Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, value), tr[key] || '')

  const showFeedback = (msg, type = 'success') => {
    setFeedback({ msg, type })
    setTimeout(() => setFeedback({ msg: '', type: '' }), 5000)
  }

  const logAction = async (action, target, details = {}) => {
    try {
      await setDoc(doc(collection(secondaryDb, 'adminLogs')), {
      action,
      targetUid: target?.id || target?.uid || null,
      targetPhone: target?.phoneNumber || null,
      details,
      createdAt: serverTimestamp(),
    })
    } catch (err) {
      console.warn('Admin log write failed:', err)
    }
  }

  const commitInBatches = async tasks => {
    for (let i = 0; i < tasks.length; i += batchLimit) {
      const batch = writeBatch(secondaryDb)
      tasks.slice(i, i + batchLimit).forEach(task => task(batch))
      await batch.commit()
    }
  }

  const adminLogsRef = () => collection(secondaryDb, 'adminLogs')
  const deletedLogPackageRef = () => doc(secondaryDb, 'adminDeletedLogPackages', deletedLogPackageId)
  const deletedLogsRef = () => collection(secondaryDb, 'adminDeletedLogPackages', deletedLogPackageId, 'logs')

  const loadUsers = async () => {
    const snap = await getDocs(collection(secondaryDb, 'users'))
    setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  }

  const loadLogs = async () => {
    const snap = await getDocs(query(collection(secondaryDb, 'adminLogs'), orderBy('createdAt', 'desc'), limit(100)))
    setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  }

  const getMillis = value => value?.toMillis?.() ?? (value ? new Date(value).getTime() : 0)

  const loadDeletedLogs = async () => {
    const [metaSnap, logsSnap] = await Promise.all([
      getDoc(deletedLogPackageRef()),
      getDocs(deletedLogsRef()),
    ])
    setDeletedLogsMeta(metaSnap.exists() ? metaSnap.data() : null)
    setDeletedLogs(logsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt)))
  }

  const refresh = async () => {
    await loadUsers()
    await loadLogs()
    await loadDeletedLogs()
  }

  const enterAdmin = async e => {
    e.preventDefault()
    if (adminInput !== ADMIN_PASS) {
      showFeedback(tr.wrongAdminPassword, 'error')
      return
    }
    setAuthed(true)
    try {
      await refresh()
    } catch (err) {
      showFeedback(`${tr.failedLoadAdminData}: ${err.message}`, 'error')
    }
  }

  const getProfileError = ({ name, birthDay, birthMonth, birthYear }) => {
    if (!String(name || '').trim()) return tr.nameRequired
    if (!buildBirthday(birthDay, birthMonth, birthYear)) return tr.invalidBirthday
    return ''
  }

  const createUser = async e => {
    e.preventDefault()
    const phoneNumber = newUserForm.phoneNumber.trim()
    const contactEmail = newUserForm.contactEmail.trim()
    const password = newUserForm.password
    const name = newUserForm.name.trim()
    const lastName = newUserForm.lastName.trim()
    const birthday = buildBirthday(newUserForm.birthDay, newUserForm.birthMonth, newUserForm.birthYear)

    if (!isAdminPhone(phoneNumber)) {
      showFeedback(tr.phoneDigitsOnly, 'error')
      return
    }

    const profileError = getProfileError(newUserForm)
    if (profileError) {
      showFeedback(profileError, 'error')
      return
    }

    if (!contactEmail || password.length < 6) {
      showFeedback(password.length < 6 ? tr.minPassword : tr.fillAllFields, 'error')
      return
    }

    setBusy(true)
    try {
      const existing = await getDocs(query(collection(secondaryDb, 'users'), where('phoneNumber', '==', phoneNumber)))
      if (!existing.empty) {
        showFeedback(tr.numberTaken, 'error')
        return
      }

      const authEmail = `${phoneNumber}@chatapp.local`
      const cred = await createUserWithEmailAndPassword(secondaryAuth, authEmail, password)
      const userDoc = {
        name,
        lastName,
        birthday,
        phoneNumber,
        contactEmail,
        adminPassword: password,
        authEmail,
        language: newUserForm.language,
        theme,
        themeColor,
        uid: cred.user.uid,
        createdAt: serverTimestamp(),
      }

      await setDoc(doc(secondaryDb, 'users', cred.user.uid), userDoc)
      await logAction('user_created', { id: cred.user.uid, phoneNumber }, { contactEmail })
      await sendAccountEmailQuietly(contactEmail, 'registered', newUserForm.language, {
        phoneNumber,
        newEmail: contactEmail,
      })
      await signOut(secondaryAuth)
      setNewUserForm({ ...emptyNewUser, language: lang })
      await refresh()
      showFeedback(tr.userCreated)
    } catch (err) {
      const message = err.code === 'auth/email-already-in-use'
        ? tr.numberTaken
        : `${tr.createFailed}: ${err.message || err.code || tr.unknownError}`
      showFeedback(message, 'error')
      await signOut(secondaryAuth).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const getStatus = user => {
    const mod = user.moderation
    if (!mod) return 'active'
    const until = mod.until?.toMillis?.() ?? mod.until
    const active = !until || until > now
    return active ? mod.type : 'active'
  }

  const searchText = search.trim().toLowerCase()
  const userMatches = user => {
    if (!searchText) return true
    return [
      buildDisplayName(user),
      user.name,
      user.lastName,
      user.birthday,
      user.phoneNumber,
      user.contactEmail,
      user.id,
    ].some(value => String(value || '').toLowerCase().includes(searchText))
  }

  const logMatches = log => {
    if (!searchText) return true
    return [
      log.targetPhone,
      log.targetUid,
      log.action,
      JSON.stringify(log.details || {}),
    ].some(value => String(value || '').toLowerCase().includes(searchText))
  }

  const moderatedUsers = users.filter(u => getStatus(u) !== 'active')
  const visibleUsers = (activeTab === 'moderation' ? moderatedUsers : users).filter(userMatches)
  const visibleLogs = logs.filter(logMatches)
  const visibleDeletedLogs = deletedLogs.filter(logMatches)
  const activeLogs = showingDeletedLogs ? visibleDeletedLogs : visibleLogs

  const clearLogs = async () => {
    if (!window.confirm(tr.clearLogsConfirm)) return

    setBusy(true)
    try {
      const logsSnap = await getDocs(adminLogsRef())
      if (logsSnap.empty) {
        showFeedback(tr.noLogsToClear, 'error')
        return
      }

      const previousDeletedSnap = await getDocs(deletedLogsRef())
      await commitInBatches([
        ...previousDeletedSnap.docs.map(logDoc => batch => batch.delete(logDoc.ref)),
        batch => batch.delete(deletedLogPackageRef()),
      ])

      const archiveTasks = [
        batch => batch.set(deletedLogPackageRef(), {
          count: logsSnap.size,
          deletedAt: serverTimestamp(),
        }),
        ...logsSnap.docs.map(logDoc => batch => batch.set(doc(deletedLogsRef(), logDoc.id), {
          ...logDoc.data(),
          originalLogId: logDoc.id,
          archivedAt: serverTimestamp(),
        })),
        ...logsSnap.docs.map(logDoc => batch => batch.delete(logDoc.ref)),
      ]
      await commitInBatches(archiveTasks)

      setShowingDeletedLogs(true)
      await loadLogs()
      await loadDeletedLogs()
      showFeedback(text('logsCleared', { count: logsSnap.size }))
    } catch (err) {
      showFeedback(`${tr.clearLogsFailed}: ${err.message || err.code || tr.unknownError}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const recoverDeletedLogs = async () => {
    setBusy(true)
    try {
      const logsSnap = await getDocs(deletedLogsRef())
      if (logsSnap.empty) {
        showFeedback(tr.noDeletedLogsRecover, 'error')
        return
      }

      await commitInBatches(logsSnap.docs.map(logDoc => batch => {
        const logData = { ...logDoc.data() }
        const originalLogId = logData.originalLogId || logDoc.id
        delete logData.originalLogId
        delete logData.archivedAt
        batch.set(doc(adminLogsRef(), originalLogId || logDoc.id), logData)
      }))

      setShowingDeletedLogs(false)
      await loadLogs()
      showFeedback(text('logsRecovered', { count: logsSnap.size }))
    } catch (err) {
      showFeedback(`${tr.recoverLogsFailed}: ${err.message || err.code || tr.unknownError}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const openEdit = user => {
    const birthday = parseBirthday(user.birthday)
    setEditTarget(user)
    setEditForm({
      type: 'profile',
      value: user.contactEmail || '',
      name: user.name || '',
      lastName: user.lastName || '',
      birthDay: birthday.day,
      birthMonth: birthday.month,
      birthYear: birthday.year,
    })
  }

  const saveEdit = async e => {
    e.preventDefault()
    if (!editTarget) return
    if (!editTarget.adminPassword) {
      showFeedback(tr.cannotEditNoPassword, 'error')
      return
    }

      setBusy(true)
    try {
      const changes = {}
      const nextValue = editForm.value.trim()
      let signedInForEdit = false

      if (editForm.type === 'profile') {
        const birthday = buildBirthday(editForm.birthDay, editForm.birthMonth, editForm.birthYear)
        const profileError = getProfileError(editForm)
        if (profileError) throw new Error(profileError)
        await signInWithEmailAndPassword(
          secondaryAuth,
          editTarget.authEmail || `${editTarget.phoneNumber}@chatapp.local`,
          editTarget.adminPassword
        )
        signedInForEdit = true
        if (editForm.name.trim() !== (editTarget.name || '')) {
          changes.name = { from: editTarget.name || '', to: editForm.name.trim() }
        }
        if (editForm.lastName.trim() !== (editTarget.lastName || '')) {
          changes.lastName = { from: editTarget.lastName || '', to: editForm.lastName.trim() }
        }
        if (birthday !== (editTarget.birthday || '')) {
          changes.birthday = { from: editTarget.birthday || '', to: birthday }
        }
      } else if (editForm.type === 'email') {
        await signInWithEmailAndPassword(
          secondaryAuth,
          editTarget.authEmail || `${editTarget.phoneNumber}@chatapp.local`,
          editTarget.adminPassword
        )
        signedInForEdit = true
        if (nextValue !== (editTarget.contactEmail || '')) {
          changes.contactEmail = { from: editTarget.contactEmail || '', to: nextValue }
        }
      } else if (editForm.type === 'password') {
        if (!nextValue || nextValue.length < 6) throw new Error(tr.minPassword)
        const cred = await signInWithEmailAndPassword(
          secondaryAuth,
          editTarget.authEmail || `${editTarget.phoneNumber}@chatapp.local`,
          editTarget.adminPassword
        )
        signedInForEdit = true
        await updatePassword(cred.user, nextValue)
        changes.password = { from: editTarget.adminPassword, to: nextValue }
      }

      if (!Object.keys(changes).length) {
        showFeedback(tr.nothingChanged, 'error')
        if (signedInForEdit) await signOut(secondaryAuth)
        return
      }

      await updateDoc(doc(secondaryDb, 'users', editTarget.id), {
        ...(changes.name ? { name: changes.name.to } : {}),
        ...(changes.lastName ? { lastName: changes.lastName.to } : {}),
        ...(changes.birthday ? { birthday: changes.birthday.to } : {}),
        ...(changes.contactEmail ? { contactEmail: changes.contactEmail.to } : {}),
        ...(changes.password ? { adminPassword: changes.password.to } : {}),
        logoutSignal: serverTimestamp(),
      })
      await logAction('account_updated', editTarget, changes)
      if (changes.contactEmail) {
        await Promise.all([
          sendAccountEmailQuietly(changes.contactEmail.from, 'emailChangedOld', editTarget.language || 'en', {
            phoneNumber: editTarget.phoneNumber,
            oldEmail: changes.contactEmail.from,
            newEmail: changes.contactEmail.to,
          }),
          sendAccountEmailQuietly(changes.contactEmail.to, 'emailChangedNew', editTarget.language || 'en', {
            phoneNumber: editTarget.phoneNumber,
            oldEmail: changes.contactEmail.from,
            newEmail: changes.contactEmail.to,
          }),
        ])
      }
      if (changes.password) {
        await sendAccountEmailQuietly(editTarget.contactEmail, 'passwordChanged', editTarget.language || 'en', {
          phoneNumber: editTarget.phoneNumber,
        })
      }
      if (signedInForEdit) await signOut(secondaryAuth)
      setEditTarget(null)
      setEditForm(emptyEdit)
      await refresh()
      showFeedback(tr.userUpdated)
    } catch (err) {
      const message = `${tr.updateFailed}: ${err.message || err.code || tr.unknownError}`
      showFeedback(message, 'error')
      console.error('Admin update failed:', err)
    } finally {
      setBusy(false)
    }
  }

  const openModeration = (user, type = 'timeout') => {
    setModTarget(user)
    setModForm({ ...emptyModeration, type })
  }

  const applyModeration = async e => {
    e.preventDefault()
    if (!modTarget) return
    if (!modTarget.adminPassword) {
      showFeedback(tr.cannotModerateNoPassword, 'error')
      return
    }

    setBusy(true)
    try {
      let until = null
      if (!modForm.forever) {
        const mult = { minutes: 60, hours: 3600, days: 86400 }
        until = new Date(Date.now() + Number(modForm.duration || 1) * mult[modForm.unit] * 1000)
      }

      const moderation = {
        type: modForm.type,
        until,
        reason: modForm.reason.trim(),
        appliedAt: serverTimestamp(),
      }

      await signInWithEmailAndPassword(
        secondaryAuth,
        modTarget.authEmail || `${modTarget.phoneNumber}@chatapp.local`,
        modTarget.adminPassword
      )
      await updateDoc(doc(secondaryDb, 'users', modTarget.id), { moderation, logoutSignal: serverTimestamp() })
      await logAction(`${modForm.type}_applied`, modTarget, {
        reason: moderation.reason,
        until: until ? until.toISOString() : 'forever',
      })
      await signOut(secondaryAuth)
      setModTarget(null)
      setModForm(emptyModeration)
      await refresh()
      showFeedback(modForm.type === 'ban' ? tr.userBanned : tr.userTimedOut)
    } catch (err) {
      showFeedback(`${tr.moderationFailed}: ${err.message}`, 'error')
      await signOut(secondaryAuth).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const liftModeration = async user => {
    if (!user.adminPassword) {
      showFeedback(tr.cannotLiftModeration, 'error')
      return
    }

    setBusy(true)
    try {
      await signInWithEmailAndPassword(
        secondaryAuth,
        user.authEmail || `${user.phoneNumber}@chatapp.local`,
        user.adminPassword
      )
      await updateDoc(doc(secondaryDb, 'users', user.id), { moderation: null, logoutSignal: serverTimestamp() })
      await logAction('moderation_lifted', user, { previousStatus: getStatus(user) })
      await signOut(secondaryAuth)
      await refresh()
      showFeedback(tr.moderationLifted)
    } catch (err) {
      showFeedback(`${tr.liftFailed}: ${err.message}`, 'error')
      await signOut(secondaryAuth).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const deleteUserAccount = async () => {
    if (!deleteTarget) return
    if (!deleteTarget.adminPassword) {
      showFeedback(tr.cannotDeleteNoPassword, 'error')
      return
    }

    setBusy(true)
    try {
      const cred = await signInWithEmailAndPassword(
        secondaryAuth,
        deleteTarget.authEmail || `${deleteTarget.phoneNumber}@chatapp.local`,
        deleteTarget.adminPassword
      )

      const chatsSnap = await getDocs(
        query(collection(secondaryDb, 'chats'), where('participants', 'array-contains', deleteTarget.id))
      )

      for (const chatDoc of chatsSnap.docs) {
        const msgsSnap = await getDocs(collection(secondaryDb, 'chats', chatDoc.id, 'messages'))
        const batch = writeBatch(secondaryDb)
        msgsSnap.docs.forEach(m => batch.delete(m.ref))
        batch.delete(chatDoc.ref)
        await batch.commit()
      }

      await deleteDoc(doc(secondaryDb, 'status', deleteTarget.id)).catch(() => {})
      await deleteDoc(doc(secondaryDb, 'users', deleteTarget.id))
      await logAction('user_deleted', deleteTarget, { contactEmail: deleteTarget.contactEmail || '' })
      await cred.user.delete()
      await signOut(secondaryAuth)
      setDeleteTarget(null)
      await refresh()
      showFeedback(tr.userDeleted)
    } catch (err) {
      showFeedback(`${tr.deleteFailed}: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const fmtDate = value => {
    const date = value?.toDate?.() ?? (value ? new Date(value) : null)
    return date ? date.toLocaleString() : '-'
  }

  if (!authed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <GtyLogo size={56} />
          <h1 className="auth-title">{tr.adminPanel}</h1>
          <form onSubmit={enterAdmin} className="auth-form">
            <PasswordInput
              value={adminInput}
              onChange={e => setAdminInput(e.target.value)}
              placeholder={tr.adminPasswordPlaceholder}
              showLabel={tr.showPassword}
              hideLabel={tr.hidePassword}
            />
            {feedback.msg && <div className="error-banner">{feedback.msg}</div>}
            <button type="submit" className="btn-primary">{tr.enter}</button>
          </form>
        </div>
      </div>
    )
  }
  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <div className="admin-brand"><GtyLogo size={28} /> {tr.adminBrand}</div>
        <div className="admin-tabs">
          {['users', 'moderation', 'logs'].map(tab => (
            <button
              key={tab}
              className={`admin-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => { setActiveTab(tab); if (tab !== 'logs') setShowingDeletedLogs(false) }}
            >
              {tab === 'users' ? `${tr.users} (${users.length})` : tab === 'moderation' ? `${tr.moderation} (${moderatedUsers.length})` : `${tr.logs} (${logs.length})`}
            </button>
          ))}
        </div>
        <div className="admin-lang-area"><LangThemePicker /></div>
      </div>

      <div className="admin-content admin-content-wide">
        <div className="admin-search">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={activeTab === 'logs' ? tr.searchLogsPlaceholder : tr.searchUsersPlaceholder}
          />
        </div>
        {feedback.msg && (
          <div className={feedback.type === 'success' ? 'success-banner' : 'error-banner'}>
            {feedback.msg}
          </div>
        )}

        {activeTab === 'users' && (
          <section className="admin-section">
            <div className="admin-section-title">{tr.createNewUser}</div>
            <form className="admin-form" onSubmit={createUser}>
              <input
                type="text"
                value={newUserForm.name}
                onChange={e => setNewUserForm(f => ({ ...f, name: e.target.value }))}
                placeholder={tr.namePlaceholder}
                required
              />
              <input
                type="text"
                value={newUserForm.lastName}
                onChange={e => setNewUserForm(f => ({ ...f, lastName: e.target.value }))}
                placeholder={tr.lastNamePlaceholder}
              />
              <input
                type="text"
                inputMode="numeric"
                value={newUserForm.phoneNumber}
                onChange={e => setNewUserForm(f => ({ ...f, phoneNumber: e.target.value }))}
                placeholder={tr.phonePlaceholder}
                required
              />
              <div className="birthday-row birthday-row-admin">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  value={newUserForm.birthDay}
                  onChange={e => setNewUserForm(f => ({ ...f, birthDay: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                  placeholder={tr.dayLabel}
                  required
                />
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  value={newUserForm.birthMonth}
                  onChange={e => setNewUserForm(f => ({ ...f, birthMonth: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                  placeholder={tr.monthLabel}
                  required
                />
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={newUserForm.birthYear}
                  onChange={e => setNewUserForm(f => ({ ...f, birthYear: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                  placeholder={tr.yearLabel}
                  required
                />
              </div>
              <input
                type="email"
                value={newUserForm.contactEmail}
                onChange={e => setNewUserForm(f => ({ ...f, contactEmail: e.target.value }))}
                placeholder={tr.emailPlaceholder}
                required
              />
              <PasswordInput
                value={newUserForm.password}
                onChange={e => setNewUserForm(f => ({ ...f, password: e.target.value }))}
                placeholder={tr.minPasswordPlaceholder}
                showLabel={tr.showPassword}
                hideLabel={tr.hidePassword}
                wrapperClassName="admin-password-field"
                required
              />
              <select
                value={newUserForm.language}
                onChange={e => setNewUserForm(f => ({ ...f, language: e.target.value }))}
              >
                {languages.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select>
              <button type="submit" className="btn-primary" disabled={busy}>
                {tr.createNewUser}
              </button>
            </form>
          </section>
        )}

        {activeTab !== 'logs' ? (
          <section className="admin-section">
            <div className="admin-section-title">
              {activeTab === 'users' ? tr.users : tr.moderatedUsers}
            </div>
            {visibleUsers.length === 0 ? (
              <div className="sidebar-empty">{tr.noUsersFound}</div>
            ) : visibleUsers.map(user => {
              const status = getStatus(user)
              const displayName = buildDisplayName(user) || user.phoneNumber || tr.unknown
              const statusLabel = status === 'ban' ? tr.statusBan : status === 'timeout' ? tr.statusTimeout : tr.statusActive
              return (
                <div className="user-card" key={user.id}>
                  <div className="avatar"><span>{displayName[0] || '?'}</span></div>
                  <div className="user-card-info">
                    <div className="user-card-phone">{displayName}</div>
                    <div className="user-card-meta">{user.phoneNumber || tr.unknown} · {user.contactEmail || tr.noContactEmail}</div>
                    <div className="user-card-meta">{formatBirthday(user.birthday)} · {user.id}</div>
                    {user.moderation?.reason && <div className="user-card-meta">{tr.reason}: {user.moderation.reason}</div>}
                  </div>
                  <span className={`user-card-badge badge-${status === 'ban' ? 'banned' : status}`}>{statusLabel}</span>
                  <div className="user-card-actions">
                    <button className="action-btn" onClick={() => openEdit(user)}>{tr.edit}</button>
                    <button className="action-btn" onClick={() => openModeration(user, 'timeout')}>{tr.timeout}</button>
                    <button className="action-btn danger" onClick={() => openModeration(user, 'ban')}>{tr.ban}</button>
                    {status !== 'active' && <button className="action-btn" onClick={() => liftModeration(user)} disabled={busy}>{tr.lift}</button>}
                    <button className="action-btn danger" onClick={() => setDeleteTarget(user)}>{tr.delete}</button>
                  </div>
                </div>
              )
            })}
          </section>
        ) : (
          <section className="admin-section">
            <div className="admin-section-header">
              <div>
                <div className="admin-section-title">{showingDeletedLogs ? tr.lastDeletedLogs : tr.adminLogs}</div>
                {showingDeletedLogs && deletedLogsMeta && (
                  <div className="user-card-meta">
                    {text('logsDeletedAt', { count: deletedLogsMeta.count || deletedLogs.length, date: fmtDate(deletedLogsMeta.deletedAt) })}
                  </div>
                )}
              </div>
              <div className="admin-log-actions">
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setShowingDeletedLogs(value => !value)}
                  disabled={busy || deletedLogs.length === 0}
                >
                  {showingDeletedLogs ? tr.seeCurrentLogs : tr.seeLastDeletedLogs}
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={recoverDeletedLogs}
                  disabled={busy || deletedLogs.length === 0}
                >
                  {tr.recoverLogs}
                </button>
                <button
                  type="button"
                  className="action-btn danger"
                  onClick={clearLogs}
                  disabled={busy}
                >
                  {tr.clearAllLogs}
                </button>
              </div>
            </div>
            {activeLogs.length === 0 ? (
              <div className="sidebar-empty">{showingDeletedLogs ? tr.noDeletedLogPackage : tr.noLogsYet}</div>
            ) : activeLogs.map(log => (
              <div className="log-row" key={log.id}>
                <div>
                  <strong>{log.action}</strong>
                  <div className="user-card-meta">{log.targetPhone || log.targetUid || tr.unknownUser} · {fmtDate(log.createdAt)}</div>
                </div>
                <pre>{JSON.stringify(log.details || {}, null, 2)}</pre>
              </div>
            ))}
          </section>
        )}
      </div>

      {editTarget && (
        <div className="modal-overlay" onClick={() => setEditTarget(null)}>
          <form className="modal" onSubmit={saveEdit} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{tr.editUser}</h2>
              <button type="button" className="icon-btn" onClick={() => setEditTarget(null)}>x</button>
            </div>
            <div className="field">
              <label>{tr.changeQuestion}</label>
              <select
                value={editForm.type}
                onChange={e => {
                  const type = e.target.value
                  const birthday = parseBirthday(editTarget.birthday)
                  setEditForm({
                    type,
                    name: editTarget.name || '',
                    lastName: editTarget.lastName || '',
                    birthDay: birthday.day,
                    birthMonth: birthday.month,
                    birthYear: birthday.year,
                    value: type === 'email'
                        ? editTarget.contactEmail || ''
                        : '',
                  })
                }}
              >
                <option value="profile">{tr.profileDetails}</option>
                <option value="email">{tr.emailAddress}</option>
                <option value="password">{tr.password}</option>
              </select>
            </div>
            {editForm.type === 'profile' ? (
              <>
                <div className="field">
                  <label>{tr.nameLabel}</label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={tr.namePlaceholder}
                    required
                  />
                </div>
                <div className="field">
                  <label>{tr.lastNameLabel} ({tr.optional})</label>
                  <input
                    type="text"
                    value={editForm.lastName}
                    onChange={e => setEditForm(f => ({ ...f, lastName: e.target.value }))}
                    placeholder={tr.lastNamePlaceholder}
                  />
                </div>
                <div className="field">
                  <label>{tr.birthdayLabel}</label>
                  <div className="birthday-row">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={2}
                      value={editForm.birthDay}
                      onChange={e => setEditForm(f => ({ ...f, birthDay: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                      placeholder={tr.dayLabel}
                      required
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={2}
                      value={editForm.birthMonth}
                      onChange={e => setEditForm(f => ({ ...f, birthMonth: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                      placeholder={tr.monthLabel}
                      required
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={editForm.birthYear}
                      onChange={e => setEditForm(f => ({ ...f, birthYear: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                      placeholder={tr.yearLabel}
                      required
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="field">
                <label>{editForm.type === 'email' ? tr.newEmail : tr.newPassword}</label>
                {editForm.type === 'password' ? (
                  <PasswordInput
                    value={editForm.value}
                    onChange={e => setEditForm(f => ({ ...f, value: e.target.value }))}
                    placeholder={tr.minPasswordPlaceholder}
                    showLabel={tr.showPassword}
                    hideLabel={tr.hidePassword}
                    required
                  />
                ) : (
                  <input
                    type="email"
                    value={editForm.value}
                    onChange={e => setEditForm(f => ({ ...f, value: e.target.value }))}
                    required
                  />
                )}
              </div>
            )}
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setEditTarget(null)}>{tr.cancel}</button>
              <button type="submit" className="btn-primary" disabled={busy}>{tr.saveChanges}</button>
            </div>
          </form>
        </div>
      )}

      {modTarget && (
        <div className="modal-overlay" onClick={() => setModTarget(null)}>
          <form className="modal" onSubmit={applyModeration} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{modForm.type === 'ban' ? tr.banUser : tr.timeoutUser}</h2>
              <button type="button" className="icon-btn" onClick={() => setModTarget(null)}>x</button>
            </div>
            <div className="field">
              <label>{tr.action}</label>
              <select value={modForm.type} onChange={e => setModForm(f => ({ ...f, type: e.target.value }))}>
                <option value="timeout">{tr.timeout}</option>
                <option value="ban">{tr.ban}</option>
              </select>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={modForm.forever} onChange={e => setModForm(f => ({ ...f, forever: e.target.checked }))} />
              {tr.forever}
            </label>
            {!modForm.forever && (
              <div className="admin-form">
                <input type="number" min="1" value={modForm.duration} onChange={e => setModForm(f => ({ ...f, duration: e.target.value }))} />
                <select value={modForm.unit} onChange={e => setModForm(f => ({ ...f, unit: e.target.value }))}>
                  <option value="minutes">{tr.minutes}</option>
                  <option value="hours">{tr.hours}</option>
                  <option value="days">{tr.days}</option>
                </select>
              </div>
            )}
            <div className="field">
              <label>{tr.reason}</label>
              <textarea value={modForm.reason} onChange={e => setModForm(f => ({ ...f, reason: e.target.value }))} rows={3} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setModTarget(null)}>{tr.cancel}</button>
              <button type="submit" className={modForm.type === 'ban' ? 'btn-danger' : 'btn-primary'} disabled={busy}>{tr.apply}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{tr.deleteUser}</h2>
              <button className="icon-btn" onClick={() => setDeleteTarget(null)}>x</button>
            </div>
            <div className="modal-warning">
              {text('deleteUserWarn', { phone: deleteTarget.phoneNumber })}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>{tr.cancel}</button>
              <button className="btn-danger" onClick={deleteUserAccount} disabled={busy}>{tr.delete}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
