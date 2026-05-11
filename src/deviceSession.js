import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'

const DEVICE_ID_KEY = 'gtychat_device_id'

const randomId = () => {
  if (crypto?.randomUUID) return crypto.randomUUID()
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export const getDeviceId = () => {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = randomId()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

export const deviceRef = (database, uid, deviceId) =>
  doc(database, 'users', uid, 'devices', deviceId)

const browserName = ua => {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'Browser'
}

const osName = ua => {
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Device'
}

export const getDeviceInfo = () => {
  const ua = navigator.userAgent || ''
  const locale = navigator.language || ''
  const localeCountry = locale.includes('-') ? locale.split('-').pop()?.toUpperCase() : ''
  const timezoneCountry = Intl.DateTimeFormat().resolvedOptions().timeZone?.split('/')[0] || ''

  return {
    deviceLabel: `${browserName(ua)} on ${osName(ua)}`,
    country: localeCountry || timezoneCountry || 'Unknown',
    userAgent: ua,
    language: locale,
    platform: navigator.platform || '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  }
}

export const registerCurrentDevice = async user => {
  if (!user?.uid) return null
  const id = getDeviceId()
  await setDoc(deviceRef(db, user.uid, id), {
    id,
    ...getDeviceInfo(),
    active: true,
    loggedInAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  }, { merge: true })
  return id
}

export const markCurrentDeviceInactive = async user => {
  if (!user?.uid) return
  const id = getDeviceId()
  await updateDoc(deviceRef(db, user.uid, id), {
    active: false,
    loggedOutAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  }).catch(() => {})
}
