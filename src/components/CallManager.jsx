import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AgoraRTC from 'agora-rtc-sdk-ng'
import {
  addDoc, collection, doc, getDoc, onSnapshot, query,
  serverTimestamp, updateDoc, where,
} from 'firebase/firestore'
import { db } from '../firebase'
import { buildDisplayName } from '../profile'

const AGORA_APP_ID = import.meta.env.VITE_AGORA_APP_ID || '44b55e8620e8421b9be760862e6a2a7e'
const OPEN_STATUSES = new Set(['ringing', 'active'])

const millisFromTimestamp = value => value?.toMillis?.() ?? 0
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

  if (callType !== 'video') return [audioTrack]

  try {
    const videoTrack = await AgoraRTC.createCameraVideoTrack()
    return [audioTrack, videoTrack]
  } catch (err) {
    audioTrack.close()
    throw err
  }
}

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

  const clientRef = useRef(null)
  const localTracksRef = useRef([])
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

  const leaveAgora = useCallback(async () => {
    localTracksRef.current.forEach(track => {
      track.stop()
      track.close()
    })
    localTracksRef.current = []
    setLocalVideoReady(false)
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
        if (mediaType === 'audio') remoteUser.audioTrack?.play()
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
    client.on('user-unpublished', remoteUser => {
      setRemoteUsers(prev => prev.filter(item => item.uid !== remoteUser.uid))
    })
    client.on('user-left', remoteUser => {
      setRemoteUsers(prev => prev.filter(item => item.uid !== remoteUser.uid))
    })
    clientRef.current = client
    return client
  }, [])

  const endFirestoreCall = useCallback(async (reason = 'ended') => {
    const call = currentCallRef.current
    if (!call) return
    try {
      await updateDoc(doc(db, 'calls', call.id), {
        status: 'ended',
        endReason: reason,
        endedBy: user.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      console.warn('Call end update failed:', err)
    } finally {
      await leaveAgora()
      setCurrentCall(null)
    }
  }, [leaveAgora, user.uid])

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
      const tracks = await createLocalTracks(call.type)
      localTracksRef.current = tracks
      await client.join(AGORA_APP_ID, call.channelName, null, user.uid)
      await client.publish(tracks)
      joinedCallIdRef.current = call.id
      setLocalVideoReady(call.type === 'video')
    } catch (err) {
      console.error('Agora join failed:', err)
      localTracksRef.current.forEach(track => {
        track.stop()
        track.close()
      })
      localTracksRef.current = []
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

        await addDoc(collection(db, 'calls'), {
          chatId: request.chat.id,
          channelName,
          type: request.type,
          status: 'ringing',
          callerId: user.uid,
          receiverId: request.chat.otherId,
          participants: [user.uid, request.chat.otherId],
          callerName: buildDisplayName(callerData) || callerData.phoneNumber || '',
          callerPhone: callerData.phoneNumber || '',
          callerPhoto: callerData.photoURL || '',
          receiverName: request.chat.otherName || '',
          receiverPhone: request.chat.otherPhone || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
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
    const videoTrack = localTracksRef.current.find(track => track.trackMediaType === 'video')
    if (!localVideoRef.current || !videoTrack || !localVideoReady) return
    videoTrack.play(localVideoRef.current)
  }, [localVideoReady, currentCall?.id])

  useEffect(() => {
    const handlePageHide = () => {
      const call = currentCallRef.current
      if (!call || call.status === 'ended') return
      updateDoc(doc(db, 'calls', call.id), {
        status: 'ended',
        endReason: 'left',
        endedBy: user.uid,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {})
    }

    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      leaveAgora()
    }
  }, [leaveAgora, user.uid])

  const acceptCall = async () => {
    if (!currentCall) return
    try {
      await updateDoc(doc(db, 'calls', currentCall.id), {
        status: 'active',
        acceptedBy: user.uid,
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      console.error('Accept call failed:', err)
      setCallError('Could not accept the call.')
    }
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
      <div className={`call-panel ${isVideoCall && isActive ? 'call-panel-video' : ''}`}>
        {isActive && isVideoCall ? (
          <div className="call-stage">
            {remoteUsers.length ? (
              remoteUsers.map(remoteUser => <RemoteVideo key={remoteUser.uid} user={remoteUser} />)
            ) : (
              <div className="call-video call-video-waiting">
                <div className="call-avatar">{otherName[0]?.toUpperCase() || '?'}</div>
                <span>Waiting for video</span>
              </div>
            )}
            <div className="call-video-local" ref={localVideoRef}>
              {!localVideoReady && <span>Camera starting</span>}
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
              isActive
                ? `${currentCall.type === 'video' ? 'Video' : 'Voice'} call ${formatElapsed(elapsed)}`
                : isIncomingRinging
                  ? `Incoming ${currentCall.type} call`
                  : isOutgoingRinging
                    ? `Calling ${otherName}...`
                    : 'Connecting...'
            )}
          </div>
        </div>

        <div className="call-actions">
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
