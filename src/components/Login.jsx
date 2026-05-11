import { useState, useEffect, useRef } from 'react'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
} from 'firebase/auth'
import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where, serverTimestamp, updateDoc,
} from 'firebase/firestore'
import { auth, secondaryAuth, db, secondaryDb } from '../firebase'
import { sendAccountEmail, sendEmailCode, getErrorMessage } from '../email'
import { GtyLogo } from '../App'
import { useAppContext } from '../context/AppContext'
import { buildBirthday } from '../profile'
import { maskEmail } from '../privacy'
import { getDeviceId, getDeviceInfo } from '../deviceSession'
import PasswordInput from './PasswordInput'

// ── helpers ──────────────────────────────────────────────────
const genCode  = () => String(Math.floor(10000 + Math.random() * 90000))
const genPhone = () => String(Math.floor(1000000000 + Math.random() * 9000000000))
const codeKey  = email => email.replace(/\./g, ',').replace(/@/g, '--at--')
const activeSessionCodeKey = uid => `${uid}_active_session_login`
const isSignupPhone = value => /^\d{10}$/.test(value.trim())

const sendAccountEmailQuietly = (...args) =>
  args[0]
    ? sendAccountEmail(...args).catch(err => console.warn('Account email failed:', err))
    : Promise.resolve()

const storeCode = (key, code, ms, meta = {}) =>
  setDoc(doc(db, 'verificationCodes', key), {
    code, expiresAt: new Date(Date.now() + ms), ...meta,
  })

const checkCode = async (key, input) => {
  const snap = await getDoc(doc(db, 'verificationCodes', key))
  if (!snap.exists()) return { ok: false, reason: 'not_found' }
  const d = snap.data()
  const exp = d.expiresAt?.toMillis?.() ?? new Date(d.expiresAt).getTime()
  if (Date.now() > exp)     return { ok: false, reason: 'expired' }
  if (d.code !== input.trim()) return { ok: false, reason: 'wrong' }
  return { ok: true, data: d }
}

// ── Language + Theme picker (also used in Admin) ─────────────
export function LangThemePicker() {
  const { lang, setLang, theme, setTheme, themeColor, setThemeColor, themeColors, tr, languages } = useAppContext()
  const [open, setOpen] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const cur = languages.find(l => l.code === lang)
  const curColor = themeColors.find(c => c.code === themeColor) || themeColors[0]

  return (
    <div className="auth-topbar" ref={ref}>
      <div className="lang-picker">
        <button className="lang-btn" onClick={() => setOpen(o => o === 'lang' ? null : 'lang')}>
          {cur?.flag} {cur?.name} ▾
        </button>
        {open === 'lang' && (
          <div className="lang-dropdown">
            {languages.map(l => (
              <button
                key={l.code}
                className={`lang-option ${lang === l.code ? 'active' : ''}`}
                onClick={() => { setLang(l.code); setOpen(null) }}
              >
                {l.flag} {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="theme-color-picker">
        <button
          className="theme-color-toggle"
          onClick={() => setOpen(o => o === 'color' ? null : 'color')}
          title={tr.themeColor || 'Color'}
          style={{ '--swatch-a': curColor.accent, '--swatch-b': curColor.bright }}
        >
          <span className="topbar-color-swatch" aria-hidden="true" />
        </button>
        {open === 'color' && (
          <div className="theme-color-dropdown">
            {themeColors.map(color => (
              <button
                key={color.code}
                className={`theme-color-menu-btn ${themeColor === color.code ? 'active' : ''}`}
                onClick={() => { setThemeColor(color.code); setOpen(null) }}
                title={tr.themeColorNames?.[color.code] || color.label}
                style={{ '--swatch-a': color.accent, '--swatch-b': color.bright }}
              >
                <span className="topbar-color-swatch" aria-hidden="true" />
                <span>{tr.themeColorNames?.[color.code] || color.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="theme-toggle"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={tr.toggleTheme}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
    </div>
  )
}

// ── Countdown timer hook ─────────────────────────────────────
function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds)
  const reset = (s = seconds) => setLeft(s)

  useEffect(() => {
    if (left <= 0) return
    const id = setInterval(() => setLeft(t => t - 1), 1000)
    return () => clearInterval(id)
  }, [left])

  const fmt = s => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`
  return { left, reset, fmt: fmt(left) }
}

// ── Reusable code step ───────────────────────────────────────
function CodeStep({ email, expirySec, onVerify, onResend, onChangeEmail, tr, submitLabel }) {
  const [code, setCode]   = useState('')
  const { left, reset, fmt } = useCountdown(expirySec)
  const [loading, setLoading]   = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError]       = useState('')

  const submit = async () => {
    setLoading(true); setError('')
    try {
      const res = await onVerify(code.trim())
      if (res?.error) setError(res.error)
    } catch (e) {
      setError(getErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const resend = async () => {
    setResending(true); setError('')
    try { await onResend(); reset() } catch (e) { setError(getErrorMessage(e)) }
    setResending(false)
  }

  return (
    <div className="auth-form">
      <div className="verify-header">
        <div className="verify-icon">📧</div>
        <p className="verify-title">{tr.verifyEmail}</p>
        <p className="verify-sub">{tr.codeSentTo} <strong>{maskEmail(email)}</strong></p>
      </div>

      <div className="field">
        <label>{tr.enterCode}</label>
        <input
          type="text"
          inputMode="numeric"
          maxLength={5}
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g,'').slice(0,5))}
          placeholder={tr.codePlaceholder}
          style={{ textAlign: 'center', fontSize: 26, letterSpacing: 10, fontWeight: 700 }}
          autoFocus
        />
      </div>

      {left > 0
        ? <p className="code-timer">{tr.timeLeft}: <strong>{fmt}</strong></p>
        : <div className="error-banner">{tr.codeExpired}</div>
      }

      {error && <div className="error-banner">{error}</div>}

      <button className="btn-primary" onClick={submit}
        disabled={loading || code.length < 5 || left <= 0}>
        {loading ? '…' : (submitLabel || tr.verify)}
      </button>

      <div className="code-actions">
        <button className="link-btn" onClick={resend} disabled={resending || left > 0}>
          {resending ? tr.sending : tr.resendCode}
        </button>
        {onChangeEmail && (
          <button className="link-btn" onClick={onChangeEmail}>{tr.changeEmail}</button>
        )}
      </div>
    </div>
  )
}

// ── Login form ───────────────────────────────────────────────
function LoginForm({ onForgot, tr }) {
  const [input, setInput]     = useState('')
  const [pass, setPass]       = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [conflict, setConflict] = useState(null)

  const getLoginTarget = async trimmed => {
    if (trimmed.includes('@')) {
      const snap = await getDocs(query(collection(db, 'users'), where('contactEmail', '==', trimmed)))
      if (snap.empty) throw new Error(tr.wrongCredentials)
      const userDoc = snap.docs[0]
      const userData = userDoc.data()
      return {
        uid: userDoc.id,
        userData,
        authEmail: userData.authEmail || `${userData.phoneNumber}@chatapp.local`,
      }
    }

    const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', trimmed)))
    if (snap.empty) {
      return {
        uid: null,
        userData: null,
        authEmail: `${trimmed}@chatapp.local`,
      }
    }
    const userDoc = snap.docs[0]
    const userData = userDoc.data()
    return {
      uid: userDoc.id,
      userData,
      authEmail: userData.authEmail || `${trimmed}@chatapp.local`,
    }
  }

  const getActiveSessions = async uid => {
    if (!uid) return []
    const currentDeviceId = getDeviceId()
    const snap = await getDocs(query(collection(db, 'users', uid, 'devices'), where('active', '==', true)))
    return snap.docs
      .map(deviceDoc => ({ id: deviceDoc.id, ref: deviceDoc.ref, ...deviceDoc.data() }))
      .filter(device => device.id !== currentDeviceId)
  }

  const notifyActiveSessionAttempt = async (email, userData, attemptInfo, activeSessions, status) => {
    await sendAccountEmailQuietly(email, 'activeSessionLoginAttempt', userData.language || 'en', {
      phoneNumber: userData.phoneNumber,
      attemptTime: attemptInfo.attemptTimeText,
      attemptDevice: attemptInfo.deviceLabel,
      attemptCountry: attemptInfo.country,
      attemptTimezone: attemptInfo.timezone,
      activeDevice: activeSessions[0]?.deviceLabel || '',
      status,
    })
  }

  const startActiveSessionChallenge = async ({ uid, userData, authEmail }) => {
    const email = userData?.contactEmail
    if (!uid || !email) throw new Error(tr.noEmailOnFile)
    const activeSessions = await getActiveSessions(uid)
    if (activeSessions.length === 0) return false

    const attemptInfo = {
      ...getDeviceInfo(),
      attemptTimeText: new Date().toLocaleString(),
    }
    const code = genCode()
    await storeCode(activeSessionCodeKey(uid), code, 60_000, {
      uid,
      email,
      purpose: 'active-session-login',
      attemptDeviceId: getDeviceId(),
      attemptDevice: attemptInfo.deviceLabel,
      attemptCountry: attemptInfo.country,
      attemptTimezone: attemptInfo.timezone,
    })
    await sendEmailCode(email, code, 1, userData.language || 'en')
    await notifyActiveSessionAttempt(email, userData, attemptInfo, activeSessions, 'verification_required')
    setConflict({
      uid,
      userData,
      authEmail,
      email,
      activeSessions,
      attemptInfo,
    })
    return true
  }

  const handleLogin = async e => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const trimmed = input.trim()
      const target = await getLoginTarget(trimmed)
      await signInWithEmailAndPassword(secondaryAuth, target.authEmail, pass)
      await signOut(secondaryAuth)

      const needsChallenge = await startActiveSessionChallenge(target)
      if (needsChallenge) {
        setLoading(false)
        return
      }

      await signInWithEmailAndPassword(auth, target.authEmail, pass)
    } catch (e) {
      await signOut(secondaryAuth).catch(() => {})
      setError(e?.message === tr.noEmailOnFile ? tr.noEmailOnFile : tr.wrongCredentials)
    } finally {
      setLoading(false)
    }
  }

  const verifyActiveSession = async inputCode => {
    if (!conflict) return { error: tr.wrongCredentials }
    const res = await checkCode(activeSessionCodeKey(conflict.uid), inputCode)
    if (!res.ok) {
      await notifyActiveSessionAttempt(
        conflict.email,
        conflict.userData,
        conflict.attemptInfo,
        conflict.activeSessions,
        res.reason === 'expired' ? 'verification_expired' : 'verification_failed'
      )
      await deleteDoc(doc(db, 'verificationCodes', activeSessionCodeKey(conflict.uid))).catch(() => {})
      setConflict(null)
      setError(res.reason === 'expired' ? tr.codeExpired : tr.wrongCode)
      return { error: res.reason === 'expired' ? tr.codeExpired : tr.wrongCode }
    }

    await Promise.all(conflict.activeSessions.map(device =>
      updateDoc(device.ref, {
        active: false,
        forcedLogout: true,
        forceLogoutAt: serverTimestamp(),
        loggedOutAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
    ))
    await deleteDoc(doc(db, 'verificationCodes', activeSessionCodeKey(conflict.uid)))
    await notifyActiveSessionAttempt(
      conflict.email,
      conflict.userData,
      conflict.attemptInfo,
      conflict.activeSessions,
      'verified_old_session_logged_out'
    )
    await signInWithEmailAndPassword(auth, conflict.authEmail, pass)
    return {}
  }

  const resendActiveSessionCode = async () => {
    if (!conflict) return
    const code = genCode()
    await storeCode(activeSessionCodeKey(conflict.uid), code, 60_000, {
      uid: conflict.uid,
      email: conflict.email,
      purpose: 'active-session-login',
      attemptDeviceId: getDeviceId(),
      attemptDevice: conflict.attemptInfo.deviceLabel,
      attemptCountry: conflict.attemptInfo.country,
      attemptTimezone: conflict.attemptInfo.timezone,
    })
    await sendEmailCode(conflict.email, code, 1, conflict.userData.language || 'en')
  }

  if (conflict) {
    return (
      <CodeStep
        email={conflict.email}
        expirySec={60}
        onVerify={verifyActiveSession}
        onResend={resendActiveSessionCode}
        tr={tr}
        submitLabel={tr.verifyLogin || tr.continueBtn}
      />
    )
  }

  return (
    <form onSubmit={handleLogin} className="auth-form">
      <div className="field">
        <label>{tr.phoneOrEmail}</label>
        <input type="text" value={input} onChange={e => setInput(e.target.value)}
          placeholder={tr.phoneOrEmailPlaceholder} required autoFocus />
      </div>
      <div className="field">
        <label>{tr.password}</label>
        <PasswordInput
          value={pass}
          onChange={e => setPass(e.target.value)}
          showLabel={tr.showPassword}
          hideLabel={tr.hidePassword}
          required
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? '…' : tr.login}
      </button>
      <button type="button" className="link-btn" onClick={onForgot}>{tr.forgotPassword}</button>
    </form>
  )
}

// ── Register flow ────────────────────────────────────────────
function RegisterFlow({ tr }) {
  const { lang, setLang, theme, themeColor, languages } = useAppContext()
  const [step, setStep]           = useState(1)
  const [phone, setPhone]         = useState('')
  const [phoneStatus, setPhoneStatus] = useState(null)
  const [phoneError, setPhoneError] = useState('')
  const [checkLoading, setCheckLoading] = useState(false)
  const [email, setEmail]         = useState('')
  const [pass, setPass]           = useState('')
  const [pendingLang, setPendingLang] = useState(lang)
  const [name, setName]           = useState('')
  const [lastName, setLastName]   = useState('')
  const [birthDay, setBirthDay]   = useState('')
  const [birthMonth, setBirthMonth] = useState('')
  const [birthYear, setBirthYear] = useState('')
  const [sending, setSending]     = useState(false)
  const [error, setError]         = useState('')

  const validateProfile = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return tr.nameRequired
    const birthday = buildBirthday(birthDay, birthMonth, birthYear)
    if (!birthday) return tr.invalidBirthday
    return ''
  }

  const checkPhone = async () => {
    const trimmedPhone = phone.trim()
    if (!trimmedPhone) return
    setPhoneError('')
    setPhoneStatus(null)
    if (!isSignupPhone(trimmedPhone)) {
      setPhoneError(tr.phoneMustBe10Digits)
      return
    }

    setCheckLoading(true)
    const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', trimmedPhone)))
    setPhoneStatus(snap.empty ? 'available' : 'taken')
    setCheckLoading(false)
  }

  const generatePhone = async () => {
    let num, tries = 0
    do {
      num = genPhone(); tries++
      const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', num)))
      if (snap.empty) break
    } while (tries < 10)
    setPhone(num); setPhoneStatus('available')
  }

  const sendCode = async () => {
    const trimmedPhone = phone.trim()
    if (!isSignupPhone(trimmedPhone)) {
      setError(tr.phoneMustBe10Digits)
      return
    }
    if (!email.trim() || pass.length < 6) {
      setError(pass.length < 6 ? tr.minPassword : tr.fillAllFields)
      return
    }
    const profileError = validateProfile()
    if (profileError) {
      setError(profileError)
      return
    }
    setSending(true); setError('')
    try {
      const code = genCode()
      const key  = codeKey(email.trim())
      await storeCode(key, code, 120_000, {
        phoneNumber: trimmedPhone,
        email: email.trim(),
        password: pass,
        lang: pendingLang,
        theme,
        themeColor,
        name: name.trim(),
        lastName: lastName.trim(),
        birthday: buildBirthday(birthDay, birthMonth, birthYear),
      })
      await sendEmailCode(email.trim(), code, 2, pendingLang)
      setLang(pendingLang)
      setStep(4)
    } catch (e) {
      setError(`${tr.emailActionHint}: ${getErrorMessage(e)}`)
    } finally {
      setSending(false)
    }
  }

  const verify = async inputCode => {
    const key = codeKey(email.trim())
    const res = await checkCode(key, inputCode)
    if (!res.ok) return { error: res.reason === 'expired' ? tr.codeExpired : tr.wrongCode }
    try {
      const {
        phoneNumber,
        password: pw,
        lang: l,
        theme: savedTheme,
        themeColor: savedThemeColor,
        name: savedName,
        lastName: savedLastName,
        birthday,
      } = res.data
      if (!isSignupPhone(phoneNumber)) return { error: tr.phoneMustBe10Digits }
      if (!savedName?.trim()) return { error: tr.nameRequired }
      if (!birthday) return { error: tr.invalidBirthday }
      const cred = await createUserWithEmailAndPassword(secondaryAuth, `${phoneNumber}@chatapp.local`, pw)
      await setDoc(doc(secondaryDb, 'users', cred.user.uid), {
        name: savedName.trim(),
        lastName: String(savedLastName || '').trim(),
        birthday,
        phoneNumber, contactEmail: email.trim(), adminPassword: pw,
        authEmail: `${phoneNumber}@chatapp.local`,
        language: l, theme: savedTheme || theme, themeColor: savedThemeColor || themeColor,
        uid: cred.user.uid, createdAt: serverTimestamp(),
      })
      await signOut(secondaryAuth)
      await deleteDoc(doc(db, 'verificationCodes', key))
      await sendAccountEmailQuietly(email.trim(), 'registered', l, {
        phoneNumber,
        newEmail: email.trim(),
      })
      await signInWithEmailAndPassword(auth, `${phoneNumber}@chatapp.local`, pw)
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') return { error: tr.numberTaken }
      return { error: getErrorMessage(e) }
    }
    return {}
  }

  const resend = async () => {
    const trimmedPhone = phone.trim()
    if (!isSignupPhone(trimmedPhone)) throw new Error(tr.phoneMustBe10Digits)
    const birthday = buildBirthday(birthDay, birthMonth, birthYear)
    if (!name.trim()) throw new Error(tr.nameRequired)
    if (!birthday) throw new Error(tr.invalidBirthday)
    const code = genCode()
    const key  = codeKey(email.trim())
    await storeCode(key, code, 120_000, {
      phoneNumber: trimmedPhone,
      email: email.trim(),
      password: pass,
      lang: pendingLang,
      theme,
      themeColor,
      name: name.trim(),
      lastName: lastName.trim(),
      birthday,
    })
    await sendEmailCode(email.trim(), code, 2, pendingLang)
  }

  if (step === 1) return (
    <div className="auth-form">
      <p className="auth-step-title">{tr.chooseYourNumber}</p>
      <div className="phone-check-row">
        <input type="text" value={phone}
          inputMode="numeric"
          onChange={e => { setPhone(e.target.value); setPhoneStatus(null); setPhoneError('') }}
          placeholder={tr.phonePlaceholder} />
        <button className="btn-secondary" onClick={checkPhone}
          disabled={checkLoading || !phone.trim()} style={{ width: 'auto' }}>
          {checkLoading ? '…' : tr.check}
        </button>
      </div>
      <button className="link-btn" onClick={generatePhone}>{tr.generateRandom}</button>
      {phoneError && <div className="error-banner">{phoneError}</div>}
      {phoneStatus === 'available' && <div className="success-banner">{tr.numberAvailable}</div>}
      {phoneStatus === 'taken'     && <div className="error-banner">{tr.numberTaken}</div>}
      <button className="btn-primary" onClick={() => setStep(2)} disabled={phoneStatus !== 'available'}>
        {tr.continueBtn} →
      </button>
    </div>
  )

  if (step === 2) return (
    <div className="auth-form">
      <p className="auth-step-title">
        <button className="link-btn" onClick={() => setStep(1)}>← {tr.back}</button>
        &nbsp;·&nbsp;<strong>{phone}</strong>
      </p>
      <div className="field">
        <label>{tr.emailAddress}</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder={tr.emailPlaceholder} required autoFocus />
      </div>
      <div className="field">
        <label>{tr.choosePassword}</label>
        <PasswordInput
          value={pass}
          onChange={e => setPass(e.target.value)}
          placeholder={tr.minPasswordPlaceholder}
          showLabel={tr.showPassword}
          hideLabel={tr.hidePassword}
          required
        />
      </div>
      <div className="field">
        <label>{tr.selectLanguage}</label>
        <select value={pendingLang} onChange={e => setPendingLang(e.target.value)}>
          {languages.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button className="btn-primary" onClick={() => { setError(''); setStep(3) }}>
        {tr.continueBtn} â†’
      </button>
    </div>
  )

  if (step === 3) return (
    <div className="auth-form">
      <p className="auth-step-title">
        <button className="link-btn" onClick={() => setStep(2)}>â† {tr.back}</button>
        &nbsp;·&nbsp;<strong>{maskEmail(email)}</strong>
      </p>
      <div className="field">
        <label>{tr.nameLabel}</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={tr.namePlaceholder}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label>{tr.lastNameLabel} ({tr.optional})</label>
        <input
          type="text"
          value={lastName}
          onChange={e => setLastName(e.target.value)}
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
            value={birthDay}
            onChange={e => setBirthDay(e.target.value.replace(/\D/g, '').slice(0, 2))}
            placeholder={tr.dayLabel}
            required
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
      <button className="btn-primary" onClick={sendCode} disabled={sending}>
        {sending ? tr.sending : tr.sendVerifyCode}
      </button>
    </div>
  )

  return (
    <CodeStep email={email} expirySec={120}
      onVerify={verify} onResend={resend}
      onChangeEmail={() => setStep(2)} tr={tr} />
  )
}

// ── Forgot password flow ─────────────────────────────────────
function ForgotFlow({ tr, onBack }) {
  const [step, setStep]           = useState(1)
  const [input, setInput]         = useState('')
  const [foundUser, setFoundUser] = useState(null)
  const [foundEmail, setFoundEmail] = useState('')
  const [newPass, setNewPass]     = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [success, setSuccess]     = useState(false)

  const sendReset = async e => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const trimmed = input.trim()
      let userRow, email
      if (trimmed.includes('@')) {
        const snap = await getDocs(query(collection(db, 'users'), where('contactEmail', '==', trimmed)))
        if (snap.empty) throw new Error(tr.wrongCredentials)
        userRow = { id: snap.docs[0].id, ...snap.docs[0].data() }; email = trimmed
      } else {
        const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', trimmed)))
        if (snap.empty) throw new Error(tr.wrongCredentials)
        userRow = { id: snap.docs[0].id, ...snap.docs[0].data() }
        if (!userRow.contactEmail) throw new Error(tr.noEmailOnFile)
        email = userRow.contactEmail
      }
      const code = genCode()
      await storeCode(codeKey(email), code, 60_000, { uid: userRow.id, phoneNumber: userRow.phoneNumber, email })
      await sendEmailCode(email, code, 1, userRow.language || 'en')
      setFoundUser(userRow); setFoundEmail(email); setStep(2)
    } catch (e) { setError(getErrorMessage(e)) }
    finally { setLoading(false) }
  }

  const verify = async inputCode => {
    const res = await checkCode(codeKey(foundEmail), inputCode)
    if (!res.ok) return { error: res.reason === 'expired' ? tr.codeExpired : tr.wrongCode }
    setStep(3); return {}
  }

  const resend = async () => {
    const code = genCode()
    await storeCode(codeKey(foundEmail), code, 60_000, { uid: foundUser.id, phoneNumber: foundUser.phoneNumber, email: foundEmail })
    await sendEmailCode(foundEmail, code, 1, foundUser.language || 'en')
  }

  const setPassword = async e => {
    e.preventDefault()
    setError('')
    if (newPass !== confirmPass) { setError(tr.passwordsNoMatch); return }
    if (newPass.length < 6) { setError(tr.minPassword); return }
    setLoading(true)
    try {
      const stored = foundUser.adminPassword
      if (!stored) throw new Error(tr.noStoredPasswordFound)
      const cred = await signInWithEmailAndPassword(secondaryAuth, foundUser.authEmail || `${foundUser.phoneNumber}@chatapp.local`, stored)
      await updatePassword(cred.user, newPass)
      await signOut(secondaryAuth)
      const { updateDoc } = await import('firebase/firestore')
      await updateDoc(doc(db, 'users', foundUser.id), { adminPassword: newPass })
      await deleteDoc(doc(db, 'verificationCodes', codeKey(foundEmail)))
      await sendAccountEmailQuietly(foundEmail, 'passwordReset', foundUser.language || 'en', {
        phoneNumber: foundUser.phoneNumber,
      })
      setSuccess(true)
    } catch (e) { setError(getErrorMessage(e)) }
    finally { setLoading(false) }
  }

  if (success) return (
    <div className="auth-form" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 48 }}>✅</div>
      <div className="success-banner">{tr.resetSuccess}</div>
      <button className="btn-primary" onClick={onBack}>{tr.backToLogin}</button>
    </div>
  )

  if (step === 1) return (
    <form onSubmit={sendReset} className="auth-form">
      <p className="auth-step-title" style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
        {tr.resetPassword}
      </p>
      <div className="field">
        <label>{tr.enterPhoneOrEmail}</label>
        <input type="text" value={input} onChange={e => setInput(e.target.value)}
          placeholder={tr.phoneOrEmailPlaceholder} required autoFocus />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? '…' : tr.sendResetCode}
      </button>
      <button type="button" className="link-btn" onClick={onBack}>{tr.backToLogin}</button>
    </form>
  )

  if (step === 2) return (
    <CodeStep email={foundEmail} expirySec={60}
      onVerify={verify} onResend={resend}
      onChangeEmail={() => setStep(1)} tr={tr}
      submitLabel={tr.verifyAndReset} />
  )

  return (
    <form onSubmit={setPassword} className="auth-form">
      <p className="auth-step-title" style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
        {tr.resetPassword}
      </p>
      <div className="field">
        <label>{tr.newPassword}</label>
        <PasswordInput
          value={newPass}
          onChange={e => setNewPass(e.target.value)}
          showLabel={tr.showPassword}
          hideLabel={tr.hidePassword}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label>{tr.confirmNewPassword}</label>
        <PasswordInput
          value={confirmPass}
          onChange={e => setConfirmPass(e.target.value)}
          showLabel={tr.showPassword}
          hideLabel={tr.hidePassword}
          required
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? '…' : tr.verifyAndReset}
      </button>
    </form>
  )
}

// ── Main export ───────────────────────────────────────────────
export default function Login() {
  const { tr } = useAppContext()
  const [tab, setTab] = useState('login')

  return (
    <div className="auth-page">
      <LangThemePicker />
      <div className="auth-card">
        <div className="auth-logo"><GtyLogo size={68} /></div>
        <h1 className="auth-title">GtyChat</h1>
        <p className="auth-subtitle">{tr.appTagline}</p>

        {tab !== 'forgot' && (
          <div className="auth-tabs">
            <button className={`auth-tab ${tab === 'login' ? 'active' : ''}`} onClick={() => setTab('login')}>
              {tr.signIn}
            </button>
            <button className={`auth-tab ${tab === 'register' ? 'active' : ''}`} onClick={() => setTab('register')}>
              {tr.createAccount}
            </button>
          </div>
        )}

        {tab === 'login'    && <LoginForm    onForgot={() => setTab('forgot')} tr={tr} />}
        {tab === 'register' && <RegisterFlow tr={tr} />}
        {tab === 'forgot'   && <ForgotFlow   tr={tr} onBack={() => setTab('login')} />}
      </div>
    </div>
  )
}
