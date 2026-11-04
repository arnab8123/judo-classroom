import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { LocalVideoTrack, Participant, Room, RoomEvent, Track, TrackPublication } from 'livekit-client';
import {
  ArrowLeft, ArrowUpRight, Bell, BellRing, Bluetooth, BookOpen, Check, ChevronDown, Circle, CircleHelp, Copy, FileText, Hand, Headphones,
  MessageCircle, Mic, MicOff, MonitorUp, MoreHorizontal, Maximize2, PanelRightClose, Paperclip, PhoneOff, Pin, Send,
  Settings2, ShieldCheck, Smile, Sparkles, Square, Sun, Moon, Users, Video, VideoOff, Volume2, VolumeX, X, Wifi, XCircle
} from 'lucide-react';
import {
  API_BASE, ChatMessage, ClassroomFile, PersonalNote, RoomSession, downloadFile, endRoom, getFiles,
  getNotes, saveNote, uploadFiles, deleteNote
} from '../api';
import Whiteboard from '../components/Whiteboard';

declare global {
  interface Window {
    dispatchEvent(event: Event): boolean;
    JudoNative?: { setMeetingActive(active: boolean, title: string): void; setAudioOutput(output: string): void; resetAudioOutput(): void };
  }
}

export default function ClassroomView({ session, mediaChoice, onLeave, theme, onToggleTheme }: {
  session: RoomSession;
  mediaChoice: { cameraEnabled: boolean; micEnabled: boolean; cameraId: string; micId: string };
  onLeave: () => void;
  theme: 'light' | 'dark'; onToggleTheme: () => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [mediaError, setMediaError] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [panel, setPanel] = useState<'chat' | 'people' | 'files' | 'notes' | null>(null);
  const [peopleVisible, setPeopleVisible] = useState(true);
  const [stage, setStage] = useState<'video' | 'board'>('video');
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [raised, setRaised] = useState(false);
  const [hands, setHands] = useState<Record<string, boolean>>({});
  const [endedMessage, setEndedMessage] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<ClassroomFile[]>([]);
  const [shareAudio, setShareAudio] = useState(false);
  const [screenShares, setScreenShares] = useState<{ id: string; label: string; videoTrack: MediaStreamTrack; audioTrack?: MediaStreamTrack }[]>([]);
  const [androidScreenSharing, setAndroidScreenSharing] = useState(false);
  const [androidMicOn, setAndroidMicOn] = useState(false);
  const [reaction, setReaction] = useState<{ displayName: string; emoji: string; id: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushMessage, setPushMessage] = useState('');
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showAudioOutputs, setShowAudioOutputs] = useState(false);
  const [inputDeviceMenu, setInputDeviceMenu] = useState<'microphone' | 'camera' | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState(mediaChoice.micId);
  const [selectedCameraId, setSelectedCameraId] = useState(mediaChoice.cameraId);
  const [audioOutput, setAudioOutput] = useState<'speaker' | 'earpiece' | 'bluetooth'>('speaker');
  const [audioMuted, setAudioMuted] = useState(false);
  const [pinnedScreenId, setPinnedScreenId] = useState('');
  const shareRef = useRef(screenShares);
  const stoppingSharesRef = useRef(new Set<string>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const roomRef = useRef<Room | null>(room);
  const pendingAndroidMicRestoreRef = useRef<boolean | null>(null);
  const preferredMicIdRef = useRef(mediaChoice.micId);
  const preferredCameraIdRef = useRef(mediaChoice.cameraId);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const startedAt = useRef(Date.now());
  shareRef.current = screenShares;
  roomRef.current = room;

  const bump = useCallback(() => setRefreshKey((v) => v + 1), []);

  useEffect(() => {
    window.JudoNative?.setMeetingActive(true, session.room.title);
    window.JudoNative?.setAudioOutput('speaker');
    return () => {
      window.JudoNative?.setMeetingActive(false, session.room.title);
      window.JudoNative?.resetAudioOutput();
    };
  }, []);

  useEffect(() => {
    const onAudioOutput = (event: Event) => {
      const detail = (event as CustomEvent<{ output: 'speaker' | 'earpiece' | 'bluetooth'; error?: string }>).detail;
      if (detail?.error) setMediaError(detail.error);
      else if (detail?.output) { setAudioOutput(detail.output); setMediaError(''); }
    };
    window.addEventListener('judo-audio-output', onAudioOutput);
    return () => window.removeEventListener('judo-audio-output', onAudioOutput);
  }, []);

  useEffect(() => {
    const onNativeShare = (event: Event) => {
      const detail = (event as CustomEvent<{ active: boolean; micEnabled?: boolean; error?: string; message?: string }>).detail;
      setAndroidScreenSharing(Boolean(detail?.active));
      if (detail?.active) {
        setAndroidMicOn(Boolean(detail.micEnabled));
        const currentRoom = roomRef.current;
        if (currentRoom?.localParticipant.isMicrophoneEnabled) {
          currentRoom.localParticipant.setMicrophoneEnabled(false).then(bump).catch((error) => {
            setMediaError(error instanceof Error ? `Could not switch microphone to phone sharing: ${error.message}` : 'Could not switch microphone to phone sharing.');
          });
        }
      } else {
        setAndroidMicOn(false);
        const restoreMic = typeof detail?.micEnabled === 'boolean' ? detail.micEnabled : pendingAndroidMicRestoreRef.current;
        pendingAndroidMicRestoreRef.current = null;
        const meetingEnded = /meeting has ended|classroom has ended/i.test(detail?.message || '');
        if (typeof restoreMic === 'boolean' && roomRef.current && !meetingEnded) {
          const currentRoom = roomRef.current;
          void (async () => {
            try {
              if (currentRoom.state === 'disconnected') {
                await currentRoom.connect(session.livekitUrl, session.livekitToken, { autoSubscribe: true, maxRetries: 3 });
              } else if (currentRoom.state !== 'connected') {
                await new Promise<void>((resolve, reject) => {
                  const timeoutId = window.setTimeout(() => finish(new Error('Meeting reconnection timed out.')), 20000);
                  const onState = (state: string) => {
                    if (state === 'connected') finish();
                    else if (state === 'disconnected') finish(new Error('Meeting connection was lost.'));
                  };
                  const finish = (error?: Error) => {
                    window.clearTimeout(timeoutId);
                    currentRoom.off(RoomEvent.ConnectionStateChanged, onState);
                    if (error) reject(error); else resolve();
                  };
                  currentRoom.on(RoomEvent.ConnectionStateChanged, onState);
                  if (currentRoom.state === 'connected') finish();
                });
              }
              await currentRoom.localParticipant.setMicrophoneEnabled(restoreMic);
              bump();
            } catch (error) {
              setMediaError(error instanceof Error ? `Could not restore the meeting connection: ${error.message}` : 'Could not restore the meeting connection. Tap Reconnect and try again.');
            }
          })();
        }
      }
      if (detail?.error) setMediaError(detail.error);
      if (detail?.active && !detail.error) setMediaError('');
      if (detail?.message) setAnnouncement(detail.message);
      bump();
    };
    window.addEventListener('judo-native-screen-share', onNativeShare);
    return () => window.removeEventListener('judo-native-screen-share', onNativeShare);
  }, [bump, session.livekitUrl, session.livekitToken]);

  useEffect(() => {
    let active = true;
    const liveRoom = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true });
    const update = () => { if (active) bump(); };
    liveRoom.on(RoomEvent.ParticipantConnected, update);
    liveRoom.on(RoomEvent.ParticipantDisconnected, update);
    liveRoom.on(RoomEvent.TrackSubscribed, update);
    liveRoom.on(RoomEvent.TrackUnsubscribed, update);
    liveRoom.on(RoomEvent.TrackPublished, update);
    liveRoom.on(RoomEvent.TrackUnpublished, update);
    liveRoom.on(RoomEvent.TrackMuted, update);
    liveRoom.on(RoomEvent.TrackUnmuted, update);
    liveRoom.on(RoomEvent.ActiveSpeakersChanged, update);
    liveRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (!active) return;
      setConnection(state === 'connected' ? 'connected' : state === 'reconnecting' ? 'reconnecting' : state === 'disconnected' ? 'disconnected' : 'connecting');
      bump();
    });
    liveRoom.on(RoomEvent.Disconnected, () => { if (active) { setConnection('disconnected'); bump(); } });
    setRoom(liveRoom);
    setConnection('connecting');

    (async () => {
      try {
        if (!session.livekitUrl || !/^wss?:\/\//i.test(session.livekitUrl)) {
          throw new Error('The video server URL is missing or invalid. Check LIVEKIT_URL in server/.env.');
        }
        await liveRoom.connect(session.livekitUrl, session.livekitToken, { autoSubscribe: true, maxRetries: 3 });
        if (!active) { liveRoom.disconnect(); return; }
        setConnection('connected');
        bump();
      } catch (err) {
        if (!active) return;
        setConnection('disconnected');
        const detail = err instanceof Error ? err.message : String(err || 'Unknown connection error');
        setMediaError(`Could not connect to the video server (${detail}). Make sure LiveKit is running and LIVEKIT_URL is reachable from this browser.`);
        return;
      }

      // Keep transport connection status separate from microphone/camera publishing.
      // A denied device permission or a failed publish must not falsely label the room disconnected.
      if (!active) return;
      const publishErrors: string[] = [];
      try {
        await liveRoom.localParticipant.setMicrophoneEnabled(mediaChoice.micEnabled, preferredMicIdRef.current ? { deviceId: preferredMicIdRef.current } : undefined);
      } catch (err) {
        publishErrors.push(`microphone: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await liveRoom.localParticipant.setCameraEnabled(mediaChoice.cameraEnabled, preferredCameraIdRef.current ? { deviceId: preferredCameraIdRef.current } : undefined);
      } catch (err) {
        publishErrors.push(`camera: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (active && publishErrors.length) {
        setMediaError(`You are connected to the meeting, but ${publishErrors.join('; ')}. Check device permissions and LiveKit connectivity, then use the microphone/camera buttons to retry.`);
      }
      if (active) bump();
    })();

    const classroomSocket = io(API_BASE, { auth: { token: session.sessionToken }, transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 12 });
    classroomSocket.on('connect', () => { classroomSocket.emit('board:sync'); });
    classroomSocket.on('connect_error', (err) => { if (active) setMediaError((old) => old || `Classroom connection issue: ${err.message}`); });
    classroomSocket.on('room:stage', (data: { stage?: 'video' | 'board' }) => {
      if (active && (data?.stage === 'video' || data?.stage === 'board')) setStage(data.stage);
    });
    classroomSocket.on('server:warning', (warning: { message?: string }) => { if (active && warning?.message) setMediaError(warning.message); });
    classroomSocket.on('chat:history', (history: ChatMessage[]) => setChatMessages(history));
    classroomSocket.on('chat:new', (message: ChatMessage) => setChatMessages((old) => old.some((item) => item.id === message.id) ? old : [...old, message]));
    classroomSocket.on('participant:hand', (hand: { sessionId: string; raised: boolean }) => setHands((old) => ({ ...old, [hand.sessionId]: hand.raised })));
    classroomSocket.on('meeting:ended', (data: { message?: string }) => { setEndedMessage(data.message || 'The teacher ended this classroom.'); liveRoom.disconnect(); classroomSocket.disconnect(); });
    classroomSocket.on('meeting:kicked', (data: { message?: string }) => { setEndedMessage(data.message || 'The host removed you from this classroom.'); liveRoom.disconnect(); classroomSocket.disconnect(); });
    classroomSocket.on('meeting:reaction', (data: { displayName: string; emoji: string; sessionId: string }) => {
      setReaction({ displayName: data.displayName, emoji: data.emoji, id: `${data.sessionId}-${Date.now()}` });
      window.setTimeout(() => setReaction(null), 2600);
    });
    classroomSocket.on('meeting:announcement', (data: { displayName: string; message: string }) => setAnnouncement(`${data.displayName}: ${data.message}`));
    setSocket(classroomSocket);

    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => {
      active = false;
      window.clearInterval(tick);
      classroomSocket.disconnect();
      shareRef.current.forEach((share) => { share.videoTrack.stop(); share.audioTrack?.stop(); });
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      else recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      liveRoom.disconnect();
    };
  }, [session.livekitUrl, session.livekitToken, session.sessionToken, mediaChoice, bump]);

  useEffect(() => {
    if (panel === 'files') refreshFiles();
    if (panel === 'notes') { /* NotesPanel loads only while open. */ }
  }, [panel]);
  const refreshFiles = async () => {
    try { setFiles((await getFiles(session.room.code, session.sessionToken)).files); }
    catch (err) { setMediaError(err instanceof Error ? err.message : 'Could not load classroom files.'); }
  };

  const refreshInputDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === 'audioinput'));
      setCameras(devices.filter((device) => device.kind === 'videoinput'));
    } catch { /* Keep the current device lists if enumeration is temporarily unavailable. */ }
  }, []);

  useEffect(() => {
    void refreshInputDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshInputDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshInputDevices);
  }, [refreshInputDevices]);

  const selectInputDevice = async (kind: 'audioinput' | 'videoinput', deviceId: string) => {
    try {
      if (room && !(await room.switchActiveDevice(kind, deviceId, Boolean(deviceId)))) {
        throw new Error(`Could not switch the ${kind === 'audioinput' ? 'microphone' : 'camera'}.`);
      }
      if (kind === 'audioinput') { preferredMicIdRef.current = deviceId; setSelectedMicId(deviceId); }
      else { preferredCameraIdRef.current = deviceId; setSelectedCameraId(deviceId); }
      setMediaError('');
      setInputDeviceMenu(null);
      void refreshInputDevices();
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Could not switch input device.');
    }
  };

  const participants: Participant[] = useMemo(() => room ? [room.localParticipant, ...room.remoteParticipants.values()] : [], [room, refreshKey]);
  const videoTiles = useMemo(() => {
    const seenScreenTracks = new Set<string>();
    return participants.map((participant) => {
      const publications = [...participant.trackPublications.values()];
      const camera = publications.find((pub) => pub.source === Track.Source.Camera && pub.kind === Track.Kind.Video);
      const screens = publications.filter((pub) => {
        if (pub.source !== Track.Source.ScreenShare || pub.kind !== Track.Kind.Video) return false;
        const key = pub.trackSid || `${participant.identity}:${pub.trackName || 'screen'}`;
        if (seenScreenTracks.has(key)) return false;
        seenScreenTracks.add(key);
        return true;
      });
      const cameraOn = Boolean(participant.isCameraEnabled && camera?.track && !camera.isMuted);
      return { participant, camera, cameraOn, screens };
    }).sort((a, b) => Number(b.participant.isSpeaking) - Number(a.participant.isSpeaking));
  }, [participants, refreshKey]);
  const screenChoices = videoTiles.flatMap(({ participant, screens }) => {
    const participantName = participant.name || participant.identity;
    return screens.filter((publication) => Boolean(publication.track) && !publication.isMuted).map((publication) => ({
      key: `${participant.identity}:${publication.trackSid || publication.trackName || 'screen'}`,
      label: `${participantName} · ${publication.trackName?.split('|')[1] || 'shared screen'}`
    }));
  });

  const toggleMic = async () => {
    if (navigator.userAgent.includes('JudoAndroidApp') && androidScreenSharing) {
      const intent = new URL('judo://microphone');
      intent.searchParams.set('enabled', String(!androidMicOn));
      window.location.assign(intent.toString());
      return;
    }
    if (!room) return;
    try { await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled); bump(); }
    catch (err) { setMediaError(err instanceof Error ? err.message : 'Could not change microphone setting.'); }
  };
  const toggleCamera = async () => {
    if (!room) return;
    try { await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled); bump(); }
    catch (err) { setMediaError(err instanceof Error ? err.message : 'Could not change camera setting.'); }
  };
  const startScreenShare = async () => {
    if (!room) return;
    setShowShareMenu(false);
    if (navigator.userAgent.includes('JudoAndroidApp')) {
      const intent = new URL('judo://share');
      intent.searchParams.set('room', session.room.code);
      intent.searchParams.set('name', session.displayName);
      intent.searchParams.set('server', window.location.origin);
      const micEnabled = room.localParticipant.isMicrophoneEnabled;
      intent.searchParams.set('micEnabled', String(micEnabled));
      pendingAndroidMicRestoreRef.current = micEnabled;
      try { if (micEnabled) await room.localParticipant.setMicrophoneEnabled(false); }
      catch (err) {
        pendingAndroidMicRestoreRef.current = null;
        setMediaError(err instanceof Error ? `Could not prepare the microphone for phone sharing: ${err.message}` : 'Could not prepare the microphone for phone sharing.');
        return;
      }
      window.location.assign(intent.toString());
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) { setMediaError('Screen sharing is not supported in this browser. Try a recent version of Chrome, Edge, or Firefox.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: shareAudio });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) { stream.getTracks().forEach((t) => t.stop()); return; }
      const audioTrack = stream.getAudioTracks()[0];
      const id = crypto.randomUUID();
      const label = `Screen ${screenShares.length + 1}`;
      try {
        await room.localParticipant.publishTrack(videoTrack, { source: Track.Source.ScreenShare, name: `${id}|${label}` });
        if (audioTrack) await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio, name: `${id}-audio` });
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        throw err;
      }
      setScreenShares((old) => [...old, { id, label, videoTrack, audioTrack }]);
      videoTrack.addEventListener('ended', () => stopScreenShare(id), { once: true });
      bump();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      setMediaError(err instanceof Error ? err.message : 'Could not start screen sharing.');
    }
  };
  const stopScreenShare = async (id: string) => {
    const share = shareRef.current.find((item) => item.id === id);
    if (!share || stoppingSharesRef.current.has(id)) return;
    stoppingSharesRef.current.add(id);
    try {
      if (room) {
        await room.localParticipant.unpublishTrack(share.videoTrack);
        if (share.audioTrack) await room.localParticipant.unpublishTrack(share.audioTrack);
      }
    } catch { /* Tracks are also stopped below if a network change happened. */ }
    share.videoTrack.stop(); share.audioTrack?.stop();
    setScreenShares((old) => old.filter((item) => item.id !== id));
    stoppingSharesRef.current.delete(id);
    bump();
  };
  const stopAndroidScreenShare = () => window.location.assign('judo://stop-share');
  const startRecording = async () => {
    setShowMore(false);
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      setMediaError('Recording is not supported by this browser. Try a recent desktop version of Chrome or Edge.'); return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 20, max: 30 } }, audio: true });
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'video/webm' });
        if (blob.size) {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a'); anchor.href = url;
          const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
          anchor.download = `judo-class-${session.room.code}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
          anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null; recorderRef.current = null; recordingChunksRef.current = []; setIsRecording(false);
      };
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (recorder.state === 'recording') recorder.stop(); }, { once: true });
      recorder.start(1000); setIsRecording(true);
      if (!stream.getAudioTracks().length) setMediaError('Recording started without audio. Select this browser tab and enable tab audio in the browser picker to include class sound.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      setMediaError(err instanceof Error ? err.message : 'Could not start the class recording.');
    }
  };
  const stopRecording = () => { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); };
  const toggleHand = () => { const next = !raised; setRaised(next); socket?.emit('participant:hand', { raised: next }); };
  const changeStage = (next: 'video' | 'board') => {
    setStage(next);
    if (session.role === 'teacher') socket?.emit('room:stage:set', { stage: next });
  };
  const sendReaction = (emoji: string) => socket?.emit('meeting:reaction', { emoji });
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/?room=${encodeURIComponent(session.room.code)}`); setAnnouncement('Class link copied to clipboard.'); }
    catch { setAnnouncement(`${window.location.origin}/?room=${session.room.code}`); }
  };
  const endMeeting = async () => {
    if (!window.confirm('End this classroom for everyone? All participants will be disconnected.')) return;
    try { await endRoom(session.room.code); setEndedMessage('You ended this classroom.'); room?.disconnect(); }
    catch (err) { setMediaError(err instanceof Error ? err.message : 'Could not end classroom.'); }
  };
  const leave = () => { if (androidScreenSharing) stopAndroidScreenShare(); if (room) room.disconnect(); onLeave(); };

  const enableClassNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushMessage('Push notifications are not supported by this browser.');
      return;
    }
    try {
      const configResponse = await fetch(`${API_BASE}/api/notifications/vapid-public-key`);
      const config = await configResponse.json();
      if (!configResponse.ok || !config.publicKey) throw new Error(config.error || 'Notifications are not configured yet.');
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Allow notifications in your browser settings to receive class alerts.');
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      const response = await fetch(`${API_BASE}/api/notifications/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.sessionToken}` },
        body: JSON.stringify(subscription)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not enable class alerts.');
      setPushEnabled(true);
      setPushMessage('Class alerts are on for this browser.');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'Could not enable class alerts.');
    }
  };

  const localCameraOn = room?.localParticipant.isCameraEnabled ?? mediaChoice.cameraEnabled;
  const localMicOn = androidScreenSharing ? androidMicOn : (room?.localParticipant.isMicrophoneEnabled ?? mediaChoice.micEnabled);
  const currentPanel = (next: typeof panel) => setPanel((old) => old === next ? null : next);
  const clockText = `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return <div className="meeting-shell">
    <header className="meeting-header"><div className="meeting-brand-wrap"><a className="brand meeting-brand" href="#" onClick={(e) => e.preventDefault()}><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo</span></a><span className="meeting-header-divider" /><div className="meeting-heading"><strong>{session.room.title}</strong><span>{session.room.language} lesson</span></div></div>
      <div className="meeting-header-actions"><span className={`connection-pill connection-${connection}`}><span className="online-dot" />{connection === 'connected' ? 'Connected' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'disconnected' ? 'Disconnected' : 'Connecting…'}</span><span className="meeting-clock"><span className={`record-dot ${isRecording ? 'record-dot-active' : ''}`} /> {clockText}</span><button className="icon-button" title="Copy invite link" aria-label="Copy invite link" onClick={copyInvite}><Copy size={17} /></button><button className="icon-button" title={pushEnabled ? 'Class alerts are enabled' : 'Enable class alerts'} aria-label={pushEnabled ? 'Class alerts are enabled' : 'Enable class alerts'} onClick={() => void enableClassNotifications()} disabled={pushEnabled}>{pushEnabled ? <Bell size={17} /> : <BellRing size={17} />}</button><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button" title="Help" aria-label="Help" onClick={() => alert('Tip: allow camera/microphone permissions, use the share menu to share screens, and use the right-side panels for chat, people, files, and private notes. Screen sharing and desktop audio depend on your browser and operating system.') }><CircleHelp size={18} /></button></div>
    </header>
    {pushMessage && <div className="meeting-alert"><Bell size={15} /><span>{pushMessage}</span><button aria-label="Dismiss notification message" onClick={() => setPushMessage('')}><X size={15} /></button></div>}
    {announcement && <div className="announcement-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setAnnouncement(''); }}><section className="announcement-popup" role="alertdialog" aria-modal="true" aria-label="Meeting announcement"><div className="announcement-popup-header"><span><Bell size={17} /> Meeting announcement</span><button aria-label="Dismiss announcement" onClick={() => setAnnouncement('')}><X size={18} /></button></div><p>{announcement}</p></section></div>}
    {mediaError && <div className="meeting-alert" role="status"><XCircle size={17} /><span>{mediaError}</span><button onClick={() => setMediaError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
    {endedMessage && <div className="meeting-ended-overlay"><div className="ended-card"><div className="ended-icon"><PhoneOff size={24} /></div><h2>Classroom ended</h2><p>{endedMessage}</p><button className="button button-primary" onClick={leave}>Return to Judo</button></div></div>}
    <main className={`meeting-main ${panel || peopleVisible ? 'meeting-main-with-panel' : ''} ${!panel && peopleVisible ? 'meeting-people-layout' : ''}`}>
      <section className="meeting-stage">
        <div className="stage-toolbar"><div className="stage-mode-switch"><button onClick={() => changeStage('video')} disabled={session.role !== 'teacher'} className={stage === 'video' ? 'active' : ''}><Video size={15} /> Video</button><button onClick={() => changeStage('board')} disabled={session.role !== 'teacher'} className={stage === 'board' ? 'active' : ''}><BookOpen size={15} /> Whiteboard</button></div><div className="stage-toolbar-right"><span className="participant-count"><Users size={15} /> {participants.length}</span><button className="button button-quiet button-xs" onClick={() => { setPanel(null); setPeopleVisible((visible) => !visible); }}><Users size={14} /> {peopleVisible ? 'Hide people' : 'Show people'}</button></div></div>
        {stage === 'video' ? <div className={`video-grid ${peopleVisible ? 'video-grid-panel-open' : 'video-grid-panel-closed'}`}>
          {videoTiles.flatMap(({ participant, camera, cameraOn, screens }) => {
            const isLocal = participant === room?.localParticipant;
            const displayName = participant.name || participant.identity;
            const raisedForUser = Boolean(hands[participant.identity.replace(/^(guest|teacher)-/, '')] || hands[participant.identity] || hands[participant.sid]);
            return [
              ...(cameraOn && camera ? [{ key: `${participant.identity}:camera`, participant, publication: camera, displayName, isLocal, cameraOn: true, screen: false, raised: raisedForUser }] : []),
              ...screens.filter((publication) => Boolean(publication.track) && !publication.isMuted).map((publication) => ({
                key: `${participant.identity}:${publication.trackSid || publication.trackName || 'screen'}`,
                participant,
                publication,
                displayName: `${displayName} · ${publication.trackName?.split('|')[1] || 'shared screen'}`,
                isLocal,
                cameraOn: true,
                screen: true,
                raised: false,
                publicationId: publication.trackSid || publication.trackName || 'screen'
              }))
            ];
          }).sort((a, b) => Number(b.screen && b.key === pinnedScreenId) - Number(a.screen && a.key === pinnedScreenId)).map((tile) => <VideoTile
            key={tile.key}
            participant={tile.participant}
            publication={tile.publication}
            displayName={tile.displayName}
            isLocal={tile.isLocal}
            cameraOn={tile.cameraOn}
            screen={tile.screen}
            raised={tile.raised}
            pinned={tile.screen && tile.key === pinnedScreenId}
            onPin={tile.screen ? () => setPinnedScreenId((old) => old === tile.key ? '' : tile.key) : undefined}
            onStop={tile.screen && tile.isLocal ? () => { const share = screenShares.find((item) => item.id === tile.publication.trackName?.split('|')[0]); if (share) stopScreenShare(share.id); } : undefined}
          />)}
          {participants.length === 0 && <div className="meeting-loading"><span className="spinner spinner-large" /><strong>Connecting to your classroom…</strong><span>Make sure the media server is running.</span></div>}
          {participants.length > 0 && !videoTiles.some(({ cameraOn, screens }) => cameraOn || screens.some((screen) => Boolean(screen.track) && !screen.isMuted)) && <div className="meeting-loading"><Users size={28} /><strong>No one is sharing video or a screen</strong><span>Participants remain available in the People panel.</span></div>}
        </div> : <Whiteboard socket={socket} participantId={session.participantId} canClear={session.role === 'teacher'} />}
        {reaction && <div className="reaction-toast"><span>{reaction.emoji}</span><strong>{reaction.displayName}</strong></div>}
        <div className="screen-share-strip">{screenShares.map((share) => <div className="screen-share-chip" key={share.id}><MonitorUp size={14} /><span>{share.label}{share.audioTrack ? ' · audio' : ''}</span><button onClick={() => stopScreenShare(share.id)} title={`Stop ${share.label}`} aria-label={`Stop ${share.label}`}><X size={13} /></button></div>)}</div>
      </section>
      {!panel && peopleVisible && <aside className="meeting-panel meeting-people-panel"><div className="panel-header"><div><h2>People</h2><span>{participants.length} in this classroom</span></div><div className="people-panel-actions"><Users size={18} /><button className="icon-button people-panel-close" onClick={() => setPeopleVisible(false)} aria-label="Close people panel"><X size={17} /></button></div></div><PeoplePanel participants={participants} localParticipant={room?.localParticipant || null} hands={hands} session={session} socket={socket} onAnnouncement={() => setShowAnnouncement(true)} onModerate={(identity, action) => socket?.emit('host:participant-control', { identity, action })} /></aside>}
      {panel && <aside className="meeting-panel"><div className="panel-header"><div><h2>{panel === 'chat' ? 'In-call messages' : panel === 'people' ? 'People' : panel === 'files' ? 'Class materials' : 'My private notes'}</h2><span>{panel === 'chat' ? 'Messages are visible to everyone' : panel === 'people' ? `${participants.length} in this classroom` : panel === 'files' ? 'Shared with this class' : 'Only you can see these notes'}</span></div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close panel"><PanelRightClose size={18} /></button></div>
        {panel === 'chat' && <ChatPanel messages={chatMessages} socket={socket} participantId={session.participantId} />}
        {panel === 'people' && <PeoplePanel participants={participants} localParticipant={room?.localParticipant || null} hands={hands} session={session} socket={socket} onAnnouncement={() => setShowAnnouncement(true)} onModerate={(identity, action) => socket?.emit('host:participant-control', { identity, action })} />}
        {panel === 'files' && <FilesPanel files={files} session={session} refreshFiles={refreshFiles} onError={setMediaError} />}
        {panel === 'notes' && <NotesPanel session={session} />}
      </aside>}
    </main>
    <div className="audio-track-bin" aria-hidden="true">{participants.flatMap((participant) => [...participant.trackPublications.values()].filter((publication) => publication.kind === Track.Kind.Audio).map((publication) => <AudioTrack key={`${participant.identity}-${publication.trackSid}`} participant={participant} publication={publication} isLocal={participant === room?.localParticipant} muted={audioMuted} />))}</div>
    <footer className="meeting-controls">
      <div className="meeting-control-left"><span className="class-code-pill">{session.room.code}</span><span className="role-tag">{session.role === 'teacher' ? 'Host' : 'Student'}</span></div>
      <div className="meeting-control-center">
        <div className="meeting-device-control"><button className={`meeting-control ${localMicOn ? '' : 'meeting-control-off'}`} onClick={toggleMic} title={localMicOn ? 'Mute microphone' : 'Unmute microphone'} aria-label={localMicOn ? 'Mute microphone' : 'Unmute microphone'}>{localMicOn ? <Mic size={20} /> : <MicOff size={20} />}<span>{localMicOn ? 'Mute' : 'Unmute'}</span></button><button className="device-picker-trigger" onClick={() => { setInputDeviceMenu((current) => current === 'microphone' ? null : 'microphone'); void refreshInputDevices(); }} aria-label="Choose microphone" title="Choose microphone"><ChevronDown size={13} /></button>{inputDeviceMenu === 'microphone' && <div className="input-device-popover"><label htmlFor="meeting-microphone">Microphone</label><select id="meeting-microphone" value={selectedMicId} onChange={(event) => void selectInputDevice('audioinput', event.target.value)}><option value="">System default</option>{microphones.map((device, index) => <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>}</div>
        <div className="meeting-device-control"><button className={`meeting-control ${localCameraOn ? '' : 'meeting-control-off'}`} onClick={toggleCamera} title={localCameraOn ? 'Turn camera off' : 'Turn camera on'} aria-label={localCameraOn ? 'Turn camera off' : 'Turn camera on'}>{localCameraOn ? <Video size={20} /> : <VideoOff size={20} />}<span>{localCameraOn ? 'Camera' : 'Camera off'}</span></button><button className="device-picker-trigger" onClick={() => { setInputDeviceMenu((current) => current === 'camera' ? null : 'camera'); void refreshInputDevices(); }} aria-label="Choose camera" title="Choose camera"><ChevronDown size={13} /></button>{inputDeviceMenu === 'camera' && <div className="input-device-popover"><label htmlFor="meeting-camera">Camera</label><select id="meeting-camera" value={selectedCameraId} onChange={(event) => void selectInputDevice('videoinput', event.target.value)}><option value="">System default</option>{cameras.map((device, index) => <option key={device.deviceId || `camera-${index}`} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>}</div>
        <div className="share-control-wrap mobile-direct-control"><button className={`meeting-control meeting-share ${screenShares.length || androidScreenSharing ? 'meeting-control-share-active' : ''}`} onClick={() => setShowShareMenu((v) => !v)} title="Share your screen"><MonitorUp size={20} /><span>Share screen</span><ChevronDown size={13} /></button>{showShareMenu && <div className="share-popover">{!navigator.userAgent.includes('JudoAndroidApp') && <label className="checkbox-row"><input type="checkbox" checked={shareAudio} onChange={(e) => setShareAudio(e.target.checked)} /><span><strong>Also share tab/system audio</strong><small>Available sources depend on your browser.</small></span></label>}{androidScreenSharing && <div className="share-active-row"><span><MonitorUp size={15} /> Phone screen is being shared</span><button className="button button-outline button-small" onClick={stopAndroidScreenShare}>Cancel share</button></div>}{screenShares.map((share) => <div className="share-active-row" key={share.id}><span><MonitorUp size={15} /> {share.label} is being shared</span><button className="button button-outline button-small" onClick={() => stopScreenShare(share.id)}>Cancel share</button></div>)}<button className="button button-primary button-wide" onClick={startScreenShare} disabled={androidScreenSharing && navigator.userAgent.includes('JudoAndroidApp')}><MonitorUp size={16} /> {navigator.userAgent.includes('JudoAndroidApp') ? (androidScreenSharing ? 'Phone screen shared' : 'Share phone screen') : (screenShares.length ? 'Share another screen' : 'Share a screen')}</button>{navigator.userAgent.includes('JudoAndroidApp') && !androidScreenSharing && <p className="share-hint">Android will ask you to approve screen capture.</p>}</div>}</div>
        <button className={`meeting-control mobile-direct-control ${raised ? 'meeting-control-hand-raised' : ''}`} onClick={toggleHand} title={raised ? 'Lower hand' : 'Raise hand'} aria-label={raised ? 'Lower hand' : 'Raise hand'}>{raised ? <Hand size={20} fill="currentColor" /> : <Hand size={20} />}<span>{raised ? 'Lower hand' : 'Raise hand'}</span></button>
        <button className="meeting-control mobile-direct-control" onClick={() => currentPanel('chat')} title="Open chat"><MessageCircle size={20} /><span>Chat</span>{chatMessages.length > 0 && <span className="control-badge">{chatMessages.length > 99 ? '99+' : chatMessages.length}</span>}</button>
        {navigator.userAgent.includes('JudoAndroidApp') && <div className="more-control-wrap"><button className="meeting-control" onClick={() => setShowAudioOutputs((visible) => !visible)} title="Audio output"><Volume2 size={20} /><span>Audio</span></button>{showAudioOutputs && <div className="more-popover audio-output-popover"><strong>Audio output</strong><button className={audioOutput === 'speaker' ? 'audio-output-selected' : ''} onClick={() => window.JudoNative?.setAudioOutput('speaker')}><Volume2 size={16} /> Speaker {audioOutput === 'speaker' ? '✓' : ''}</button><button className={audioOutput === 'earpiece' ? 'audio-output-selected' : ''} onClick={() => window.JudoNative?.setAudioOutput('earpiece')}><Headphones size={16} /> Earpiece {audioOutput === 'earpiece' ? '✓' : ''}</button><button className={audioMuted ? 'audio-output-selected' : ''} onClick={() => setAudioMuted((muted) => !muted)}>{audioMuted ? <Volume2 size={16} /> : <VolumeX size={16} />} {audioMuted ? 'Turn sound on' : 'Turn off sound'} {audioMuted ? '✓' : ''}</button><button className={audioOutput === 'bluetooth' ? 'audio-output-selected' : ''} onClick={() => window.JudoNative?.setAudioOutput('bluetooth')}><Bluetooth size={16} /> Bluetooth {audioOutput === 'bluetooth' ? '✓' : ''}</button></div>}</div>}
        <div className="more-control-wrap"><button className="meeting-control" onClick={() => setShowMore((v) => !v)} title="More controls"><MoreHorizontal size={21} /><span>More</span></button>{showMore && <div className="more-popover"><button className="mobile-menu-action" onClick={() => { currentPanel('chat'); setShowMore(false); }}><MessageCircle size={16} /> Chat{chatMessages.length > 0 ? ` (${chatMessages.length > 99 ? '99+' : chatMessages.length})` : ''}</button><button className="mobile-menu-action" onClick={() => { toggleHand(); setShowMore(false); }}>{raised ? <Hand size={16} fill="currentColor" /> : <Hand size={16} />} {raised ? 'Lower hand' : 'Raise hand'}</button><button className="mobile-menu-action" onClick={() => { if (androidScreenSharing) stopAndroidScreenShare(); else if (screenShares.length) screenShares.forEach((share) => void stopScreenShare(share.id)); else void startScreenShare(); setShowMore(false); }}>{androidScreenSharing || screenShares.length ? <X size={16} /> : <MonitorUp size={16} />} {androidScreenSharing || screenShares.length ? 'Stop screen sharing' : 'Share screen'}</button>{navigator.userAgent.includes('JudoAndroidApp') && (screenChoices.length ? screenChoices.map((screen) => <button className="mobile-menu-action" key={screen.key} onClick={() => { setPinnedScreenId((old) => old === screen.key ? '' : screen.key); setStage('video'); setShowMore(false); }}><Pin size={16} /> {pinnedScreenId === screen.key ? `Unpin ${screen.label}` : `Pin ${screen.label}`}</button>) : <button className="mobile-menu-action" disabled><Pin size={16} /> No shared screen to pin</button>)}{navigator.userAgent.includes('JudoAndroidApp') && <button onClick={() => { void toggleCamera(); setShowMore(false); }}>{localCameraOn ? <VideoOff size={16} /> : <Video size={16} />} {localCameraOn ? 'Turn camera off' : 'Turn camera on'}</button>}<button onClick={() => { currentPanel('people'); setShowMore(false); }}><Users size={16} /> People</button><button onClick={() => { currentPanel('files'); setShowMore(false); }}><Paperclip size={16} /> Class materials</button><button onClick={() => { currentPanel('notes'); setShowMore(false); }}><FileText size={16} /> Private notes</button><button onClick={() => { changeStage('board'); setShowMore(false); }}><BookOpen size={16} /> Shared whiteboard</button><button onClick={isRecording ? stopRecording : startRecording} className={isRecording ? 'recording-menu-action' : ''}>{isRecording ? <Square size={16} fill="currentColor" /> : <Circle size={16} />} {isRecording ? 'Stop and save recording' : 'Record class to this device'}</button><div className="reaction-picker">{['👏', '👍', '❤️', '😂', '🎉', '🙌'].map((emoji) => <button key={emoji} aria-label={`React ${emoji}`} onClick={() => { sendReaction(emoji); setShowMore(false); }}>{emoji}</button>)}</div>{session.role === 'teacher' && <button onClick={() => { setShowAnnouncement(true); setShowMore(false); }}><Bell size={16} /> Make announcement</button>}</div>}</div>
      </div>
      <div className="meeting-control-right"><button className="leave-button" onClick={leave} title="Leave classroom"><PhoneOff size={19} /><span>Leave</span></button>{session.role === 'teacher' && <button className="end-meeting-button" onClick={endMeeting} title="End classroom for everyone"><X size={17} /> End for all</button>}</div>
    </footer>
    {showAnnouncement && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAnnouncement(false); }}><div className="modal-card small-modal" role="dialog" aria-modal="true"><div className="modal-head"><div><span className="eyebrow">TEACHER TOOL</span><h2>Class announcement</h2></div><button className="icon-button" onClick={() => setShowAnnouncement(false)} aria-label="Close"><X size={18} /></button></div><form className="join-form" onSubmit={(e) => { e.preventDefault(); const input = (e.currentTarget.elements.namedItem('announcement') as HTMLInputElement); const message = input.value.trim(); if (message) { socket?.emit('meeting:announcement', { message }); setShowAnnouncement(false); setAnnouncement(`You: ${message}`); } }}><label htmlFor="announcement">Message for everyone</label><input id="announcement" name="announcement" autoFocus maxLength={500} placeholder="e.g. Please open page 12 in your workbook." required /><div className="modal-actions"><button type="button" className="button button-outline" onClick={() => setShowAnnouncement(false)}>Cancel</button><button type="submit" className="button button-primary"><Send size={16} /> Send announcement</button></div></form></div></div>}
  </div>;
}

function VideoTile({ participant, publication, displayName, isLocal, cameraOn, screen = false, raised, onStop, pinned = false, onPin }: {
  participant: Participant; publication?: TrackPublication; displayName: string; isLocal: boolean; cameraOn: boolean; screen?: boolean; raised?: boolean; onStop?: () => void; pinned?: boolean; onPin?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const track = publication?.track;
  useEffect(() => {
    if (!track) return;
    if (track.kind === Track.Kind.Video && videoRef.current) {
      track.attach(videoRef.current);
      return () => { track.detach(videoRef.current!); };
    }
    if (track.kind === Track.Kind.Audio && audioRef.current && !isLocal) {
      track.attach(audioRef.current);
      return () => { track.detach(audioRef.current!); };
    }
  }, [track, isLocal]);
  const isScreen = screen || publication?.source === Track.Source.ScreenShare;
  const activeSpeaker = participant.isSpeaking;
  const micOn = participant.isMicrophoneEnabled;
  const actualName = displayName;
  const toggleFullscreen = async () => { if (!tileRef.current) return; try { if (document.fullscreenElement === tileRef.current) await document.exitFullscreen(); else await tileRef.current.requestFullscreen(); } catch { /* Fullscreen can be blocked by browser policy. */ } };
  return <article ref={tileRef} className={`video-tile ${isScreen ? 'screen-tile' : ''} ${activeSpeaker && !isScreen ? 'tile-speaking' : ''}`}>
    {publication?.kind === Track.Kind.Video && cameraOn && <video ref={videoRef} autoPlay playsInline muted={isLocal} className="tile-video" />}
    <audio ref={audioRef} autoPlay muted={isLocal} />
    {!isScreen && !cameraOn && <div className="tile-avatar-state"><div className="tile-avatar">{(participant.name || participant.identity || '?').slice(0, 1).toUpperCase()}</div><span>{isLocal ? 'Your camera is off' : 'Camera off'}</span></div>}
    {isScreen && !cameraOn && <div className="tile-avatar-state"><MonitorUp size={28} /><span>Screen share unavailable</span></div>}
    <div className="tile-overlay"><div className="tile-name"><span className="tile-live-dot" />{actualName}{isLocal ? ' (You)' : ''}</div><div className="tile-status-icons">{raised && <span className="raised-hand-badge"><Hand size={14} /></span>}{!isScreen && <span className={`mic-status ${micOn ? '' : 'mic-status-off'} ${activeSpeaker ? 'mic-speaking' : ''}`}>{micOn ? <Mic size={13} /> : <MicOff size={13} />}</span>}{isScreen && <span className="mic-status"><MonitorUp size={13} /></span>}</div></div>
    {isScreen && onPin && <button className={`tile-pin ${pinned ? 'tile-pin-active' : ''}`} onClick={onPin} aria-label={pinned ? `Unpin ${actualName} from top` : `Pin ${actualName} to top`} title={pinned ? 'Unpin screen' : 'Pin screen to top'}><Pin size={14} />{pinned && <span>Pinned</span>}</button>}
    {isLocal && isScreen && onStop && <button className="tile-stop-share" onClick={onStop}><Square size={12} fill="currentColor" /> Stop sharing</button>}
    <button className="tile-fullscreen" onClick={toggleFullscreen} aria-label={`View ${actualName} ${isScreen ? 'screen' : 'video'} fullscreen`} title="Full screen"><Maximize2 size={15} /></button>
    {isLocal && !isScreen && <span className="local-preview-pill">You</span>}
  </article>;
}


function AudioTrack({ participant: _participant, publication, isLocal, muted = false }: { participant: Participant; publication: TrackPublication; isLocal: boolean; muted?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const track = publication.track;
  useEffect(() => {
    if (isLocal || !track || track.kind !== Track.Kind.Audio || !audioRef.current) return;
    track.attach(audioRef.current);
    return () => { track.detach(audioRef.current!); };
  }, [track, isLocal]);
  return <audio ref={audioRef} autoPlay playsInline muted={muted} />;
}

function ChatPanel({ messages, socket, participantId }: { messages: ChatMessage[]; socket: Socket | null; participantId: string }) {
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendState, setSendState] = useState<{ pending: boolean; error: string }>({ pending: false, error: '' });
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages.length]);
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sendState.pending) return;
    if (!socket?.connected) { setSendState({ pending: false, error: 'You are reconnecting. Your message is still here; try again when connected.' }); return; }
    setSendState({ pending: true, error: '' });
    socket.timeout(8000).emit('chat:send', { body }, (timeoutError: Error | null, result: { ok?: boolean; error?: string }) => {
      if (timeoutError) { setSendState({ pending: false, error: 'No delivery confirmation yet. Your message is still here; check the connection and try again.' }); return; }
      if (!result?.ok) { setSendState({ pending: false, error: result?.error || 'Message was not sent. Please try again.' }); return; }
      setDraft((current) => current === body ? '' : current);
      setSendState({ pending: false, error: '' });
      setEmojiOpen(false);
    });
  };
  return <div className="chat-panel-content"><div className="chat-guideline"><ShieldCheck size={15} /><span>Be respectful. Messages are visible to everyone in this classroom.</span></div><div className="chat-messages" ref={scrollRef}>{messages.length === 0 ? <div className="panel-empty"><div className="empty-illustration"><MessageCircle size={25} /></div><strong>Start the conversation</strong><span>Send a message to your classmates or teacher.</span></div> : messages.map((message) => <article className={`chat-message ${message.senderId === participantId ? 'chat-message-own' : ''}`} key={message.id}><div className="chat-message-avatar">{message.senderName?.[0]?.toUpperCase() || '?'}</div><div className="chat-message-body"><div className="chat-message-meta"><strong>{message.senderName}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.body}</p></div></article>)}</div><form className="chat-composer" onSubmit={send}><div className="chat-composer-wrap"><textarea rows={2} value={draft} onChange={(e) => { setDraft(e.target.value); if (sendState.error) setSendState({ pending: false, error: '' }); }} placeholder="Send a message…" maxLength={2000} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement)?.requestSubmit(); } }} /><div className="chat-composer-tools"><div className="emoji-wrap"><button className="composer-tool" type="button" title="Add emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={17} /></button>{emojiOpen && <div className="composer-emoji-pop">{['🙂', '👏', '👍', '❤️', '😂', '🎉'].map((emoji) => <button type="button" key={emoji} onClick={() => { setDraft((old) => old + emoji); setEmojiOpen(false); }}>{emoji}</button>)}</div>}</div><span className="composer-hint">{sendState.pending ? 'Sending…' : 'Enter to send'}</span><button className="send-button" type="submit" disabled={!draft.trim() || sendState.pending} aria-label="Send message"><Send size={16} /></button></div></div>{sendState.error && <p className="form-error" role="alert">{sendState.error}</p>}</form></div>;
}

function PeoplePanel({ participants, localParticipant, hands, session, socket, onAnnouncement, onModerate }: {
  participants: Participant[]; localParticipant: Participant | null; hands: Record<string, boolean>; session: RoomSession; socket: Socket | null; onAnnouncement: () => void;
  onModerate: (identity: string, action: 'mute-microphone' | 'disable-camera' | 'stop-screen-share' | 'remove') => void;
}) {
  return <div className="people-panel-content"><div className="people-count-line"><span>In this classroom</span><strong>{participants.length}</strong></div><div className="people-list">{participants.map((p) => {
    const isLocal = p === localParticipant;
    const name = p.name || p.identity;
    const isSharingScreen = [...p.trackPublications.values()].some((publication) => publication.source === Track.Source.ScreenShare && !publication.isMuted);
    const canModerate = session.role === 'teacher' && !isLocal && p.identity.startsWith('guest-');
    return <div className={`person-row ${p.isSpeaking ? 'person-speaking' : ''}`} key={p.sid || p.identity}>
      <div className={`person-avatar ${isLocal ? 'person-avatar-own' : ''}`}>{name.slice(0, 1).toUpperCase()}</div>
      <div className="person-info"><strong>{name}{isLocal ? ' (You)' : ''}</strong><span>{p.isSpeaking ? 'Speaking' : isLocal ? session.role === 'teacher' ? 'Host' : 'You' : 'Participant'}</span></div>
      <div className="person-badges">{(hands[p.identity.replace(/^(guest|teacher)-/, '')] || hands[p.identity]) && <span className="raised-hand-badge"><Hand size={13} /></span>}{p.isMicrophoneEnabled ? <Mic size={15} className={p.isSpeaking ? 'person-mic-speaking' : ''} /> : <MicOff size={15} className="muted-icon" />}{p.isCameraEnabled ? <Video size={15} /> : <VideoOff size={15} className="muted-icon" />}</div>
      {canModerate && <div className="person-moderation">
        {p.isMicrophoneEnabled && <button aria-label={`Mute ${name}`} title="Mute microphone" onClick={() => onModerate(p.identity, 'mute-microphone')}><MicOff size={14} /></button>}
        {p.isCameraEnabled && <button aria-label={`Turn off camera for ${name}`} title="Turn off camera" onClick={() => onModerate(p.identity, 'disable-camera')}><VideoOff size={14} /></button>}
        {isSharingScreen && <button aria-label={`Stop screen sharing for ${name}`} title="Stop screen sharing" onClick={() => onModerate(p.identity, 'stop-screen-share')}><MonitorUp size={14} /></button>}
        <button className="person-remove-button" aria-label={`Remove ${name} from classroom`} title="Remove from classroom" onClick={() => { if (window.confirm(`Remove ${name} from this classroom?`)) onModerate(p.identity, 'remove'); }}><X size={14} /></button>
      </div>}
    </div>;
  })}</div>{session.role === 'teacher' && <button className="button button-outline button-wide announcement-action" onClick={onAnnouncement}><Bell size={16} /> Make announcement</button>}<div className="people-safety-note"><ShieldCheck size={16} /><span>Names in a guest classroom are self-selected and are not identity-verified.</span></div><button className="button button-quiet button-wide" onClick={() => socket?.emit('meeting:reaction', { emoji: '👏' })}><Sparkles size={16} /> Celebrate the class</button></div>;
}

function FilesPanel({ files, session, refreshFiles, onError }: { files: ClassroomFile[]; session: RoomSession; refreshFiles: () => void; onError: (value: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (!picked?.length) return;
    setUploading(true);
    try { await uploadFiles(session.room.code, picked); await refreshFiles(); }
    catch (err) { onError(err instanceof Error ? err.message : 'Upload failed.'); }
    finally { setUploading(false); event.target.value = ''; }
  };
  const prettySize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return <div className="files-panel-content"><label className={`upload-dropzone ${uploading ? 'uploading' : ''}`}><input type="file" multiple accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.jpg,.jpeg,.png,.webp" onChange={handleUpload} disabled={uploading} /><span className="upload-icon"><Paperclip size={21} /></span><strong>{uploading ? 'Uploading files…' : 'Share lesson materials'}</strong><small>PDF, DOCX, PPTX, TXT, JPG, PNG · up to 15 MB each</small><span className="button button-outline button-small">{uploading ? 'Please wait' : 'Choose files'}</span></label><div className="file-list-heading"><strong>Shared files</strong><span>{files.length}</span></div>{files.length === 0 ? <div className="panel-empty compact-empty"><FileText size={26} /><strong>No files shared yet</strong><span>Materials uploaded here are available to everyone in this room.</span></div> : <div className="shared-file-list">{files.map((file) => <div className="shared-file-row" key={file.id}><div className="shared-file-icon"><FileText size={19} /></div><div className="shared-file-info"><strong title={file.originalName}>{file.originalName}</strong><span>{prettySize(file.sizeBytes)} · {file.uploaderName}</span></div><button className="icon-button" aria-label={`Download ${file.originalName}`} title="Download" disabled={busyId === file.id} onClick={async () => { setBusyId(file.id); try { await downloadFile(file.id, file.originalName, session.sessionToken); } catch (err) { onError(err instanceof Error ? err.message : 'Download failed.'); } finally { setBusyId(''); } }}><ArrowUpRight size={17} /></button></div>)}</div>}<p className="file-warning"><ShieldCheck size={14} /> Upload only classroom materials you have permission to share.</p></div>;
}

function NotesPanel({ session }: { session: RoomSession }) {
  const [notes, setNotes] = useState<PersonalNote[]>([]);
  const [activeId, setActiveId] = useState('');
  const [title, setTitle] = useState('Class notes');
  const [content, setContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'loading' | 'saved' | 'saving' | 'unsaved' | 'error'>('loading');
  const [filter, setFilter] = useState('');
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const initialLoad = useRef(true);
  const selectionVersion = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    getNotes(session.sessionToken).then(({ notes: loaded }) => {
      if (cancelled) return;
      setNotes(loaded);
      if (loaded.length) { setActiveId(loaded[0].id); setTitle(loaded[0].title); setContent(loaded[0].content); }
      else { setActiveId(''); setTitle(`${session.room.language} class notes`); setContent(''); }
      setSaveStatus('saved'); initialLoad.current = false;
    }).catch(() => { if (!cancelled) setSaveStatus('error'); });
    return () => { cancelled = true; };
  }, [session.sessionToken, session.room.language]);

  useEffect(() => {
    if (initialLoad.current || saveStatus === 'loading') return;
    const version = selectionVersion.current;
    setSaveStatus('unsaved');
    const timer = window.setTimeout(async () => {
      setSaveStatus('saving');
      // Capture the selected note when this request starts. A later note switch must
      // not let this response change the new selection or its save indicator.
      const noteId = activeIdRef.current;
      const request = saveQueue.current.then(() => saveNote({ id: noteId || undefined, title, content }, session.sessionToken));
      // Keep writes in order so an older, slower request cannot overwrite newer edits.
      saveQueue.current = request.catch(() => undefined);
      try {
        const { note } = await request;
        setNotes((old) => [note, ...old.filter((item) => item.id !== note.id)]);
        if (selectionVersion.current === version) {
          setActiveId(note.id); activeIdRef.current = note.id;
          setSaveStatus('saved');
        }
      } catch {
        if (selectionVersion.current === version) setSaveStatus('error');
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [title, content, session.sessionToken]);

  const makeNew = () => { selectionVersion.current += 1; initialLoad.current = true; setActiveId(''); activeIdRef.current = ''; setTitle(`${session.room.language} class notes`); setContent(''); window.setTimeout(() => { initialLoad.current = false; }, 0); };
  const chooseNote = (note: PersonalNote) => { selectionVersion.current += 1; initialLoad.current = true; setActiveId(note.id); activeIdRef.current = note.id; setTitle(note.title); setContent(note.content); setSaveStatus('saved'); window.setTimeout(() => { initialLoad.current = false; }, 0); };
  const download = (format: 'txt' | 'md') => {
    const blob = new Blob([format === 'md' ? `# ${title}\n\n${content}` : `${title}\n\n${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'class-notes'}.${format}`; anchor.click(); URL.revokeObjectURL(url);
  };
  const statusText = saveStatus === 'loading' ? 'Loading notes…' : saveStatus === 'saving' ? 'Saving…' : saveStatus === 'unsaved' ? 'Unsaved changes' : saveStatus === 'error' ? 'Save failed' : 'Saved privately';
  const filteredNotes = notes.filter((note) => `${note.title} ${note.content}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="notes-panel-content"><div className="notes-privacy-line"><ShieldCheck size={15} /><span>Only your identity can access these notes. They are never sent to chat or the whiteboard.</span></div><div className="notes-toolbar"><span className={`note-save-status note-${saveStatus}`}><span className="save-dot" />{statusText}</span><button className="button button-quiet button-xs" onClick={makeNew}>+ New note</button></div>{notes.length > 1 && <><input className="note-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search my notes…" /><div className="notes-history-list">{filteredNotes.slice(0, 5).map((note) => <button className={`note-history-item ${activeId === note.id ? 'note-history-active' : ''}`} key={note.id} onClick={() => chooseNote(note)}><FileText size={14} /><span>{note.title || 'Class notes'}</span></button>)}</div></>}
    <div className="note-editor"><input className="note-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Note title" maxLength={120} /><div className="note-format-row"><span>PERSONAL NOTEBOOK</span><div><button onClick={() => setContent((old) => old ? `${old}\n- ` : '- ')} title="Add bullet list">• List</button><button onClick={() => setContent((old) => old ? `${old}\n## ` : '## ')} title="Add heading">H</button></div></div><textarea className="note-editor-textarea" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Vocabulary, useful phrases, grammar notes…" /><div className="note-export-row"><button onClick={() => download('txt')}>Download .TXT</button><button onClick={() => download('md')}>Download .MD</button></div></div>
    {activeId && <button className="button button-danger-quiet button-wide delete-note-button" onClick={async () => { if (!confirm('Delete this private note permanently?')) return; try { await deleteNote(activeId, session.sessionToken); const remaining = notes.filter((n) => n.id !== activeId); setNotes(remaining); if (remaining[0]) chooseNote(remaining[0]); else makeNew(); } catch { setSaveStatus('error'); } }}>Delete this note</button>}
    <p className="note-recovery-hint">Guest notes are recoverable only with the same browser identity storage. A display name alone cannot restore notes on another device.</p></div>;
}
