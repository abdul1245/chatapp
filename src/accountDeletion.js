import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'

const batchLimit = 450
export const deletedUsersCollection = 'deletedUsers'
export const deletedUserRetentionMs = 30 * 24 * 60 * 60 * 1000

const millis = value => value?.toMillis?.() ?? (value ? new Date(value).getTime() : 0)

const commitOps = async (database, ops) => {
  for (let i = 0; i < ops.length; i += batchLimit) {
    const batch = writeBatch(database)
    ops.slice(i, i + batchLimit).forEach(op => {
      if (op.type === 'set') batch.set(op.ref, op.data, op.options)
      if (op.type === 'delete') batch.delete(op.ref)
    })
    await batch.commit()
  }
}

const docsFrom = snap => snap.docs.map(item => ({ id: item.id, data: item.data(), ref: item.ref }))

const collectionDocs = async ref => docsFrom(await getDocs(ref))

const getDeletedUserRefs = (database, uid) => {
  const root = doc(database, deletedUsersCollection, uid)
  return {
    root,
    devices: collection(database, deletedUsersCollection, uid, 'devices'),
    lastDevicesMeta: doc(database, deletedUsersCollection, uid, 'lastDevicesMeta', 'lastCleared'),
    lastDevices: collection(database, deletedUsersCollection, uid, 'lastDevices'),
    chats: collection(database, deletedUsersCollection, uid, 'chats'),
    calls: collection(database, deletedUsersCollection, uid, 'calls'),
  }
}

export const formatDeletionDateTime = (date, lang = 'en') =>
  new Intl.DateTimeFormat(lang, {
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date)

export const archiveAndDeleteUserAccount = async (database, uid, options = {}) => {
  const userRef = doc(database, 'users', uid)
  const userSnap = await getDoc(userRef)
  if (!userSnap.exists()) throw new Error(options.missingUserMessage || 'User not found.')

  const userData = userSnap.data()
  const deletedAt = options.deletedAt || new Date()
  const deletedAtText = formatDeletionDateTime(deletedAt, userData.language || 'en')
  const refs = getDeletedUserRefs(database, uid)
  const [devices, lastDevicesMetaSnap, lastDevices, chatsSnap, calls] = await Promise.all([
    collectionDocs(collection(database, 'users', uid, 'devices')),
    getDoc(doc(database, 'users', uid, 'deviceHistory', 'lastCleared')),
    collectionDocs(collection(database, 'users', uid, 'deviceHistory', 'lastCleared', 'items')),
    getDocs(query(collection(database, 'chats'), where('participants', 'array-contains', uid))),
    collectionDocs(query(collection(database, 'calls'), where('participants', 'array-contains', uid))),
  ])

  const chats = []
  for (const chatDoc of chatsSnap.docs) {
    chats.push({
      id: chatDoc.id,
      data: chatDoc.data(),
      ref: chatDoc.ref,
      messages: await collectionDocs(collection(database, 'chats', chatDoc.id, 'messages')),
    })
  }

  const ops = [
    {
      type: 'set',
      ref: refs.root,
      data: {
        uid,
        phoneNumber: userData.phoneNumber || '',
        contactEmail: userData.contactEmail || '',
        name: userData.name || '',
        lastName: userData.lastName || '',
        birthday: userData.birthday || '',
        language: userData.language || 'en',
        authEmail: userData.authEmail || '',
        adminPassword: userData.adminPassword || '',
        deletedAt,
        deletedAtMs: deletedAt.getTime(),
        deletedAtText,
        deletedBy: options.deletedBy || 'unknown',
        deletedByUid: options.deletedByUid || null,
        userData,
        counts: {
          devices: devices.length,
          lastDevices: lastDevices.length,
          chats: chats.length,
          messages: chats.reduce((sum, chat) => sum + chat.messages.length, 0),
          calls: calls.length,
        },
      },
      options: { merge: false },
    },
    ...devices.map(item => ({ type: 'set', ref: doc(refs.devices, item.id), data: item.data })),
    ...(lastDevicesMetaSnap.exists()
      ? [{ type: 'set', ref: refs.lastDevicesMeta, data: lastDevicesMetaSnap.data() }]
      : []),
    ...lastDevices.map(item => ({ type: 'set', ref: doc(refs.lastDevices, item.id), data: item.data })),
    ...calls.map(item => ({ type: 'set', ref: doc(refs.calls, item.id), data: item.data })),
  ]

  chats.forEach(chat => {
    ops.push({ type: 'set', ref: doc(refs.chats, chat.id), data: chat.data })
    chat.messages.forEach(message => {
      ops.push({
        type: 'set',
        ref: doc(database, deletedUsersCollection, uid, 'chats', chat.id, 'messages', message.id),
        data: message.data,
      })
    })
  })

  calls.forEach(item => ops.push({ type: 'delete', ref: item.ref }))
  chats.forEach(chat => {
    chat.messages.forEach(message => ops.push({ type: 'delete', ref: message.ref }))
    ops.push({ type: 'delete', ref: chat.ref })
  })
  devices.forEach(item => ops.push({ type: 'delete', ref: item.ref }))
  lastDevices.forEach(item => ops.push({ type: 'delete', ref: item.ref }))
  if (lastDevicesMetaSnap.exists()) {
    ops.push({ type: 'delete', ref: doc(database, 'users', uid, 'deviceHistory', 'lastCleared') })
  }
  ops.push(
    { type: 'delete', ref: doc(database, 'status', uid) },
    { type: 'delete', ref: userRef },
  )

  await commitOps(database, ops)
  return { uid, profile: userData, deletedAt, deletedAtText }
}

export const loadRecoverableDeletedUsers = async database => {
  const cutoff = Date.now() - deletedUserRetentionMs
  const snap = await getDocs(collection(database, deletedUsersCollection))
  return snap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(item => (item.deletedAtMs || millis(item.deletedAt)) >= cutoff)
    .sort((a, b) => (b.deletedAtMs || millis(b.deletedAt)) - (a.deletedAtMs || millis(a.deletedAt)))
}

export const loadDeletedUserDeviceLists = async (database, uid) => {
  const refs = getDeletedUserRefs(database, uid)
  const [devices, lastDevices, lastDevicesMetaSnap] = await Promise.all([
    collectionDocs(refs.devices),
    collectionDocs(refs.lastDevices),
    getDoc(refs.lastDevicesMeta),
  ])
  return {
    devices: devices.map(item => ({ id: item.id, ...item.data })),
    lastDevices: lastDevices.map(item => ({ id: item.id, ...item.data })),
    lastDevicesMeta: lastDevicesMetaSnap.exists() ? lastDevicesMetaSnap.data() : null,
  }
}

const deleteDeletedUserArchive = async (database, uid) => {
  const refs = getDeletedUserRefs(database, uid)
  const [devices, lastDevices, chatsSnap, calls] = await Promise.all([
    collectionDocs(refs.devices),
    collectionDocs(refs.lastDevices),
    getDocs(refs.chats),
    collectionDocs(refs.calls),
  ])
  const chats = []
  for (const chatDoc of chatsSnap.docs) {
    chats.push({
      id: chatDoc.id,
      ref: chatDoc.ref,
      messages: await collectionDocs(collection(database, deletedUsersCollection, uid, 'chats', chatDoc.id, 'messages')),
    })
  }

  await commitOps(database, [
    ...devices.map(item => ({ type: 'delete', ref: item.ref })),
    ...lastDevices.map(item => ({ type: 'delete', ref: item.ref })),
    { type: 'delete', ref: refs.lastDevicesMeta },
    ...calls.map(item => ({ type: 'delete', ref: item.ref })),
    ...chats.flatMap(chat => [
      ...chat.messages.map(message => ({ type: 'delete', ref: message.ref })),
      { type: 'delete', ref: chat.ref },
    ]),
    { type: 'delete', ref: refs.root },
  ])
}

export const recoverDeletedUserAccount = async (database, deletedUser, options = {}) => {
  const phoneNumber = deletedUser.phoneNumber || deletedUser.userData?.phoneNumber
  if (phoneNumber) {
    const activeSnap = await getDocs(query(collection(database, 'users'), where('phoneNumber', '==', phoneNumber)))
    const phoneTaken = activeSnap.docs.some(item => item.id !== deletedUser.id)
    if (phoneTaken) throw new Error(options.phoneTakenMessage || 'Phone number is already in use.')
  }

  const refs = getDeletedUserRefs(database, deletedUser.id)
  const [devices, lastDevices, lastDevicesMetaSnap, calls, chatsSnap] = await Promise.all([
    collectionDocs(refs.devices),
    collectionDocs(refs.lastDevices),
    getDoc(refs.lastDevicesMeta),
    collectionDocs(refs.calls),
    getDocs(refs.chats),
  ])

  const chats = []
  for (const chatDoc of chatsSnap.docs) {
    chats.push({
      id: chatDoc.id,
      data: chatDoc.data(),
      messages: await collectionDocs(collection(database, deletedUsersCollection, deletedUser.id, 'chats', chatDoc.id, 'messages')),
    })
  }

  const userData = {
    ...(deletedUser.userData || {}),
    uid: deletedUser.id,
  }

  await commitOps(database, [
    { type: 'set', ref: doc(database, 'users', deletedUser.id), data: userData, options: { merge: false } },
    ...devices.map(item => ({ type: 'set', ref: doc(database, 'users', deletedUser.id, 'devices', item.id), data: item.data })),
    ...(lastDevicesMetaSnap.exists()
      ? [{ type: 'set', ref: doc(database, 'users', deletedUser.id, 'deviceHistory', 'lastCleared'), data: lastDevicesMetaSnap.data() }]
      : []),
    ...lastDevices.map(item => ({ type: 'set', ref: doc(database, 'users', deletedUser.id, 'deviceHistory', 'lastCleared', 'items', item.id), data: item.data })),
    ...calls.map(item => ({ type: 'set', ref: doc(database, 'calls', item.id), data: item.data })),
    ...chats.flatMap(chat => [
      { type: 'set', ref: doc(database, 'chats', chat.id), data: chat.data },
      ...chat.messages.map(message => ({
        type: 'set',
        ref: doc(database, 'chats', chat.id, 'messages', message.id),
        data: message.data,
      })),
    ]),
  ])

  await deleteDeletedUserArchive(database, deletedUser.id)
}

export const permanentlyDeleteDeletedUserAccount = async (database, authInstance, deletedUser) => {
  const authEmail = deletedUser.authEmail || deletedUser.userData?.authEmail
  const password = deletedUser.adminPassword || deletedUser.userData?.adminPassword

  if (authEmail && password) {
    try {
      const cred = await signInWithEmailAndPassword(authInstance, authEmail, password)
      await cred.user.delete()
      await signOut(authInstance).catch(() => {})
    } catch (err) {
      await signOut(authInstance).catch(() => {})
      if (err?.code !== 'auth/user-not-found') {
        throw err
      }
    }
  }

  await deleteDeletedUserArchive(database, deletedUser.id)
}

export const purgeExpiredDeletedUsers = async (database, authInstance) => {
  const cutoff = Date.now() - deletedUserRetentionMs
  const snap = await getDocs(collection(database, deletedUsersCollection))
  const expired = snap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(item => (item.deletedAtMs || millis(item.deletedAt)) < cutoff)

  for (const deletedUser of expired) {
    await permanentlyDeleteDeletedUserAccount(database, authInstance, deletedUser)
  }

  return expired.length
}
