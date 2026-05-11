import { useEffect, useRef, useState } from 'react'
import {
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth'
import { collection, doc, getDoc, getDocs, updateDoc, setDoc, deleteDoc, query, where } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { sendAccountEmail, sendEmailCode, getErrorMessage } from '../email'
import { useAppContext } from '../context/AppContext'
import { buildBirthday, buildDisplayName, formatBirthday, parseBirthday } from '../profile'
import PasswordInput from './PasswordInput'

const genCode = () => String(Math.floor(10000 + Math.random() * 90000))
const codeKey = email => email.replace(/\./g, ',').replace(/@/g, '--at--') + '_s'
const passwordCodeKey = email => `${codeKey(email)}_pw`
const changeEmailCodeKey = email => `${codeKey(email)}_change_email`
const PASSWORD_MASK = '********'
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const sendAccountEmailQuietly = (...args) =>
  args[0]
    ? sendAccountEmail(...args).catch(err => console.warn('Account email failed:', err))
    : Promise.resolve()

function useCountdown(init) {
  const [left, setLeft] = useState(init)
  const reset = n => setLeft(n ?? init)

  useEffect(() => {
    if (left <= 0) return
    const id = setInterval(() => setLeft(t => t - 1), 1000)
    return () => clearInterval(id)
  }, [left])

  const fmt = s => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
  return { left, reset, fmt: fmt(left) }
}

async function getProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid))
  return snap.exists() ? snap.data() : null
}

export default function Settings({ user, onClose }) {
  const { lang, setLang, theme, setTheme, themeColor, setThemeColor, themeColors, tr, languages } = useAppContext()
  const [tab, setTab] = useState('information')
  const [infoMode, setInfoMode] = useState(null)
  const [profile, setProfile] = useState(null)

  const refreshProfile = async () => {
    setProfile(await getProfile(user.uid))
  }

  const changeLanguage = async code => {
    setLang(code)
    await updateDoc(doc(db, 'users', user.uid), { language: code }).catch(() => {})
  }

  const changeTheme = async mode => {
    setTheme(mode)
    await updateDoc(doc(db, 'users', user.uid), { theme: mode }).catch(() => {})
  }

  const changeThemeColor = async color => {
    setThemeColor(color)
    await updateDoc(doc(db, 'users', user.uid), { themeColor: color }).catch(() => {})
  }

  useEffect(() => {
    let active = true
    getProfile(user.uid).then(data => {
      if (active) setProfile(data)
    })
    return () => {
      active = false
    }
  }, [user.uid])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tr.settings}</h2>
          <button className="icon-btn" onClick={onClose}>x</button>
        </div>

        <div className="settings-tabs">
          <button className={`admin-tab ${tab === 'information' ? 'active' : ''}`} onClick={() => setTab('information')}>
            {tr.information}
          </button>
          <button className={`admin-tab ${tab === 'appearance' ? 'active' : ''}`} onClick={() => { setInfoMode(null); setTab('appearance') }}>
            {tr.appearance}
          </button>
        </div>

        {tab === 'information' && (
          <InformationSettings
            user={user}
            profile={profile}
            tr={tr}
            mode={infoMode}
            onModeChange={setInfoMode}
            onUpdated={refreshProfile}
          />
        )}

        {tab === 'appearance' && (
          <div className="settings-content">
            <div className="settings-panel">
              <div className="settings-panel-title">{tr.appearance}</div>
              <div className="settings-group">
                <div className="settings-group-label">{tr.theme}</div>
                <div className="theme-selector">
                  {['dark', 'light'].map(m => (
                    <button
                      key={m}
                      className={`theme-option ${theme === m ? 'active' : ''}`}
                      onClick={() => changeTheme(m)}
                    >
                      {m === 'dark' ? tr.dark : tr.light}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-group">
                <div className="settings-group-label">{tr.themeColor || 'Color'}</div>
                <div className="color-grid">
                  {themeColors.map(color => (
                    <button
                      key={color.code}
                      className={`color-option ${themeColor === color.code ? 'active' : ''}`}
                      style={{ '--swatch-a': color.accent, '--swatch-b': color.bright }}
                      onClick={() => changeThemeColor(color.code)}
                      title={color.label}
                    >
                      <span className="color-swatch" aria-hidden="true" />
                      <span>{tr.themeColorNames?.[color.code] || color.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-group">
                <div className="settings-group-label">{tr.language}</div>
                <div className="lang-grid">
                  {languages.map(l => (
                    <button
                      key={l.code}
                      className={`lang-grid-btn ${lang === l.code ? 'active' : ''}`}
                      onClick={() => changeLanguage(l.code)}
                    >
                      {l.flag} {l.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InformationSettings({ user, profile, tr, mode, onModeChange, onUpdated }) {
  const fullName = buildDisplayName(profile) || profile?.phoneNumber || '-'
  const [revealedPassword, setRevealedPassword] = useState('')

  return (
    <div className="settings-content">
      <div className="settings-panel settings-profile-panel">
        <div className="settings-profile-heading">
          <div className="settings-profile-title">{fullName}</div>
          <div className="settings-profile-subtitle">{profile?.phoneNumber || '-'}</div>
        </div>

        <div className="settings-info-list">
          <InfoRow label={tr.phoneLabel} value={profile?.phoneNumber || '-'} />
          <InfoRow
            label={tr.nameLabel}
            value={profile?.name || '-'}
            action={<button className="link-btn" onClick={() => onModeChange('name')}>{tr.changeLabel}</button>}
          />
          <InfoRow
            label={tr.lastNameLabel}
            value={profile?.lastName || '-'}
            action={<button className="link-btn" onClick={() => onModeChange('lastName')}>{tr.changeLabel}</button>}
          />
          <InfoRow
            label={tr.birthdayLabel}
            value={formatBirthday(profile?.birthday)}
            action={<button className="link-btn" onClick={() => onModeChange('birthday')}>{tr.changeLabel}</button>}
          />
          <InfoRow
            label={tr.emailAddress}
            value={profile?.contactEmail || '-'}
            action={<button className="link-btn" onClick={() => onModeChange('email')}>{tr.changeEmailTitle}</button>}
          />
          <PasswordInfoRow
            password={revealedPassword}
            tr={tr}
            onShowPassword={() => onModeChange('showPassword')}
            onChangePassword={() => onModeChange('password')}
          />
        </div>
      </div>

      {mode === 'name' && (
        <EditTextField
          user={user}
          field="name"
          label={tr.nameLabel}
          value={profile?.name || ''}
          placeholder={tr.namePlaceholder}
          tr={tr}
          onBack={() => onModeChange(null)}
          onUpdated={onUpdated}
          required
        />
      )}

      {mode === 'lastName' && (
        <EditTextField
          user={user}
          field="lastName"
          label={tr.lastNameLabel}
          value={profile?.lastName || ''}
          placeholder={tr.lastNamePlaceholder}
          tr={tr}
          onBack={() => onModeChange(null)}
          onUpdated={onUpdated}
        />
      )}

      {mode === 'birthday' && (
        <EditBirthdayField
          user={user}
          profile={profile}
          tr={tr}
          onBack={() => onModeChange(null)}
          onUpdated={onUpdated}
        />
      )}

      {mode === 'showPassword' && (
        <ShowPasswordFlow
          profile={profile}
          tr={tr}
          onBack={() => onModeChange(null)}
          onReveal={setRevealedPassword}
        />
      )}

      {mode === 'password' && (
        <ChangePassword
          user={user}
          profile={profile}
          tr={tr}
          onBack={() => onModeChange(null)}
          onUpdated={onUpdated}
        />
      )}

      {mode === 'email' && (
        <ChangeEmailVerified
          user={user}
          profile={profile}
          tr={tr}
          onBack={() => onModeChange(null)}
          onUpdated={onUpdated}
        />
      )}
    </div>
  )
}

function InfoRow({ label, value, action }) {
  return (
    <div className="settings-info-row">
      <div>
        <div className="settings-info-label">{label}</div>
        <div className="settings-info-value">{value}</div>
      </div>
      {action && <div className="settings-info-action">{action}</div>}
    </div>
  )
}

function PasswordInfoRow({ password, tr, onShowPassword, onChangePassword }) {
  return (
    <div className="settings-info-row">
      <div>
        <div className="settings-info-label">{tr.password}</div>
        <div className="settings-info-value settings-info-secret">
          {password || PASSWORD_MASK}
        </div>
      </div>
      <div className="settings-info-action settings-info-action-stack">
        <button className="link-btn" onClick={onChangePassword}>{tr.changePassword}</button>
        <button className="link-btn" onClick={onShowPassword}>{tr.showPassword}</button>
      </div>
    </div>
  )
}

function ShowPasswordFlow({ profile, tr, onBack, onReveal }) {
  const [step, setStep] = useState(1)
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { left, reset, fmt } = useCountdown(60)
  const hideTimeoutRef = useRef(null)

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) window.clearTimeout(hideTimeoutRef.current)
      onReveal('')
    }
  }, [onReveal])

  const sendCode = async () => {
    setLoading(true)
    setError('')
    try {
      const email = profile?.contactEmail
      if (!email) throw new Error(tr.noEmailOnFile)
      const nextCode = genCode()
      await setDoc(doc(db, 'verificationCodes', passwordCodeKey(email)), {
        code: nextCode,
        expiresAt: new Date(Date.now() + 60_000),
        uid: profile?.uid || auth.currentUser?.uid,
        email,
        purpose: 'show-password',
      })
      await sendEmailCode(email, nextCode, 1, profile?.language || 'en')
      reset(60)
      setStep(2)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const verifyCode = async e => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const email = profile?.contactEmail
      if (!email) throw new Error(tr.noEmailOnFile)
      const snap = await getDoc(doc(db, 'verificationCodes', passwordCodeKey(email)))
      if (!snap.exists()) throw new Error(tr.codeNotFound)
      const data = snap.data()
      const exp = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt).getTime()
      if (Date.now() > exp) throw new Error(tr.codeExpired)
      if (data.code !== code.trim()) throw new Error(tr.wrongCode)
      if (!profile?.adminPassword) throw new Error(tr.noStoredPasswordFound)

      await deleteDoc(doc(db, 'verificationCodes', passwordCodeKey(email)))
      onReveal(profile.adminPassword)
      hideTimeoutRef.current = window.setTimeout(() => {
        onReveal('')
      }, 30_000)
      setStep(3)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (step === 3) {
    return (
      <div className="settings-panel">
        <div className="success-banner">{tr.passwordVisibleFor} 00:30</div>
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-head">
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
        <div className="settings-panel-title">{tr.showPassword}</div>
      </div>

      {step === 1 && (
        <div className="settings-stack">
          <div className="settings-inline-note">
            {tr.confirmIdentityEmail}
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-primary" onClick={sendCode} disabled={loading}>
            {loading ? '...' : tr.sendCode}
          </button>
        </div>
      )}

      {step === 2 && (
        <form className="settings-stack" onSubmit={verifyCode}>
          <div className="field">
            <label>{tr.enterCode}</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder={tr.codePlaceholder}
              autoFocus
            />
          </div>
          {left > 0 ? (
            <p className="code-timer">{tr.timeLeft}: <strong>{fmt}</strong></p>
          ) : (
            <div className="error-banner">{tr.codeExpired}</div>
          )}
          {error && <div className="error-banner">{error}</div>}
          <div className="settings-inline-actions">
            <button type="submit" className="btn-primary" disabled={loading || left === 0 || code.length < 5}>
              {loading ? '...' : tr.continueBtn}
            </button>
            <button type="button" className="btn-secondary" onClick={sendCode} disabled={loading}>
              {tr.resendCode}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function EditTextField({ user, field, label, value, placeholder, tr, onBack, onUpdated, required = false }) {
  const [nextValue, setNextValue] = useState(value)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const saveField = async e => {
    e.preventDefault()
    const trimmedValue = nextValue.trim()
    if (required && !trimmedValue) {
      setError(field === 'name' ? tr.nameRequired : tr.required)
      return
    }

    setLoading(true)
    setError('')
    try {
      await updateDoc(doc(db, 'users', user.uid), { [field]: trimmedValue })
      await onUpdated()
      setDone(true)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="settings-panel">
        <div className="success-banner">{tr.savedChanges}</div>
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
      </div>
    )
  }

  return (
    <form className="settings-panel settings-stack" onSubmit={saveField}>
      <div className="settings-panel-head">
        <button type="button" className="link-btn" onClick={onBack}>{tr.back}</button>
        <div className="settings-panel-title">{label}</div>
      </div>
      <div className="field">
        <label>{label}</label>
        <input
          type="text"
          value={nextValue}
          onChange={e => setNextValue(e.target.value)}
          placeholder={placeholder}
          required={required}
          autoFocus
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? '...' : tr.confirmLabel}
      </button>
    </form>
  )
}

function EditBirthdayField({ user, profile, tr, onBack, onUpdated }) {
  const birthday = parseBirthday(profile?.birthday)
  const [birthDay, setBirthDay] = useState(birthday.day)
  const [birthMonth, setBirthMonth] = useState(birthday.month)
  const [birthYear, setBirthYear] = useState(birthday.year)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const saveBirthday = async e => {
    e.preventDefault()
    const nextBirthday = buildBirthday(birthDay, birthMonth, birthYear)
    if (!nextBirthday) {
      setError(tr.invalidBirthday)
      return
    }

    setLoading(true)
    setError('')
    try {
      await updateDoc(doc(db, 'users', user.uid), { birthday: nextBirthday })
      await onUpdated()
      setDone(true)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="settings-panel">
        <div className="success-banner">{tr.savedChanges}</div>
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
      </div>
    )
  }

  return (
    <form className="settings-panel settings-stack" onSubmit={saveBirthday}>
      <div className="settings-panel-head">
        <button type="button" className="link-btn" onClick={onBack}>{tr.back}</button>
        <div className="settings-panel-title">{tr.birthdayLabel}</div>
      </div>
      <div className="field">
        <label>{tr.birthdayLabel}</label>
        <div className="birthday-row">
          <input
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={birthDay}
            onChange={e => setBirthDay(e.target.value.replace(/\D/g, '').slice(0, 2))}
            placeholder={tr.dayLabel}
            required
            autoFocus
          />
          <input
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={birthMonth}
            onChange={e => setBirthMonth(e.target.value.replace(/\D/g, '').slice(0, 2))}
            placeholder={tr.monthLabel}
            required
          />
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={birthYear}
            onChange={e => setBirthYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder={tr.yearLabel}
            required
          />
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? '...' : tr.confirmLabel}
      </button>
    </form>
  )
}

function ChangePassword({ user, profile, tr, onBack, onUpdated }) {
  const [step, setStep] = useState(1)
  const [code, setCode] = useState('')
  const [newPass, setNewPass] = useState('')
  const [conf, setConf] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const { left, reset, fmt } = useCountdown(60)

  const getUserProfile = async () => profile || await getProfile(user.uid)

  const getUserEmail = async () => {
    const userProfile = await getUserProfile()
    return userProfile?.contactEmail || null
  }

  const sendCode = async () => {
    setLoading(true)
    setError('')
    try {
      const email = await getUserEmail()
      if (!email) throw new Error(tr.noEmailOnFile)
      const userProfile = await getUserProfile()
      const nextCode = genCode()
      await setDoc(doc(db, 'verificationCodes', codeKey(email)), {
        code: nextCode,
        expiresAt: new Date(Date.now() + 60_000),
        uid: user.uid,
        email,
      })
      await sendEmailCode(email, nextCode, 1, userProfile?.language || 'en')
      reset(60)
      setStep(2)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const submit = async e => {
    e.preventDefault()
    if (newPass !== conf) {
      setError(tr.passwordsNoMatch)
      return
    }
    if (newPass.length < 6) {
      setError(tr.minPassword)
      return
    }
    setLoading(true)
    setError('')
    try {
      const email = await getUserEmail()
      const snap = await getDoc(doc(db, 'verificationCodes', codeKey(email)))
      if (!snap.exists()) throw new Error(tr.codeNotFound)
      const data = snap.data()
      const exp = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt).getTime()
      if (Date.now() > exp) throw new Error(tr.codeExpired)
      if (data.code !== code.trim()) throw new Error(tr.wrongCode)

      const userSnap = await getDoc(doc(db, 'users', user.uid))
      const userData = userSnap.data()
      const stored = userData?.adminPassword
      if (!stored) throw new Error(tr.cannotVerifyIdentity)
      const cred = EmailAuthProvider.credential(userData.authEmail || `${userData.phoneNumber}@chatapp.local`, stored)
      await reauthenticateWithCredential(auth.currentUser, cred)
      await updatePassword(auth.currentUser, newPass)
      await updateDoc(doc(db, 'users', user.uid), { adminPassword: newPass })
      await deleteDoc(doc(db, 'verificationCodes', codeKey(email)))
      await sendAccountEmailQuietly(email, 'passwordChanged', userData.language || 'en', {
        phoneNumber: userData.phoneNumber,
      })
      await onUpdated()
      setDone(true)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="settings-panel">
        <div className="success-banner">{tr.passwordChanged}</div>
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-head">
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
        <div className="settings-panel-title">{tr.changePassword}</div>
      </div>
      {step === 1 && (
        <div className="settings-stack">
          <div className="settings-inline-note">{tr.codeSending}</div>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-primary" onClick={sendCode} disabled={loading}>
            {loading ? '...' : tr.sendCode}
          </button>
        </div>
      )}
      {step === 2 && (
        <form className="settings-stack" onSubmit={submit}>
          <div className="field">
            <label>{tr.enterCode}</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder={tr.codePlaceholder}
              autoFocus
            />
          </div>
          {left > 0 ? (
            <p className="code-timer">{tr.timeLeft}: <strong>{fmt}</strong></p>
          ) : (
            <div className="error-banner">{tr.codeExpired}</div>
          )}
          <div className="field">
            <label>{tr.newPassword}</label>
            <PasswordInput
              value={newPass}
              onChange={e => setNewPass(e.target.value)}
              showLabel={tr.showPassword}
              hideLabel={tr.hidePassword}
              required
            />
          </div>
          <div className="field">
            <label>{tr.confirmNewPassword}</label>
            <PasswordInput
              value={conf}
              onChange={e => setConf(e.target.value)}
              showLabel={tr.showPassword}
              hideLabel={tr.hidePassword}
              required
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <div className="settings-inline-actions">
            <button type="submit" className="btn-primary" disabled={loading || left === 0}>
              {loading ? '...' : tr.verifyAndSave}
            </button>
            <button type="button" className="btn-secondary" onClick={sendCode} disabled={loading}>
              {tr.resendCode}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function ChangeEmailVerified({ user, profile, tr, onBack, onUpdated }) {
  const [step, setStep] = useState(1)
  const [code, setCode] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [confirmEmail, setConfirmEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const { left, reset, fmt } = useCountdown(60)

  const currentEmail = profile?.contactEmail || ''

  const sendCode = async () => {
    setLoading(true)
    setError('')
    try {
      if (!currentEmail) throw new Error(tr.currentEmailRequired)
      const nextCode = genCode()
      await setDoc(doc(db, 'verificationCodes', changeEmailCodeKey(currentEmail)), {
        code: nextCode,
        expiresAt: new Date(Date.now() + 60_000),
        uid: user.uid,
        email: currentEmail,
        purpose: 'change-email-identity',
      })
      await sendEmailCode(currentEmail, nextCode, 1, profile?.language || 'en')
      reset(60)
      setStep(2)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const verifyIdentity = async e => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const snap = await getDoc(doc(db, 'verificationCodes', changeEmailCodeKey(currentEmail)))
      if (!snap.exists()) throw new Error(tr.codeNotFound)
      const data = snap.data()
      const exp = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt).getTime()
      if (Date.now() > exp) throw new Error(tr.codeExpired)
      if (data.code !== code.trim()) throw new Error(tr.wrongCode)
      await deleteDoc(doc(db, 'verificationCodes', changeEmailCodeKey(currentEmail)))
      setStep(3)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const confirmChange = async e => {
    e.preventDefault()
    const trimmedNewEmail = newEmail.trim()
    const trimmedConfirmEmail = confirmEmail.trim()

    if (!trimmedNewEmail || !trimmedConfirmEmail) {
      setError(tr.fillAllFields)
      return
    }
    if (trimmedNewEmail !== trimmedConfirmEmail) {
      setError(tr.emailMismatch)
      return
    }
    if (!emailPattern.test(trimmedNewEmail)) {
      setError(tr.invalidEmail)
      return
    }
    if (trimmedNewEmail === currentEmail) {
      setError(tr.newEmailMustBeDifferent)
      return
    }

    setLoading(true)
    setError('')
    try {
      const existing = await getDocs(query(collection(db, 'users'), where('contactEmail', '==', trimmedNewEmail)))
      const belongsToAnotherUser = existing.docs.some(userDoc => userDoc.id !== user.uid)
      if (belongsToAnotherUser) throw new Error(tr.emailInUse)
      await updateDoc(doc(db, 'users', user.uid), { contactEmail: trimmedNewEmail })
      await Promise.all([
        sendAccountEmailQuietly(currentEmail, 'emailChangedOld', profile?.language || 'en', {
          phoneNumber: profile?.phoneNumber || user.uid,
          oldEmail: currentEmail,
          newEmail: trimmedNewEmail,
        }),
        sendAccountEmailQuietly(trimmedNewEmail, 'emailChangedNew', profile?.language || 'en', {
          phoneNumber: profile?.phoneNumber || user.uid,
          oldEmail: currentEmail,
          newEmail: trimmedNewEmail,
        }),
      ])
      await onUpdated()
      setDone(true)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="settings-panel">
        <div className="success-banner">{tr.emailChanged}</div>
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-head">
        <button className="link-btn" onClick={onBack}>{tr.back}</button>
        <div className="settings-panel-title">{tr.changeEmailTitle}</div>
      </div>

      {step === 1 && (
        <div className="settings-stack">
          <div className="settings-inline-note">
            {tr.confirmIdentityEmail}
          </div>
          <div className="settings-inline-note">
            <strong>{currentEmail || '-'}</strong>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-primary" onClick={sendCode} disabled={loading}>
            {loading ? '...' : tr.sendCode}
          </button>
        </div>
      )}

      {step === 2 && (
        <form className="settings-stack" onSubmit={verifyIdentity}>
          <div className="field">
            <label>{tr.enterCode}</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder={tr.codePlaceholder}
              autoFocus
            />
          </div>
          {left > 0 ? (
            <p className="code-timer">{tr.timeLeft}: <strong>{fmt}</strong></p>
          ) : (
            <div className="error-banner">{tr.codeExpired}</div>
          )}
          {error && <div className="error-banner">{error}</div>}
          <div className="settings-inline-actions">
            <button type="submit" className="btn-primary" disabled={loading || left === 0 || code.length < 5}>
              {loading ? '...' : tr.continueBtn}
            </button>
            <button type="button" className="btn-secondary" onClick={sendCode} disabled={loading}>
              {tr.resendCode}
            </button>
          </div>
        </form>
      )}

      {step === 3 && (
        <form className="settings-stack" onSubmit={confirmChange}>
          <div className="field">
            <label>{tr.newEmail}</label>
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder={tr.newEmailPlaceholder}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label>{tr.confirmNewEmail}</label>
            <input
              type="email"
              value={confirmEmail}
              onChange={e => setConfirmEmail(e.target.value)}
              placeholder={tr.newEmailPlaceholder}
              required
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '...' : tr.confirmLabel}
          </button>
        </form>
      )}
    </div>
  )
}
