import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AgoraRTC from 'agora-rtc-sdk-ng'
import {
  collection, doc, getDoc, onSnapshot, query,
  arrayRemove, runTransaction, serverTimestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore'
import { db } from '../firebase'
import { buildDisplayName } from '../profile'
import { useAppContext } from '../context/AppContext'

const AGORA_APP_ID = import.meta.env.VITE_AGORA_APP_ID || '44b55e8620e8421b9be760862e6a2a7e'
const OPEN_STATUSES = new Set(['ringing', 'active'])
const RING_TIMEOUT_MS = 30_000
const REMOTE_NORMAL_VOLUME = 55
const REMOTE_SPEAKER_VOLUME = 100
const FRONT_CAMERA_FACING_MODE = 'user'
const REAR_CAMERA_FACING_MODE = 'environment'

const millisFromTimestamp = value => value?.toMillis?.() ?? 0
const formatText = (template, values = {}) =>
  Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, value), template || '')
const callKindText = (callType, tr) => callType === 'video' ? tr.callKindVideo : tr.callKindVoice
const displayNameOrFallback = (tr, ...values) => {
  const value = values.find(item => String(item || '').trim())
  return String(value || tr.unknownUser).trim()
}
const callStatusText = (status, tr) => ({
  ringing: tr.callStatusRinging,
  accepted: tr.callStatusAccepted,
  declined: tr.callStatusDeclined,
  canceled: tr.callStatusCanceled,
  unanswered: tr.callStatusUnanswered,
  ended: tr.callStatusAcceptedEnded,
  failed: tr.callStatusFailed,
  left: tr.callStatusEnded,
}[status] || status)
const buildCallMessageText = (call, callStatus, tr) => {
  const caller = displayNameOrFallback(tr, call.callerName, call.callerPhone)
  const receiver = displayNameOrFallback(tr, call.receiverName, call.receiverPhone)
  return formatText(tr.callMessageText, {
    caller,
    receiver,
    kind: callKindText(call.type, tr),
    status: callStatusText(callStatus, tr),
  })
}
const chatBlocksEitherUser = (chat, firstUserId, secondUserId) => {
  const blockedBy = chat?.blockedBy || []
  return blockedBy.includes(firstUserId) || blockedBy.includes(secondUserId)
}
const getFinalCallStatus = (call, reason) => {
  if (reason === 'declined') return 'declined'
  if (reason === 'canceled') return 'canceled'
  if (reason === 'unanswered') return 'unanswered'
  if (reason === 'media-failed') return 'failed'
  if (reason === 'left') return call.acceptedAt ? 'left' : 'canceled'
  return call.acceptedAt ? 'ended' : 'canceled'
}

const getRingingStartedAt = call =>
  millisFromTimestamp(call?.createdAt) || millisFromTimestamp(call?.updatedAt) || Date.now()
const getRemotePlaybackVolume = (silenced, speaker) =>
  silenced ? 0 : speaker ? REMOTE_SPEAKER_VOLUME : REMOTE_NORMAL_VOLUME

const describeMediaError = (err, callType, tr) => {
  const code = err?.code || err?.name || ''
  const message = err?.message || ''
  const detail = [code, message].filter(Boolean).join(': ')

  if (!window.isSecureContext) {
    return tr.mediaSecurePage
  }

  if (/permission|notallowed/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? tr.cameraMicPermissionBlocked
      : tr.micPermissionBlocked
  }

  if (/notfound|devices_not_found/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? tr.noCameraMicFound
      : tr.noMicFound
  }

  if (/notreadable|track_start/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? tr.cameraMicInUse
      : tr.micInUse
  }

  return detail
    ? formatText(tr.couldNotStartCallWithDetail, { type: callType, detail })
    : formatText(tr.couldNotStartCallType, { type: callType })
}

const createCameraVideoTrack = (facingMode = FRONT_CAMERA_FACING_MODE) =>
  AgoraRTC.createCameraVideoTrack({ facingMode })

const createLocalTracks = async (callType, existingVideoTrack = null) => {
  const audioTrack = await AgoraRTC.createMicrophoneAudioTrack({
    encoderConfig: 'speech_standard',
  })

  if (callType !== 'video') return { tracks: [audioTrack], videoError: null }

  if (existingVideoTrack) return { tracks: [audioTrack, existingVideoTrack], videoError: null }

  try {
    const videoTrack = await createCameraVideoTrack()
    return { tracks: [audioTrack, videoTrack], videoError: null }
  } catch (err) {
    return { tracks: [audioTrack], videoError: err }
  }
}

const describeCameraError = (err, tr) => {
  const code = err?.code || err?.name || ''
  const message = err?.message || ''

  if (/permission|notallowed/i.test(`${code} ${message}`)) {
    return tr.cameraPermissionBlocked
  }

  if (/notfound|devices_not_found/i.test(`${code} ${message}`)) {
    return tr.noCameraFound
  }

  if (/notreadable|track_start/i.test(`${code} ${message}`)) {
    return tr.cameraInUse
  }

  return tr.couldNotTurnOnCamera
}

const findLocalTrack = (tracks, mediaType) => tracks.find(track => track.trackMediaType === mediaType)
const videoCorners = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const oppositeVideoSource = source => source === 'local' ? 'remote' : 'local'

function RemoteVideo({ user, className = 'call-video call-video-remote' }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !user.videoTrack) return undefined
    user.videoTrack.play(ref.current)
    return () => user.videoTrack?.stop()
  }, [user])

  return <div className={className} ref={ref} />
}

function SwitchCameraButton({ facingMode, switching, onSwitch, tr }) {
  const label = facingMode === FRONT_CAMERA_FACING_MODE ? tr.switchRearCamera : tr.switchFrontCamera
  return (
    <button
      type="button"
      className="switch-camera-btn"
      onClick={e => {
        e.stopPropagation()
        onSwitch()
      }}
      onPointerDown={e => e.stopPropagation()}
      disabled={switching}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19" aria-hidden="true">
        <path d="M20 5h-3.17l-1.24-1.35A2 2 0 0014.12 3H9.88a2 2 0 00-1.47.65L7.17 5H4a2 2 0 00-2 2v11a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2zm-8 13a5 5 0 01-4.48-2.78l1.55-.63A3.33 3.33 0 0012 16.33c1.07 0 2.02-.5 2.63-1.28H12v-1.67h5v5h-1.67v-1.9A4.95 4.95 0 0112 18zm4.48-9.22-1.55.63A3.33 3.33 0 0012 7.67c-1.07 0-2.02.5-2.63 1.28H12v1.67H7v-5h1.67v1.9A4.95 4.95 0 0112 6a5 5 0 014.48 2.78z" />
      </svg>
    </button>
  )
}

export default function CallManager({ user, request }) {
  const { tr } = useAppContext()
  const [currentCall, setCurrentCall] = useState(null)
  const [remoteUsers, setRemoteUsers] = useState([])
  const [otherProfileState, setOtherProfileState] = useState(null)
  const [callError, setCallError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [localVideoReady, setLocalVideoReady] = useState(false)
  const [localMicOn, setLocalMicOn] = useState(true)
  const [localCameraOn, setLocalCameraOn] = useState(false)
  const [cameraFacingMode, setCameraFacingMode] = useState(FRONT_CAMERA_FACING_MODE)
  const [switchingCamera, setSwitchingCamera] = useState(false)
  const [speakerOn, setSpeakerOn] = useState(false)
  const [remoteSilenced, setRemoteSilenced] = useState(false)
  const [mediaNotice, setMediaNotice] = useState('')
  const [ringTimeLeft, setRingTimeLeft] = useState(RING_TIMEOUT_MS)
  const [featuredVideo, setFeaturedVideo] = useState('remote')
  const [previewCorner, setPreviewCorner] = useState('bottom-right')
  const [previewDrag, setPreviewDrag] = useState(null)

  const clientRef = useRef(null)
  const localTracksRef = useRef([])
  const remoteAudioTracksRef = useRef(new Map())
  const speakerOnRef = useRef(false)
  const remoteSilencedRef = useRef(false)
  const cameraFacingModeRef = useRef(FRONT_CAMERA_FACING_MODE)
  const joinedCallIdRef = useRef(null)
  const joiningCallIdRef = useRef(null)
  const localVideoRef = useRef(null)
  const callStageRef = useRef(null)
  const previewRef = useRef(null)
  const handledRequestIdRef = useRef(null)
  const autoEndingCallIdRef = useRef(null)
  const previewMovedRef = useRef(false)

  const currentCallRef = useRef(null)
  useEffect(() => {
    currentCallRef.current = currentCall
  }, [currentCall])

  useEffect(() => {
    cameraFacingModeRef.current = cameraFacingMode
  }, [cameraFacingMode])

  const otherUserId = useMemo(() => {
    if (!currentCall) return null
    return currentCall.callerId === user.uid ? currentCall.receiverId : currentCall.callerId
  }, [currentCall, user.uid])
  const otherProfile = otherProfileState?.id === otherUserId ? otherProfileState.data : null
  const activeCallId = currentCall?.id
  const activeCallStatus = currentCall?.status

  const otherName = useMemo(() => {
    if (!currentCall) return ''
    if (otherProfile) return buildDisplayName(otherProfile) || otherProfile.phoneNumber || tr.unknownUser
    if (currentCall.callerId === user.uid) return currentCall.receiverName || currentCall.receiverPhone || tr.unknownUser
    return currentCall.callerName || currentCall.callerPhone || tr.unknownUser
  }, [currentCall, otherProfile, tr.unknownUser, user.uid])

  const isIncomingRinging = currentCall?.status === 'ringing' && currentCall.receiverId === user.uid
  const isOutgoingRinging = currentCall?.status === 'ringing' && currentCall.callerId === user.uid
  const isActive = currentCall?.status === 'active'
  const isVideoCall = currentCall?.type === 'video'
  const isOutgoingVideoRinging = isOutgoingRinging && isVideoCall
  const showVideoStage = (isActive && (isVideoCall || localCameraOn || remoteUsers.length > 0))
    || (isOutgoingVideoRinging && localCameraOn)
  const remoteVideoUser = remoteUsers.find(remoteUser => remoteUser.videoTrack) || null
  const hasRemoteVideo = Boolean(remoteVideoUser)
  const hasLocalVideo = Boolean(localCameraOn && localVideoReady)
  const featuredSource = featuredVideo === 'local' && hasLocalVideo ? 'local'
    : featuredVideo === 'remote' && hasRemoteVideo ? 'remote'
    : hasRemoteVideo ? 'remote'
    : hasLocalVideo ? 'local'
    : 'waiting'
  const previewSource = oppositeVideoSource(featuredSource)
  const showPreview = showVideoStage && (
    (previewSource === 'local' && hasLocalVideo)
    || (previewSource === 'remote' && hasRemoteVideo)
    || (featuredSource === 'remote' && !hasLocalVideo)
  )
  const otherControls = otherUserId ? currentCall?.participantControls?.[otherUserId] : null
  const otherMicMuted = Boolean(otherControls?.micMuted)
  const otherSilencerOn = Boolean(otherControls?.silencerOn)

  useEffect(() => {
    speakerOnRef.current = speakerOn
    remoteSilencedRef.current = remoteSilenced
    const volume = getRemotePlaybackVolume(remoteSilenced, speakerOn)
    remoteAudioTracksRef.current.forEach(track => {
      track.setVolume?.(volume)
      track.play?.()
    })
  }, [remoteSilenced, speakerOn])

  useEffect(() => {
    if (!showVideoStage) return
    let active = true
    if (featuredVideo === 'remote' && !hasRemoteVideo && hasLocalVideo) {
      queueMicrotask(() => active && setFeaturedVideo('local'))
    } else if (featuredVideo === 'local' && !hasLocalVideo && hasRemoteVideo) {
      queueMicrotask(() => active && setFeaturedVideo('remote'))
    }
    return () => {
      active = false
    }
  }, [featuredVideo, hasLocalVideo, hasRemoteVideo, showVideoStage])

  useEffect(() => {
    if (!activeCallId) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setFeaturedVideo('remote')
      setPreviewCorner('bottom-right')
      setPreviewDrag(null)
    })
    return () => {
      active = false
    }
  }, [activeCallId])

  useEffect(() => {
    if (!activeCallId || !isOutgoingVideoRinging) return undefined

    let cancelled = false
    const ensureOutgoingVideoPreview = async () => {
      const existingTrack = findLocalTrack(localTracksRef.current, 'video')
      if (existingTrack) {
        setLocalCameraOn(true)
        setLocalVideoReady(true)
        setCameraFacingMode(cameraFacingModeRef.current)
        return
      }

      try {
        const videoTrack = await createCameraVideoTrack(FRONT_CAMERA_FACING_MODE)
        if (cancelled || currentCallRef.current?.id !== activeCallId || currentCallRef.current?.status !== 'ringing') {
          videoTrack.stop()
          videoTrack.close()
          return
        }
        localTracksRef.current = [...localTracksRef.current, videoTrack]
        setLocalCameraOn(true)
        setLocalVideoReady(true)
        setCameraFacingMode(FRONT_CAMERA_FACING_MODE)
        setMediaNotice('')
      } catch (err) {
        if (cancelled) return
        console.warn('Outgoing video preview failed:', err)
        setLocalCameraOn(false)
        setLocalVideoReady(false)
        setMediaNotice(describeCameraError(err, tr))
      }
    }

    ensureOutgoingVideoPreview()

    return () => {
      cancelled = true
    }
  }, [activeCallId, isOutgoingVideoRinging, tr])

  const updateCallAndMessage = useCallback(async (call, callPatch, callStatus, options = {}) => {
    const callRef = doc(db, 'calls', call.id)
    const hasCallMessage = Boolean(call.chatId && call.callMessageId)
    const chatRef = hasCallMessage ? doc(db, 'chats', call.chatId) : null
    const messageRef = hasCallMessage ? doc(db, 'chats', call.chatId, 'messages', call.callMessageId) : null
    const text = buildCallMessageText(call, callStatus, tr)
    const lastMessage = {
      text,
      type: 'call',
      timestamp: serverTimestamp(),
      senderId: call.callerId,
      callId: call.id,
      callType: call.type,
      callStatus,
    }

    return await runTransaction(db, async transaction => {
      const callSnap = await transaction.get(callRef)
      const chatSnap = chatRef ? await transaction.get(chatRef) : null
      if (!callSnap.exists()) return false
      if (options.expectedStatus && callSnap.data().status !== options.expectedStatus) return false
      if (options.preventIfBlocked && chatSnap?.exists() && chatBlocksEitherUser(chatSnap.data(), call.callerId, call.receiverId)) {
        return false
      }
      transaction.update(callRef, callPatch)

      if (!messageRef) return true

      transaction.update(messageRef, {
        text,
        callStatus,
        updatedAt: serverTimestamp(),
      })

      if (!chatSnap?.exists()) return true

      const currentLast = chatSnap.data().lastMessage
      if (!currentLast || currentLast.callId === call.id) {
        transaction.update(chatRef, {
          lastMessage,
          hiddenFor: arrayRemove(call.callerId, call.receiverId),
          clearedFor: arrayRemove(call.callerId, call.receiverId),
        })
      }
      return true
    })
  }, [tr])

  const updateLocalCallControls = useCallback(patch => {
    const call = currentCallRef.current
    if (!call?.id) return Promise.resolve()
    const updates = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [`participantControls.${user.uid}.${key}`, value])
    )
    return updateDoc(doc(db, 'calls', call.id), updates).catch(err => {
      console.warn('Call control state update failed:', err)
    })
  }, [user.uid])

  const leaveAgora = useCallback(async () => {
    localTracksRef.current.forEach(track => {
      track.stop()
      track.close()
    })
    localTracksRef.current = []
    remoteAudioTracksRef.current.clear()
    speakerOnRef.current = false
    remoteSilencedRef.current = false
    setLocalVideoReady(false)
    setLocalMicOn(true)
    setLocalCameraOn(false)
    setCameraFacingMode(FRONT_CAMERA_FACING_MODE)
    setSwitchingCamera(false)
    setSpeakerOn(false)
    setRemoteSilenced(false)
    setMediaNotice('')
    setRemoteUsers([])

    if (clientRef.current && joinedCallIdRef.current) {
      try {
        await clientRef.current.leave()
      } catch (err) {
        console.warn('Agora leave failed:', err)
      }
    }
    joinedCallIdRef.current = null
    joiningCallIdRef.current = null
  }, [])

  const getClient = useCallback(() => {
    if (clientRef.current) return clientRef.current

    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })
    client.on('user-published', async (remoteUser, mediaType) => {
      try {
        await client.subscribe(remoteUser, mediaType)
        if (mediaType === 'audio' && remoteUser.audioTrack) {
          remoteUser.audioTrack.setVolume?.(getRemotePlaybackVolume(remoteSilencedRef.current, speakerOnRef.current))
          remoteUser.audioTrack.play()
          remoteAudioTracksRef.current.set(remoteUser.uid, remoteUser.audioTrack)
        }
        if (mediaType === 'video') {
          setRemoteUsers(prev => {
            const withoutUser = prev.filter(item => item.uid !== remoteUser.uid)
            return [...withoutUser, remoteUser]
          })
        }
      } catch (err) {
        console.warn('Agora subscribe failed:', err)
      }
    })
    client.on('user-unpublished', (remoteUser, mediaType) => {
      if (mediaType === 'audio') remoteAudioTracksRef.current.delete(remoteUser.uid)
      if (mediaType === 'video') {
        setRemoteUsers(prev => prev.filter(item => item.uid !== remoteUser.uid))
      }
    })
    client.on('user-left', remoteUser => {
      remoteAudioTracksRef.current.delete(remoteUser.uid)
      setRemoteUsers(prev => prev.filter(item => item.uid !== remoteUser.uid))
    })
    clientRef.current = client
    return client
  }, [])

  const endFirestoreCall = useCallback(async (reason = 'ended') => {
    const call = currentCallRef.current
    if (!call) return
    let shouldCloseLocalCall = true
    try {
      const updated = await updateCallAndMessage(call, {
        status: 'ended',
        endReason: reason,
        endedBy: user.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, getFinalCallStatus(call, reason), reason === 'unanswered' ? { expectedStatus: 'ringing' } : {})
      shouldCloseLocalCall = updated !== false
    } catch (err) {
      console.warn('Call end update failed:', err)
    } finally {
      if (shouldCloseLocalCall) {
        await leaveAgora()
        setCurrentCall(null)
      }
    }
  }, [leaveAgora, updateCallAndMessage, user.uid])

  const joinAgora = useCallback(async call => {
    if (joinedCallIdRef.current === call.id) return
    if (joiningCallIdRef.current === call.id) return

    joiningCallIdRef.current = call.id
    if (joinedCallIdRef.current && joinedCallIdRef.current !== call.id) {
      await leaveAgora()
      joiningCallIdRef.current = call.id
    }
    setCallError('')
    const client = getClient()

    try {
      const existingVideoTrack = call.type === 'video'
        ? findLocalTrack(localTracksRef.current, 'video')
        : null
      const { tracks, videoError } = await createLocalTracks(call.type, existingVideoTrack)
      localTracksRef.current = tracks
      await client.join(AGORA_APP_ID, call.channelName, null, user.uid)
      await client.publish(tracks)
      joinedCallIdRef.current = call.id
      const hasVideoTrack = Boolean(findLocalTrack(tracks, 'video'))
      setLocalMicOn(true)
      setLocalCameraOn(hasVideoTrack)
      setLocalVideoReady(hasVideoTrack)
      setCameraFacingMode(FRONT_CAMERA_FACING_MODE)
      setMediaNotice(videoError ? describeCameraError(videoError, tr) : '')
      updateLocalCallControls({ micMuted: false, silencerOn: remoteSilencedRef.current })
    } catch (err) {
      console.error('Agora join failed:', err)
      localTracksRef.current.forEach(track => {
        track.stop()
        track.close()
      })
      localTracksRef.current = []
      setLocalMicOn(true)
      setLocalCameraOn(false)
      setLocalVideoReady(false)
      setCameraFacingMode(FRONT_CAMERA_FACING_MODE)
      try {
        await client.leave()
      } catch { /* ignore cleanup failure */ }
      setCallError(describeMediaError(err, call.type, tr))
      await endFirestoreCall('media-failed')
    } finally {
      if (joiningCallIdRef.current === call.id) {
        joiningCallIdRef.current = null
      }
    }
  }, [endFirestoreCall, getClient, leaveAgora, tr, updateLocalCallControls, user.uid])

  useEffect(() => {
    const callsQuery = query(collection(db, 'calls'), where('participants', 'array-contains', user.uid))
    const unsub = onSnapshot(callsQuery, snap => {
      const openCalls = snap.docs
        .map(callDoc => ({ id: callDoc.id, ...callDoc.data() }))
        .filter(call => OPEN_STATUSES.has(call.status))
        .sort((a, b) => millisFromTimestamp(b.updatedAt || b.createdAt) - millisFromTimestamp(a.updatedAt || a.createdAt))

      const nextCall = openCalls.find(call => call.status === 'active') || openCalls[0] || null
      setCurrentCall(nextCall)
      if (!nextCall) leaveAgora()
    }, err => {
      console.error('Call listener failed:', err)
    })

    return () => unsub()
  }, [leaveAgora, user.uid])

  useEffect(() => {
    if (!request || request.id === handledRequestIdRef.current) return
    handledRequestIdRef.current = request.id

    const startCall = async () => {
      if (currentCallRef.current) return

      try {
        const chatSnap = await getDoc(doc(db, 'chats', request.chat.id))
        if (!chatSnap.exists()) throw new Error(tr.chatNotFound || tr.couldNotStartCall)
        if (chatBlocksEitherUser(chatSnap.data(), user.uid, request.chat.otherId)) {
          setCallError(tr.callsDisabledBlocked)
          return
        }

        const callerSnap = await getDoc(doc(db, 'users', user.uid))
        const callerData = callerSnap.exists() ? callerSnap.data() : {}
        const channelName = `gty_${request.chat.id}_${Date.now()}`

        const callRef = doc(collection(db, 'calls'))
        const messageRef = doc(collection(db, 'chats', request.chat.id, 'messages'))
        const callerName = buildDisplayName(callerData) || callerData.phoneNumber || ''
        const receiverName = request.chat.otherName || request.chat.otherPhone || ''
        const callData = {
          chatId: request.chat.id,
          channelName,
          type: request.type,
          status: 'ringing',
          callMessageId: messageRef.id,
          callerId: user.uid,
          receiverId: request.chat.otherId,
          participants: [user.uid, request.chat.otherId],
          participantControls: {
            [user.uid]: { micMuted: false, silencerOn: false },
            [request.chat.otherId]: { micMuted: false, silencerOn: false },
          },
          callerName,
          callerPhone: callerData.phoneNumber || '',
          callerPhoto: callerData.photoURL || '',
          receiverName,
          receiverPhone: request.chat.otherPhone || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }
        const text = buildCallMessageText(callData, 'ringing', tr)
        const batch = writeBatch(db)
        batch.set(callRef, callData)
        batch.set(messageRef, {
          senderId: user.uid,
          type: 'call',
          text,
          callId: callRef.id,
          callType: request.type,
          callStatus: 'ringing',
          callerId: user.uid,
          receiverId: request.chat.otherId,
          callerName,
          receiverName,
          timestamp: serverTimestamp(),
          status: 'sent',
        })
        batch.update(doc(db, 'chats', request.chat.id), {
          lastMessage: {
            text,
            type: 'call',
            timestamp: serverTimestamp(),
            senderId: user.uid,
            callId: callRef.id,
            callType: request.type,
            callStatus: 'ringing',
          },
          hiddenFor: arrayRemove(user.uid, request.chat.otherId),
          clearedFor: arrayRemove(user.uid, request.chat.otherId),
        })
        await batch.commit()
      } catch (err) {
        console.error('Call start failed:', err)
        setCallError(tr.couldNotStartCall)
      }
    }

    startCall()
  }, [request, tr, user.uid])

  useEffect(() => {
    if (!otherUserId) return undefined

    const unsub = onSnapshot(doc(db, 'users', otherUserId), snap => {
      setOtherProfileState({ id: otherUserId, data: snap.exists() ? snap.data() : null })
    })
    return unsub
  }, [otherUserId])

  useEffect(() => {
    if (activeCallStatus !== 'active') return undefined

    const startedAt = Date.now()
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [activeCallId, activeCallStatus])

  useEffect(() => {
    if (activeCallStatus !== 'ringing' || !currentCall) {
      autoEndingCallIdRef.current = null
      return undefined
    }

    const startedAt = getRingingStartedAt(currentCall)
    const tick = () => {
      const remaining = Math.max(0, RING_TIMEOUT_MS - (Date.now() - startedAt))
      setRingTimeLeft(remaining)
      if (remaining <= 0 && autoEndingCallIdRef.current !== currentCall.id) {
        autoEndingCallIdRef.current = currentCall.id
        endFirestoreCall('unanswered')
      }
    }

    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [activeCallId, activeCallStatus, currentCall, endFirestoreCall])

  useEffect(() => {
    if (currentCall?.status === 'active') {
      queueMicrotask(() => joinAgora(currentCall))
    } else if (!currentCall) {
      queueMicrotask(() => leaveAgora())
    }
  }, [currentCall, joinAgora, leaveAgora])

  useEffect(() => {
    const videoTrack = findLocalTrack(localTracksRef.current, 'video')
    if (!localVideoRef.current || !videoTrack || !localVideoReady || !localCameraOn) return undefined
    videoTrack.play(localVideoRef.current)
    return () => videoTrack.stop()
  }, [featuredSource, previewSource, showPreview, localVideoReady, localCameraOn, currentCall?.id])

  useEffect(() => {
    const handlePageHide = () => {
      const call = currentCallRef.current
      if (!call || call.status === 'ended') return
      updateCallAndMessage(call, {
        status: 'ended',
        endReason: 'left',
        endedBy: user.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, getFinalCallStatus(call, 'left')).catch(() => {
        updateDoc(doc(db, 'calls', call.id), {
          status: 'ended',
          endReason: 'left',
          endedBy: user.uid,
          endedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {})
      })
    }

    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      leaveAgora()
    }
  }, [leaveAgora, updateCallAndMessage, user.uid])

  const acceptCall = async () => {
    if (!currentCall) return
    try {
      const updated = await updateCallAndMessage(currentCall, {
        status: 'active',
        acceptedBy: user.uid,
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, 'accepted', { expectedStatus: 'ringing', preventIfBlocked: true })
      if (updated === false) {
        setCallError(tr.callsDisabledBlocked)
        await endFirestoreCall('blocked')
      }
    } catch (err) {
      console.error('Accept call failed:', err)
      setCallError(tr.couldNotAcceptCall)
    }
  }

  const toggleMicrophone = async () => {
    const audioTrack = findLocalTrack(localTracksRef.current, 'audio')
    if (!audioTrack) return

    const nextMicState = !localMicOn
    try {
      await audioTrack.setEnabled(nextMicState)
      setLocalMicOn(nextMicState)
      updateLocalCallControls({ micMuted: !nextMicState })
      setMediaNotice('')
    } catch (err) {
      console.warn('Microphone toggle failed:', err)
      setMediaNotice(tr.couldNotUpdateMicrophone)
    }
  }

  const turnCameraOn = async () => {
    if (!clientRef.current || !joinedCallIdRef.current) return

    const existingTrack = findLocalTrack(localTracksRef.current, 'video')
    if (existingTrack) {
      try {
        await existingTrack.setEnabled(true)
        setLocalCameraOn(true)
        setLocalVideoReady(true)
        setMediaNotice('')
      } catch (err) {
        console.warn('Camera enable failed:', err)
        setMediaNotice(describeCameraError(err, tr))
      }
      return
    }

    try {
      const videoTrack = await createCameraVideoTrack(FRONT_CAMERA_FACING_MODE)
      localTracksRef.current = [...localTracksRef.current, videoTrack]
      await clientRef.current.publish(videoTrack)
      setLocalCameraOn(true)
      setLocalVideoReady(true)
      setCameraFacingMode(FRONT_CAMERA_FACING_MODE)
      setMediaNotice('')
    } catch (err) {
      console.warn('Camera publish failed:', err)
      setMediaNotice(describeCameraError(err, tr))
    }
  }

  const turnCameraOff = async () => {
    const videoTrack = findLocalTrack(localTracksRef.current, 'video')
    if (!videoTrack) {
      setLocalCameraOn(false)
      setLocalVideoReady(false)
      return
    }

    setLocalCameraOn(false)
    setLocalVideoReady(false)
    try {
      if (clientRef.current && joinedCallIdRef.current) {
        await clientRef.current.unpublish(videoTrack)
      }
    } catch (err) {
      console.warn('Camera unpublish failed:', err)
    } finally {
      videoTrack.stop()
      videoTrack.close()
      localTracksRef.current = localTracksRef.current.filter(track => track !== videoTrack)
    }
  }

  const toggleCamera = () => {
    if (localCameraOn) {
      turnCameraOff()
    } else {
      turnCameraOn()
    }
  }

  const switchCamera = async () => {
    const videoTrack = findLocalTrack(localTracksRef.current, 'video')
    if (!videoTrack || !localCameraOn || switchingCamera) return

    const nextFacingMode = cameraFacingModeRef.current === FRONT_CAMERA_FACING_MODE
      ? REAR_CAMERA_FACING_MODE
      : FRONT_CAMERA_FACING_MODE

    setSwitchingCamera(true)
    try {
      await videoTrack.setDevice({ facingMode: nextFacingMode })
      setCameraFacingMode(nextFacingMode)
      setLocalVideoReady(true)
      setMediaNotice('')
    } catch (err) {
      console.warn('Camera switch failed:', err)
      setMediaNotice(describeCameraError(err, tr))
    } finally {
      setSwitchingCamera(false)
    }
  }

  const toggleSpeaker = () => {
    setSpeakerOn(prev => !prev)
    setMediaNotice('')
  }

  const toggleRemoteSilencer = () => {
    setRemoteSilenced(prev => {
      const next = !prev
      remoteSilencedRef.current = next
      updateLocalCallControls({ silencerOn: next })
      return next
    })
    setMediaNotice('')
  }

  const swapFeaturedVideo = () => {
    if (previewMovedRef.current) {
      previewMovedRef.current = false
      return
    }
    if (!showPreview || !['local', 'remote'].includes(previewSource)) return
    setFeaturedVideo(previewSource)
  }

  const snapPreviewToCorner = (clientX, clientY) => {
    const stage = callStageRef.current
    if (!stage) return previewCorner
    const rect = stage.getBoundingClientRect()
    const horizontal = clientX - rect.left < rect.width / 2 ? 'left' : 'right'
    const vertical = clientY - rect.top < rect.height / 2 ? 'top' : 'bottom'
    const nextCorner = `${vertical}-${horizontal}`
    return videoCorners.includes(nextCorner) ? nextCorner : previewCorner
  }

  const handlePreviewPointerDown = e => {
    if (!showPreview) return
    const preview = previewRef.current
    const stage = callStageRef.current
    if (!preview || !stage) return
    e.preventDefault()
    preview.setPointerCapture?.(e.pointerId)
    previewMovedRef.current = false
    const previewRect = preview.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    setPreviewDrag({
      pointerId: e.pointerId,
      offsetX: e.clientX - previewRect.left,
      offsetY: e.clientY - previewRect.top,
      left: previewRect.left - stageRect.left,
      top: previewRect.top - stageRect.top,
    })
  }

  const handlePreviewPointerMove = e => {
    if (!previewDrag || e.pointerId !== previewDrag.pointerId) return
    const stage = callStageRef.current
    const preview = previewRef.current
    if (!stage || !preview) return
    const stageRect = stage.getBoundingClientRect()
    const previewRect = preview.getBoundingClientRect()
    const nextLeft = Math.min(
      Math.max(e.clientX - stageRect.left - previewDrag.offsetX, 12),
      Math.max(12, stageRect.width - previewRect.width - 12)
    )
    const nextTop = Math.min(
      Math.max(e.clientY - stageRect.top - previewDrag.offsetY, 12),
      Math.max(12, stageRect.height - previewRect.height - 12)
    )
    if (Math.abs(nextLeft - previewDrag.left) > 4 || Math.abs(nextTop - previewDrag.top) > 4) {
      previewMovedRef.current = true
    }
    setPreviewDrag(prev => prev ? { ...prev, left: nextLeft, top: nextTop } : prev)
  }

  const handlePreviewPointerEnd = e => {
    if (!previewDrag || e.pointerId !== previewDrag.pointerId) return
    previewRef.current?.releasePointerCapture?.(e.pointerId)
    setPreviewCorner(snapPreviewToCorner(e.clientX, e.clientY))
    setPreviewDrag(null)
  }

  const closeOrEndCall = () => {
    if (!currentCall) {
      setCallError('')
      return
    }
    endFirestoreCall(isIncomingRinging ? 'declined' : isOutgoingRinging ? 'canceled' : 'ended')
  }

  const formatElapsed = seconds => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
    const secs = (seconds % 60).toString().padStart(2, '0')
    return `${mins}:${secs}`
  }
  const formatRemaining = ms => formatElapsed(Math.ceil(ms / 1000))

  if (!currentCall && !callError) return null

  return (
    <div className={`call-shell ${isActive ? 'active' : 'ringing'}`}>
      <div className={`call-panel ${showVideoStage ? 'call-panel-video' : ''}`}>
        {showVideoStage ? (
          <div className="call-stage" ref={callStageRef}>
            {featuredSource === 'remote' && remoteVideoUser ? (
              <RemoteVideo user={remoteVideoUser} />
            ) : featuredSource === 'local' ? (
              <div className="call-video call-video-local-featured">
                <div className="call-video-feed" ref={localVideoRef} />
                {hasLocalVideo && (
                  <SwitchCameraButton
                    facingMode={cameraFacingMode}
                    switching={switchingCamera}
                    onSwitch={switchCamera}
                    tr={tr}
                  />
                )}
                {!localCameraOn && <span>{tr.cameraOff}</span>}
                {localCameraOn && !localVideoReady && <span>{tr.cameraStarting}</span>}
              </div>
            ) : (
              <div className="call-video call-video-waiting">
                <div className="call-avatar">{otherName[0]?.toUpperCase() || '?'}</div>
                <span>{isVideoCall ? tr.waitingForVideo : tr.cameraIsOn}</span>
              </div>
            )}

            {showPreview && (
              <div
                ref={previewRef}
                role="button"
                tabIndex={0}
                className={`call-video-preview call-video-preview-${previewCorner} ${previewDrag ? 'dragging' : ''} ${previewSource === 'local' && !localCameraOn ? 'camera-off' : ''}`}
                style={previewDrag ? { left: previewDrag.left, top: previewDrag.top } : undefined}
                onClick={swapFeaturedVideo}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    swapFeaturedVideo()
                  }
                }}
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={handlePreviewPointerEnd}
                onPointerCancel={handlePreviewPointerEnd}
                title={tr.switchCameraView}
              >
                {previewSource === 'remote' && remoteVideoUser ? (
                  <RemoteVideo user={remoteVideoUser} className="call-video-preview-feed" />
                ) : (
                  <>
                    <div className="call-video-feed" ref={localVideoRef} />
                    {hasLocalVideo && previewSource === 'local' && (
                      <SwitchCameraButton
                        facingMode={cameraFacingMode}
                        switching={switchingCamera}
                        onSwitch={switchCamera}
                        tr={tr}
                      />
                    )}
                    {!localCameraOn && <span>{tr.cameraOff}</span>}
                    {localCameraOn && !localVideoReady && <span>{tr.cameraStarting}</span>}
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="call-portrait">
            <div className="call-avatar call-avatar-large">
              {otherProfile?.photoURL
                ? <img src={otherProfile.photoURL} alt="" />
                : <span>{otherName[0]?.toUpperCase() || '?'}</span>}
            </div>
          </div>
        )}

        <div className="call-info">
          <div className="call-name">{otherName}</div>
          <div className="call-status">
            {callError || (
              mediaNotice || (isActive
                ? formatText(tr.activeCallStatus, { type: currentCall.type === 'video' ? tr.callKindVideo : tr.callKindVoice, time: formatElapsed(elapsed) })
                : isIncomingRinging
                  ? formatText(tr.incomingCallStatus, { type: currentCall.type === 'video' ? tr.callKindVideo : tr.callKindVoice, time: formatRemaining(ringTimeLeft) })
                  : isOutgoingRinging
                    ? formatText(tr.callingStatus, { name: otherName, time: formatRemaining(ringTimeLeft) })
                    : tr.connecting)
            )}
          </div>
          {isActive && (otherMicMuted || otherSilencerOn) && (
            <div className="call-state-badges">
              {otherMicMuted && (
                <span className="call-state-badge">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" aria-hidden="true">
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05L19 15.18V11zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.42 2.72 6.23 6 6.72V21h2v-3.28c.99-.15 1.9-.53 2.68-1.07L19.73 21 21 19.73 4.27 3zM15 10.17V5c0-1.66-1.34-3-3-3-1.36 0-2.5.91-2.87 2.15L15 10.17z" />
                  </svg>
                  {tr.muted}
                </span>
              )}
              {otherSilencerOn && (
                <span className="call-state-badge">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" aria-hidden="true">
                    <path d="M4.27 3 3 4.27 19.73 21 21 19.73 4.27 3zM3 9v6h4l5 5v-6.73L7.73 9H3zm9-5-2.1 2.1L12 8.2V4zm5.5 8c0-1.77-1-3.29-2.5-4.03v2.2l2.45 2.45c.03-.2.05-.41.05-.62z" />
                  </svg>
                  {tr.silenced}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="call-actions">
          {isActive && (
            <>
              <button
                className={`call-action call-secondary ${localMicOn ? '' : 'is-off'}`}
                onClick={toggleMicrophone}
                title={localMicOn ? tr.muteMicrophone : tr.unmuteMicrophone}
              >
                {localMicOn ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="23" height="23">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.42 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.3 6-6.72h-1.7z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="23" height="23">
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05L19 15.18V11zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.42 2.72 6.23 6 6.72V21h2v-3.28c.99-.15 1.9-.53 2.68-1.07L19.73 21 21 19.73 4.27 3zM15 10.17V5c0-1.66-1.34-3-3-3-1.36 0-2.5.91-2.87 2.15L15 10.17z" />
                  </svg>
                )}
              </button>
              <button
                className={`call-action call-secondary ${localCameraOn ? '' : 'is-off'}`}
                onClick={toggleCamera}
                title={localCameraOn ? tr.turnCameraOff : tr.turnCameraOn}
              >
                {localCameraOn ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M17 10.5V6c0-1.1-.9-2-2-2H5C3.9 4 3 4.9 3 6v12c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-4.5l4 4v-11l-4 4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M21 6.5l-4 4V7.82L21 11.82V6.5zM3.27 2L2 3.27l2.73 2.73C3.72 6.14 3 7 3 8.03v7.94C3 17.1 3.9 18 5.03 18h10.44L20.73 23 22 21.73 3.27 2zM15 15.73L6.27 7H15v8.73z" />
                  </svg>
                )}
              </button>
              <button
                className={`call-action call-secondary ${speakerOn ? 'is-off' : ''}`}
                onClick={toggleSpeaker}
                title={speakerOn ? tr.turnSpeakerOff : tr.turnSpeakerOn}
              >
                {speakerOn ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm12.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02z" />
                  </svg>
                )}
              </button>
              <button
                className={`call-action call-secondary ${remoteSilenced ? 'is-off' : ''}`}
                onClick={toggleRemoteSilencer}
                title={remoteSilenced ? tr.unsilenceCallAudio : tr.silenceCallAudio}
              >
                {remoteSilenced ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73L16.25 17.52c-.67.52-1.43.93-2.25 1.19v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.62 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM12 4 9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M4.27 3 3 4.27 19.73 21 21 19.73 4.27 3zM3 9v6h4l5 5v-6.73L7.73 9H3zm9-5-2.1 2.1L12 8.2V4zm5.5 8c0-1.77-1-3.29-2.5-4.03v2.2l2.45 2.45c.03-.2.05-.41.05-.62z" />
                  </svg>
                )}
              </button>
            </>
          )}
          {isIncomingRinging && (
            <button className="call-action call-accept" onClick={acceptCall} title={tr.acceptCall}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          )}
          <button
            className="call-action call-decline"
            onClick={closeOrEndCall}
            title={isActive ? tr.endCall : tr.declineCall}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="25" height="25">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9l-2.7 1.35c-.49.24-1.08.05-1.34-.44L1.2 11.4c-.24-.47-.1-1.04.33-1.34C4.5 7.98 8.1 7 12 7s7.5.98 10.47 3.06c.43.3.57.87.33 1.34l-1.6 3.23c-.25.49-.84.68-1.34.44l-2.7-1.35c-.34-.17-.56-.52-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
