import { useState, useEffect, useRef } from 'react'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
} from 'firebase/auth'
import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where, serverTimestamp,
} from 'firebase/firestore'
import { auth, secondaryAuth, db, secondaryDb } from '../firebase'
import { sendEmailCode, getErrorMessage } from '../email'
import { GtyLogo } from '../App'
import { useAppContext } from '../context/AppContext'
import { buildBirthday } from '../profile'

// ── helpers ──────────────────────────────────────────────────
const genCode  = () => String(Math.floor(10000 + Math.random() * 90000))
const genPhone = () => String(Math.floor(1000000000 + Math.random() * 9000000000))
const codeKey  = email => email.replace(/\./g, ',').replace(/@/g, '--at--')
const isSignupPhone = value => /^\d{10}$/.test(value.trim())

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
        title="Toggle theme"
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
    const res = await onVerify(code.trim())
    if (res?.error) setError(res.error)
    setLoading(false)
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
        <p className="verify-sub">{tr.codeSentTo} <strong>{email}</strong></p>
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

  const handleLogin = async e => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const trimmed = input.trim()
      let authEmail
      if (trimmed.includes('@')) {
        const snap = await getDocs(query(collection(db, 'users'), where('contactEmail', '==', trimmed)))
        if (snap.empty) throw new Error()
        const userData = snap.docs[0].data()
        authEmail = userData.authEmail || `${userData.phoneNumber}@chatapp.local`
      } else {
        const snap = await getDocs(query(collection(db, 'users'), where('phoneNumber', '==', trimmed)))
        authEmail = snap.empty
          ? `${trimmed}@chatapp.local`
          : snap.docs[0].data().authEmail || `${trimmed}@chatapp.local`
      }
      await signInWithEmailAndPassword(auth, authEmail, pass)
    } catch {
      setError(tr.wrongCredentials)
    } finally {
      setLoading(false)
    }
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
        <input type="password" value={pass} onChange={e => setPass(e.target.value)} required />
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
      await sendEmailCode(email.trim(), code, 2)
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
    await sendEmailCode(email.trim(), code, 2)
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
        <input type="password" value={pass} onChange={e => setPass(e.target.value)}
          placeholder={tr.minPasswordPlaceholder} required />
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
        &nbsp;Â·&nbsp;<strong>{email}</strong>
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
      await sendEmailCode(email, code, 1)
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
    await sendEmailCode(foundEmail, code, 1)
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
        <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} required autoFocus />
      </div>
      <div className="field">
        <label>{tr.confirmNewPassword}</label>
        <input type="password" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} required />
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
