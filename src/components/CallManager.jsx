import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AgoraRTC from 'agora-rtc-sdk-ng'
import {
  collection, doc, getDoc, onSnapshot, query,
  arrayRemove, runTransaction, serverTimestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore'
import { db } from '../firebase'
import { buildDisplayName } from '../profile'

const AGORA_APP_ID = import.meta.env.VITE_AGORA_APP_ID || '44b55e8620e8421b9be760862e6a2a7e'
const OPEN_STATUSES = new Set(['ringing', 'active'])

const millisFromTimestamp = value => value?.toMillis?.() ?? 0
const callKindText = callType => `${callType === 'video' ? 'video' : 'voice'} call`
const displayNameOrFallback = (...values) => {
  const value = values.find(item => String(item || '').trim())
  return String(value || 'Unknown user').trim()
}
const callStatusText = status => ({
  ringing: 'ringing',
  accepted: 'accepted',
  declined: 'declined',
  canceled: 'canceled',
  ended: 'accepted and ended',
  failed: 'failed',
  left: 'ended',
}[status] || status)
const buildCallMessageText = (call, callStatus) => {
  const caller = displayNameOrFallback(call.callerName, call.callerPhone)
  const receiver = displayNameOrFallback(call.receiverName, call.receiverPhone)
  return `${caller} called ${receiver} - ${callKindText(call.type)} ${callStatusText(callStatus)}`
}
const getFinalCallStatus = (call, reason) => {
  if (reason === 'declined') return 'declined'
  if (reason === 'canceled') return 'canceled'
  if (reason === 'media-failed') return 'failed'
  if (reason === 'left') return call.acceptedAt ? 'left' : 'canceled'
  return call.acceptedAt ? 'ended' : 'canceled'
}

const describeMediaError = (err, callType) => {
  const code = err?.code || err?.name || ''
  const message = err?.message || ''
  const detail = [code, message].filter(Boolean).join(': ')

  if (!window.isSecureContext) {
    return 'Calls need a secure page. Use localhost or HTTPS, then try again.'
  }

  if (/permission|notallowed/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? 'Camera or microphone permission was blocked for this site.'
      : 'Microphone permission was blocked for this site.'
  }

  if (/notfound|devices_not_found/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? 'No camera or microphone was found.'
      : 'No microphone was found.'
  }

  if (/notreadable|track_start/i.test(`${code} ${message}`)) {
    return callType === 'video'
      ? 'Your camera or microphone is already in use by another app.'
      : 'Your microphone is already in use by another app.'
  }

  return detail
    ? `Could not start ${callType} call. ${detail}`
    : `Could not start ${callType} call.`
}

const createLocalTracks = async callType => {
  const audioTrack = await AgoraRTC.createMicrophoneAudioTrack({
    encoderConfig: 'speech_standard',
  })

  if (callType !== 'video') return { tracks: [audioTrack], videoError: null }

  try {
    const videoTrack = await AgoraRTC.createCameraVideoTrack()
    return { tracks: [audioTrack, videoTrack], videoError: null }
  } catch (err) {
    return { tracks: [audioTrack], videoError: err }
  }
}

const describeCameraError = err => {
  const code = err?.code || err?.name || ''
  const message = err?.message || ''

  if (/permission|notallowed/i.test(`${code} ${message}`)) {
    return 'Camera permission was blocked for this site.'
  }

  if (/notfound|devices_not_found/i.test(`${code} ${message}`)) {
    return 'No camera was found.'
  }

  if (/notreadable|track_start/i.test(`${code} ${message}`)) {
    return 'Your camera is already in use by another app.'
  }

  return 'Could not turn on camera.'
}

const findLocalTrack = (tracks, mediaType) => tracks.find(track => track.trackMediaType === mediaType)

function RemoteVideo({ user }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !user.videoTrack) return undefined
    user.videoTrack.play(ref.current)
    return () => user.videoTrack?.stop()
  }, [user])

  return <div className="call-video call-video-remote" ref={ref} />
}

export default function CallManager({ user, request }) {
  const [currentCall, setCurrentCall] = useState(null)
  const [remoteUsers, setRemoteUsers] = useState([])
  const [otherProfileState, setOtherProfileState] = useState(null)
  const [callError, setCallError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [localVideoReady, setLocalVideoReady] = useState(false)
  const [localMicOn, setLocalMicOn] = useState(true)
  const [localCameraOn, setLocalCameraOn] = useState(false)
  const [remoteAudioOn, setRemoteAudioOn] = useState(true)
  const [mediaNotice, setMediaNotice] = useState('')

  const clientRef = useRef(null)
  const localTracksRef = useRef([])
  const remoteAudioTracksRef = useRef(new Map())
  const remoteAudioOnRef = useRef(true)
  const joinedCallIdRef = useRef(null)
  const joiningCallIdRef = useRef(null)
  const localVideoRef = useRef(null)
  const handledRequestIdRef = useRef(null)

  const currentCallRef = useRef(null)
  useEffect(() => {
    currentCallRef.current = currentCall
  }, [currentCall])

  const otherUserId = useMemo(() => {
    if (!currentCall) return null
    return currentCall.callerId === user.uid ? currentCall.receiverId : currentCall.callerId
  }, [currentCall, user.uid])
  const otherProfile = otherProfileState?.id === otherUserId ? otherProfileState.data : null
  const activeCallId = currentCall?.id
  const activeCallStatus = currentCall?.status

  const otherName = useMemo(() => {
    if (!currentCall) return ''
    if (otherProfile) return buildDisplayName(otherProfile) || otherProfile.phoneNumber || 'Unknown user'
    if (currentCall.callerId === user.uid) return currentCall.receiverName || currentCall.receiverPhone || 'Unknown user'
    return currentCall.callerName || currentCall.callerPhone || 'Unknown user'
  }, [currentCall, otherProfile, user.uid])

  const isIncomingRinging = currentCall?.status === 'ringing' && currentCall.receiverId === user.uid
  const isOutgoingRinging = currentCall?.status === 'ringing' && currentCall.callerId === user.uid
  const isActive = currentCall?.status === 'active'
  const isVideoCall = currentCall?.type === 'video'
  const showVideoStage = isActive && (isVideoCall || localCameraOn || remoteUsers.length > 0)

  useEffect(() => {
    remoteAudioOnRef.current = remoteAudioOn
    remoteAudioTracksRef.current.forEach(track => {
      track.setVolume?.(remoteAudioOn ? 100 : 0)
      if (remoteAudioOn) track.play?.()
    })
  }, [remoteAudioOn])

  const updateCallAndMessage = useCallback(async (call, callPatch, callStatus) => {
    const callRef = doc(db, 'calls', call.id)
    const hasCallMessage = Boolean(call.chatId && call.callMessageId)
    const chatRef = hasCallMessage ? doc(db, 'chats', call.chatId) : null
    const messageRef = hasCallMessage ? doc(db, 'chats', call.chatId, 'messages', call.callMessageId) : null
    const text = buildCallMessageText(call, callStatus)
    const lastMessage = {
      text,
      type: 'call',
      timestamp: serverTimestamp(),
      senderId: call.callerId,
      callId: call.id,
      callType: call.type,
      callStatus,
    }

    await runTransaction(db, async transaction => {
      const chatSnap = chatRef ? await transaction.get(chatRef) : null
      transaction.update(callRef, callPatch)

      if (!messageRef) return

      transaction.update(messageRef, {
        text,
        callStatus,
        updatedAt: serverTimestamp(),
      })

      if (!chatSnap?.exists()) return

      const currentLast = chatSnap.data().lastMessage
      if (!currentLast || currentLast.callId === call.id) {
        transaction.update(chatRef, {
          lastMessage,
          hiddenFor: arrayRemove(call.callerId, call.receiverId),
          clearedFor: arrayRemove(call.callerId, call.receiverId),
        })
      }
    })
  }, [])

  const leaveAgora = useCallback(async () => {
    localTracksRef.current.forEach(track => {
      track.stop()
      track.close()
    })
    localTracksRef.current = []
    remoteAudioTracksRef.current.clear()
    remoteAudioOnRef.current = true
    setLocalVideoReady(false)
    setLocalMicOn(true)
    setLocalCameraOn(false)
    setRemoteAudioOn(true)
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
          remoteUser.audioTrack.setVolume?.(remoteAudioOnRef.current ? 100 : 0)
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
    try {
      await updateCallAndMessage(call, {
        status: 'ended',
        endReason: reason,
        endedBy: user.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, getFinalCallStatus(call, reason))
    } catch (err) {
      console.warn('Call end update failed:', err)
    } finally {
      await leaveAgora()
      setCurrentCall(null)
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
      const { tracks, videoError } = await createLocalTracks(call.type)
      localTracksRef.current = tracks
      await client.join(AGORA_APP_ID, call.channelName, null, user.uid)
      await client.publish(tracks)
      joinedCallIdRef.current = call.id
      const hasVideoTrack = Boolean(findLocalTrack(tracks, 'video'))
      setLocalMicOn(true)
      setLocalCameraOn(hasVideoTrack)
      setLocalVideoReady(hasVideoTrack)
      setMediaNotice(videoError ? describeCameraError(videoError) : '')
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
      try {
        await client.leave()
      } catch { /* ignore cleanup failure */ }
      setCallError(describeMediaError(err, call.type))
      await endFirestoreCall('media-failed')
    } finally {
      if (joiningCallIdRef.current === call.id) {
        joiningCallIdRef.current = null
      }
    }
  }, [endFirestoreCall, getClient, leaveAgora, user.uid])

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
          callerName,
          callerPhone: callerData.phoneNumber || '',
          callerPhoto: callerData.photoURL || '',
          receiverName,
          receiverPhone: request.chat.otherPhone || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }
        const text = buildCallMessageText(callData, 'ringing')
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
        setCallError('Could not start the call.')
      }
    }

    startCall()
  }, [request, user.uid])

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
  }, [localVideoReady, localCameraOn, currentCall?.id])

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
      await updateCallAndMessage(currentCall, {
        status: 'active',
        acceptedBy: user.uid,
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, 'accepted')
    } catch (err) {
      console.error('Accept call failed:', err)
      setCallError('Could not accept the call.')
    }
  }

  const toggleMicrophone = async () => {
    const audioTrack = findLocalTrack(localTracksRef.current, 'audio')
    if (!audioTrack) return

    const nextMicState = !localMicOn
    try {
      await audioTrack.setEnabled(nextMicState)
      setLocalMicOn(nextMicState)
      setMediaNotice('')
    } catch (err) {
      console.warn('Microphone toggle failed:', err)
      setMediaNotice('Could not update microphone.')
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
        setMediaNotice(describeCameraError(err))
      }
      return
    }

    try {
      const videoTrack = await AgoraRTC.createCameraVideoTrack()
      localTracksRef.current = [...localTracksRef.current, videoTrack]
      await clientRef.current.publish(videoTrack)
      setLocalCameraOn(true)
      setLocalVideoReady(true)
      setMediaNotice('')
    } catch (err) {
      console.warn('Camera publish failed:', err)
      setMediaNotice(describeCameraError(err))
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

  const toggleRemoteAudio = () => {
    setRemoteAudioOn(prev => !prev)
    setMediaNotice('')
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

  if (!currentCall && !callError) return null

  return (
    <div className={`call-shell ${isActive ? 'active' : 'ringing'}`}>
      <div className={`call-panel ${showVideoStage ? 'call-panel-video' : ''}`}>
        {showVideoStage ? (
          <div className="call-stage">
            {remoteUsers.length ? (
              remoteUsers.map(remoteUser => <RemoteVideo key={remoteUser.uid} user={remoteUser} />)
            ) : (
              <div className="call-video call-video-waiting">
                <div className="call-avatar">{otherName[0]?.toUpperCase() || '?'}</div>
                <span>{isVideoCall ? 'Waiting for video' : 'Camera is on'}</span>
              </div>
            )}
            <div className={`call-video-local ${localCameraOn ? '' : 'camera-off'}`}>
              <div className="call-video-feed" ref={localVideoRef} />
              {!localCameraOn && <span>Camera off</span>}
              {localCameraOn && !localVideoReady && <span>Camera starting</span>}
            </div>
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
                ? `${currentCall.type === 'video' ? 'Video' : 'Voice'} call ${formatElapsed(elapsed)}`
                : isIncomingRinging
                  ? `Incoming ${currentCall.type} call`
                  : isOutgoingRinging
                    ? `Calling ${otherName}...`
                    : 'Connecting...')
            )}
          </div>
        </div>

        <div className="call-actions">
          {isActive && (
            <>
              <button
                className={`call-action call-secondary ${localMicOn ? '' : 'is-off'}`}
                onClick={toggleMicrophone}
                title={localMicOn ? 'Mute microphone' : 'Unmute microphone'}
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
                title={localCameraOn ? 'Turn camera off' : 'Turn camera on'}
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
                className={`call-action call-secondary ${remoteAudioOn ? '' : 'is-off'}`}
                onClick={toggleRemoteAudio}
                title={remoteAudioOn ? 'Silence call audio' : 'Unsilence call audio'}
              >
                {remoteAudioOn ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.62 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73L16.25 17.52c-.67.52-1.43.93-2.25 1.19v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                )}
              </button>
            </>
          )}
          {isIncomingRinging && (
            <button className="call-action call-accept" onClick={acceptCall} title="Accept call">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          )}
          <button
            className="call-action call-decline"
            onClick={closeOrEndCall}
            title={isActive ? 'End call' : 'Decline call'}
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
