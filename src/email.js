import emailjs, { EmailJSResponseStatus } from '@emailjs/browser'

const emailConfig = {
  serviceId: import.meta.env.VITE_EMAILJS_SERVICE_ID,
  templateId: import.meta.env.VITE_EMAILJS_TEMPLATE_ID,
  publicKey: import.meta.env.VITE_EMAILJS_PUBLIC_KEY,
}

const missingEmailConfig = () =>
  Object.entries(emailConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key)

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

export const sendEmailCode = async (toEmail, code, expiryMins) => {
  const missing = missingEmailConfig()
  if (missing.length) {
    throw new Error(`Missing EmailJS config: ${missing.join(', ')}`)
  }

  const expiryText = `${expiryMins} minute${Number(expiryMins) === 1 ? '' : 's'}`
  const message = `Your GtyChat verification code is ${code}. It expires in ${expiryText}.`

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
        code,
        otp: code,
        passcode: code,
        verification_code: code,
        message,
        expiry: String(expiryMins),
        expiry_minutes: String(expiryMins),
        expiry_text: expiryText,
      },
      { publicKey: emailConfig.publicKey }
    )
  } catch (error) {
    throw new Error(getErrorMessage(error), { cause: error })
  }
}
