import emailjs, { EmailJSResponseStatus } from '@emailjs/browser'

const envValue = (...keys) => {
  const env = import.meta.env || {}
  for (const key of keys) {
    const value = env[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value) return value
  }
  return undefined
}

const emailConfig = {
  serviceId: envValue('VITE_EMAILJS_SERVICE_ID', 'VITE_EMAILJS_SERVICEID', 'VITE_EMAILJS_SERVICE'),
  templateId: envValue('VITE_EMAILJS_TEMPLATE_ID', 'VITE_EMAILJS_TEMPLATEID', 'VITE_EMAILJS_TEMPLATE'),
  publicKey: envValue('VITE_EMAILJS_PUBLIC_KEY', 'VITE_EMAILJS_PUBLIC_ID', 'VITE_EMAILJS_PUBLICID'),
}

const emailConfigLabels = {
  serviceId: 'VITE_EMAILJS_SERVICE_ID',
  templateId: 'VITE_EMAILJS_TEMPLATE_ID',
  publicKey: 'VITE_EMAILJS_PUBLIC_KEY',
}

const defaultLang = 'en'

const emailText = {
  en: {
    minutes: count => `${count} minute${Number(count) === 1 ? '' : 's'}`,
    codeSubject: 'Your GtyChat verification code',
    codeMessage: ({ code, expiryText }) =>
      `Your GtyChat verification code is ${code}. It expires in ${expiryText}.`,
    registeredSubject: 'Welcome to GtyChat',
    registeredMessage: ({ phoneNumber }) =>
      `Your GtyChat account was registered with phone number ${phoneNumber}.`,
    passwordChangedSubject: 'Your GtyChat password was changed',
    passwordChangedMessage: ({ phoneNumber }) =>
      `The password for GtyChat phone number ${phoneNumber} was changed. If this was not you, contact support immediately.`,
    passwordResetSubject: 'Your GtyChat password was reset',
    passwordResetMessage: ({ phoneNumber }) =>
      `The password for GtyChat phone number ${phoneNumber} was reset. If this was not you, contact support immediately.`,
    emailChangedOldSubject: 'Your GtyChat email address was changed',
    emailChangedOldMessage: ({ phoneNumber, newEmail }) =>
      `The email address for GtyChat phone number ${phoneNumber} was changed to ${newEmail}. If this was not you, contact support immediately.`,
    emailChangedNewSubject: 'This email is now connected to GtyChat',
    emailChangedNewMessage: ({ phoneNumber, newEmail }) =>
      `GtyChat phone number ${phoneNumber} changed its email address to ${newEmail}.`,
  },
  de: {
    minutes: count => `${count} Minute${Number(count) === 1 ? '' : 'n'}`,
    codeSubject: 'Dein GtyChat-Bestaetigungscode',
    codeMessage: ({ code, expiryText }) =>
      `Dein GtyChat-Bestaetigungscode ist ${code}. Er laeuft in ${expiryText} ab.`,
    registeredSubject: 'Willkommen bei GtyChat',
    registeredMessage: ({ phoneNumber }) =>
      `Dein GtyChat-Konto wurde mit der Telefonnummer ${phoneNumber} registriert.`,
    passwordChangedSubject: 'Dein GtyChat-Passwort wurde geaendert',
    passwordChangedMessage: ({ phoneNumber }) =>
      `Das Passwort fuer die GtyChat-Telefonnummer ${phoneNumber} wurde geaendert. Wenn du das nicht warst, kontaktiere sofort den Support.`,
    passwordResetSubject: 'Dein GtyChat-Passwort wurde zurueckgesetzt',
    passwordResetMessage: ({ phoneNumber }) =>
      `Das Passwort fuer die GtyChat-Telefonnummer ${phoneNumber} wurde zurueckgesetzt. Wenn du das nicht warst, kontaktiere sofort den Support.`,
    emailChangedOldSubject: 'Deine GtyChat-E-Mail-Adresse wurde geaendert',
    emailChangedOldMessage: ({ phoneNumber, newEmail }) =>
      `Die E-Mail-Adresse fuer die GtyChat-Telefonnummer ${phoneNumber} wurde zu ${newEmail} geaendert. Wenn du das nicht warst, kontaktiere sofort den Support.`,
    emailChangedNewSubject: 'Diese E-Mail ist jetzt mit GtyChat verbunden',
    emailChangedNewMessage: ({ phoneNumber, newEmail }) =>
      `Die GtyChat-Telefonnummer ${phoneNumber} hat ihre E-Mail-Adresse zu ${newEmail} geaendert.`,
  },
  fr: {
    minutes: count => `${count} minute${Number(count) === 1 ? '' : 's'}`,
    codeSubject: 'Votre code de verification GtyChat',
    codeMessage: ({ code, expiryText }) =>
      `Votre code de verification GtyChat est ${code}. Il expire dans ${expiryText}.`,
    registeredSubject: 'Bienvenue sur GtyChat',
    registeredMessage: ({ phoneNumber }) =>
      `Votre compte GtyChat a ete enregistre avec le numero ${phoneNumber}.`,
    passwordChangedSubject: 'Votre mot de passe GtyChat a ete modifie',
    passwordChangedMessage: ({ phoneNumber }) =>
      `Le mot de passe du numero GtyChat ${phoneNumber} a ete modifie. Si ce n'etait pas vous, contactez immediatement le support.`,
    passwordResetSubject: 'Votre mot de passe GtyChat a ete reinitialise',
    passwordResetMessage: ({ phoneNumber }) =>
      `Le mot de passe du numero GtyChat ${phoneNumber} a ete reinitialise. Si ce n'etait pas vous, contactez immediatement le support.`,
    emailChangedOldSubject: 'Votre adresse e-mail GtyChat a ete modifiee',
    emailChangedOldMessage: ({ phoneNumber, newEmail }) =>
      `L'adresse e-mail du numero GtyChat ${phoneNumber} a ete remplacee par ${newEmail}. Si ce n'etait pas vous, contactez immediatement le support.`,
    emailChangedNewSubject: 'Cette adresse e-mail est maintenant liee a GtyChat',
    emailChangedNewMessage: ({ phoneNumber, newEmail }) =>
      `Le numero GtyChat ${phoneNumber} a change son adresse e-mail en ${newEmail}.`,
  },
  ar: {
    minutes: count => `${count} دقيقة`,
    codeSubject: 'رمز التحقق من GtyChat',
    codeMessage: ({ code, expiryText }) =>
      `رمز التحقق الخاص بك في GtyChat هو ${code}. تنتهي صلاحيته خلال ${expiryText}.`,
    registeredSubject: 'مرحباً بك في GtyChat',
    registeredMessage: ({ phoneNumber }) =>
      `تم تسجيل حسابك في GtyChat برقم الهاتف ${phoneNumber}.`,
    passwordChangedSubject: 'تم تغيير كلمة مرور GtyChat',
    passwordChangedMessage: ({ phoneNumber }) =>
      `تم تغيير كلمة مرور رقم GtyChat ${phoneNumber}. إذا لم تكن أنت من قام بذلك، تواصل مع الدعم فوراً.`,
    passwordResetSubject: 'تمت إعادة تعيين كلمة مرور GtyChat',
    passwordResetMessage: ({ phoneNumber }) =>
      `تمت إعادة تعيين كلمة مرور رقم GtyChat ${phoneNumber}. إذا لم تكن أنت من قام بذلك، تواصل مع الدعم فوراً.`,
    emailChangedOldSubject: 'تم تغيير بريدك الإلكتروني في GtyChat',
    emailChangedOldMessage: ({ phoneNumber, newEmail }) =>
      `تم تغيير البريد الإلكتروني لرقم GtyChat ${phoneNumber} إلى ${newEmail}. إذا لم تكن أنت من قام بذلك، تواصل مع الدعم فوراً.`,
    emailChangedNewSubject: 'هذا البريد الإلكتروني مرتبط الآن بـ GtyChat',
    emailChangedNewMessage: ({ phoneNumber, newEmail }) =>
      `رقم GtyChat ${phoneNumber} غيّر بريده الإلكتروني إلى ${newEmail}.`,
  },
}

const getEmailText = lang => emailText[lang] || emailText[defaultLang]

const missingEmailConfig = () =>
  Object.entries(emailConfig)
    .filter(([, value]) => !value)
    .map(([key]) => emailConfigLabels[key] || key)

export const getErrorMessage = error => {
  if (!error) return 'Unknown error.'
  if (typeof error === 'string') return error
  if (error instanceof Error && error.message) return error.message

  const status = error.status ? ` (${error.status})` : ''
  if (error instanceof EmailJSResponseStatus || error.text) {
    return `${error.text || 'EmailJS request failed'}${status}`
  }
  if (error.message) return error.message

  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error.'
  }
}

const sendEmail = async (toEmail, params) => {
  const missing = missingEmailConfig()
  if (missing.length) {
    throw new Error(`Missing EmailJS config: ${missing.join(', ')}`)
  }

  try {
    return await emailjs.send(
      emailConfig.serviceId,
      emailConfig.templateId,
      {
        to_email: toEmail,
        to: toEmail,
        email: toEmail,
        user_email: toEmail,
        recipient_email: toEmail,
        reply_to: toEmail,
        to_name: toEmail.split('@')[0],
        app_name: 'GtyChat',
        ...params,
      },
      { publicKey: emailConfig.publicKey }
    )
  } catch (error) {
    throw new Error(getErrorMessage(error), { cause: error })
  }
}

export const sendEmailCode = async (toEmail, code, expiryMins, lang = defaultLang) => {
  const text = getEmailText(lang)
  const expiryText = text.minutes(expiryMins)
  const subject = text.codeSubject
  const message = text.codeMessage({ code, expiryText })

  return sendEmail(toEmail, {
    email_type: 'verification_code',
    language: lang,
    subject,
    title: subject,
    code,
    otp: code,
    passcode: code,
    verification_code: code,
    message,
    body: message,
    expiry: String(expiryMins),
    expiry_minutes: String(expiryMins),
    expiry_text: expiryText,
  })
}

export const sendAccountEmail = async (toEmail, type, lang = defaultLang, details = {}) => {
  const text = getEmailText(lang)
  const subjectKey = `${type}Subject`
  const messageKey = `${type}Message`
  const subject = text[subjectKey] || emailText[defaultLang][subjectKey]
  const messageBuilder = text[messageKey] || emailText[defaultLang][messageKey]

  if (!subject || !messageBuilder) {
    throw new Error(`Unknown account email type: ${type}`)
  }

  const message = messageBuilder(details)
  return sendEmail(toEmail, {
    email_type: type,
    language: lang,
    subject,
    title: subject,
    message,
    body: message,
    phone_number: details.phoneNumber || '',
    old_email: details.oldEmail || '',
    new_email: details.newEmail || '',
  })
}
