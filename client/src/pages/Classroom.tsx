import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { LocalVideoTrack, Participant, Room, RoomEvent, Track, TrackPublication } from 'livekit-client';
import {
  ArrowLeft, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, CircleHelp, Copy, FileText, Hand, Headphones,
  MessageCircle, Mic, MicOff, MonitorUp, MoreHorizontal, Maximize2, PanelRightClose, Paperclip, PhoneOff, Pin, Send,
  Settings2, ShieldCheck, Smile, Sparkles, Square, Sun, Moon, Users, Video, VideoOff, Volume2, X, Wifi, XCircle
} from 'lucide-react';
import {
  API_BASE, ChatMessage, ClassroomFile, PersonalNote, RoomSession, downloadFile, endRoom, getFiles,
  getNotes, saveNote, uploadFiles, deleteNote
} from '../api';
import Whiteboard from '../components/Whiteboard';

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
  const [reaction, setReaction] = useState<{ displayName: string; emoji: string; id: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const shareRef = useRef(screenShares);
  const stoppingSharesRef = useRef(new Set<string>());
  const startedAt = useRef(Date.now());
  shareRef.current = screenShares;

  const bump = useCallback(() => setRefreshKey((v) => v + 1), []);

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
        await liveRoom.localParticipant.setMicrophoneEnabled(mediaChoice.micEnabled, mediaChoice.micId ? { deviceId: mediaChoice.micId } : undefined);
      } catch (err) {
        publishErrors.push(`microphone: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await liveRoom.localParticipant.setCameraEnabled(mediaChoice.cameraEnabled, mediaChoice.cameraId ? { deviceId: mediaChoice.cameraId } : undefined);
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
    classroomSocket.on('meeting:reaction', (data: { displayName: string; emoji: string; sessionId: string }) => {
      setReaction({ displayName: data.displayName, emoji: data.emoji, id: `${data.sessionId}-${Date.now()}` });
      window.setTimeout(() => setReaction(null), 2600);
    });
    classroomSocket.on('meeting:announcement', (data: { displayName: string; message: string }) => setAnnouncement(`${data.displayName}: ${data.message}`));
    setSocket(classroomSocket);

    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 60000)), 30000);
    return () => {
      active = false;
      window.clearInterval(tick);
      classroomSocket.disconnect();
      shareRef.current.forEach((share) => { share.videoTrack.stop(); share.audioTrack?.stop(); });
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
    });
  }, [participants, refreshKey]);

  const toggleMic = async () => {
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
  const leave = () => { if (room) room.disconnect(); onLeave(); };

  const localCameraOn = room?.localParticipant.isCameraEnabled ?? mediaChoice.cameraEnabled;
  const localMicOn = room?.localParticipant.isMicrophoneEnabled ?? mediaChoice.micEnabled;
  const currentPanel = (next: typeof panel) => setPanel((old) => old === next ? null : next);

  return <div className="meeting-shell">
    <header className="meeting-header"><div className="meeting-brand-wrap"><a className="brand meeting-brand" href="#" onClick={(e) => e.preventDefault()}><span className="brand-mark"><BookOpen size={18} /></span><span>Judo</span></a><span className="meeting-header-divider" /><div className="meeting-heading"><strong>{session.room.title}</strong><span>{session.room.language} lesson</span></div></div>
      <div className="meeting-header-actions"><span className={`connection-pill connection-${connection}`}><span className="online-dot" />{connection === 'connected' ? 'Connected' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'disconnected' ? 'Disconnected' : 'Connecting…'}</span><span className="meeting-clock"><span className="record-dot" /> {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span><button className="icon-button" title="Copy invite link" aria-label="Copy invite link" onClick={copyInvite}><Copy size={17} /></button><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button" title="Help" aria-label="Help" onClick={() => alert('Tip: allow camera/microphone permissions, use the share menu to share screens, and use the right-side panels for chat, people, files, and private notes. Screen sharing and desktop audio depend on your browser and operating system.') }><CircleHelp size={18} /></button></div>
    </header>
    {announcement && <div className="announcement-banner"><Bell size={16} /><span>{announcement}</span><button aria-label="Dismiss announcement" onClick={() => setAnnouncement('')}><X size={15} /></button></div>}
    {mediaError && <div className="meeting-alert" role="status"><XCircle size={17} /><span>{mediaError}</span><button onClick={() => setMediaError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
    {endedMessage && <div className="meeting-ended-overlay"><div className="ended-card"><div className="ended-icon"><PhoneOff size={24} /></div><h2>Classroom ended</h2><p>{endedMessage}</p><button className="button button-primary" onClick={leave}>Return to Judo</button></div></div>}
    <main className={`meeting-main ${panel || peopleVisible ? 'meeting-main-with-panel' : ''} ${!panel && peopleVisible ? 'meeting-people-layout' : ''}`}>
      <section className="meeting-stage">
        <div className="stage-toolbar"><div className="stage-mode-switch"><button onClick={() => changeStage('video')} disabled={session.role !== 'teacher'} className={stage === 'video' ? 'active' : ''}><Video size={15} /> Video</button><button onClick={() => changeStage('board')} disabled={session.role !== 'teacher'} className={stage === 'board' ? 'active' : ''}><BookOpen size={15} /> Whiteboard</button></div><div className="stage-toolbar-right"><span className="stage-help">{session.role === 'teacher' ? 'Choose a view for the whole class' : 'The teacher chooses what everyone sees'}</span><span className="participant-count"><Users size={15} /> {participants.length}</span><button className="button button-quiet button-xs" onClick={() => { setPanel(null); setPeopleVisible((visible) => !visible); }}><Users size={14} /> {peopleVisible ? 'Hide people' : 'Show people'}</button></div></div>
        {stage === 'video' ? <div className={`video-grid ${peopleVisible ? 'video-grid-panel-open' : 'video-grid-panel-closed'}`}>
          {videoTiles.filter(({ cameraOn, screens }) => cameraOn || screens.some((screen) => Boolean(screen.track) && !screen.isMuted)).map(({ participant, camera, cameraOn, screens }) => {
            const isLocal = participant === room?.localParticipant;
            const displayName = participant.name || participant.identity;
            return <div className="participant-wrap" key={participant.sid || participant.identity}>
              {cameraOn && <VideoTile participant={participant} publication={camera} displayName={displayName} isLocal={isLocal} cameraOn raised={Boolean(hands[participant.identity.replace(/^(guest|teacher)-/, '')] || hands[participant.identity] || hands[participant.sid])} />}
              {screens.filter((publication) => Boolean(publication.track) && !publication.isMuted).map((publication) => <VideoTile key={`${participant.identity}-${publication.trackSid}`} participant={participant} publication={publication} displayName={`${displayName} · ${publication.trackName?.split('|')[1] || 'shared screen'}`} isLocal={isLocal} cameraOn screen onStop={() => { if (isLocal) { const share = screenShares.find((item) => item.id === publication.trackName?.split('|')[0]); if (share) stopScreenShare(share.id); } }} />)}
            </div>;
          })}
          {participants.length === 0 && <div className="meeting-loading"><span className="spinner spinner-large" /><strong>Connecting to your classroom…</strong><span>Make sure the media server is running.</span></div>}
          {participants.length > 0 && !videoTiles.some(({ cameraOn, screens }) => cameraOn || screens.some((screen) => Boolean(screen.track) && !screen.isMuted)) && <div className="meeting-loading"><Users size={28} /><strong>No one is sharing video or a screen</strong><span>Participants remain available in the People panel.</span></div>}
        </div> : <Whiteboard socket={socket} participantId={session.participantId} canClear={session.role === 'teacher'} />}
        {reaction && <div className="reaction-toast"><span>{reaction.emoji}</span><strong>{reaction.displayName}</strong></div>}
        <div className="screen-share-strip">{screenShares.map((share) => <div className="screen-share-chip" key={share.id}><MonitorUp size={14} /><span>{share.label}{share.audioTrack ? ' · audio' : ''}</span><button onClick={() => stopScreenShare(share.id)} title={`Stop ${share.label}`} aria-label={`Stop ${share.label}`}><X size={13} /></button></div>)}</div>
      </section>
      {!panel && peopleVisible && <aside className="meeting-panel meeting-people-panel"><div className="panel-header"><div><h2>People</h2><span>{participants.length} in this classroom</span></div><Users size={18} /></div><PeoplePanel participants={participants} localParticipant={room?.localParticipant || null} hands={hands} session={session} socket={socket} onAnnouncement={() => setShowAnnouncement(true)} /></aside>}
      {panel && <aside className="meeting-panel"><div className="panel-header"><div><h2>{panel === 'chat' ? 'In-call messages' : panel === 'people' ? 'People' : panel === 'files' ? 'Class materials' : 'My private notes'}</h2><span>{panel === 'chat' ? 'Messages are visible to everyone' : panel === 'people' ? `${participants.length} in this classroom` : panel === 'files' ? 'Shared with this class' : 'Only you can see these notes'}</span></div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close panel"><PanelRightClose size={18} /></button></div>
        {panel === 'chat' && <ChatPanel messages={chatMessages} socket={socket} participantId={session.participantId} />}
        {panel === 'people' && <PeoplePanel participants={participants} localParticipant={room?.localParticipant || null} hands={hands} session={session} socket={socket} onAnnouncement={() => setShowAnnouncement(true)} />}
        {panel === 'files' && <FilesPanel files={files} session={session} refreshFiles={refreshFiles} onError={setMediaError} />}
        {panel === 'notes' && <NotesPanel session={session} />}
      </aside>}
    </main>
    <div className="audio-track-bin" aria-hidden="true">{participants.flatMap((participant) => [...participant.trackPublications.values()].filter((publication) => publication.kind === Track.Kind.Audio).map((publication) => <AudioTrack key={`${participant.identity}-${publication.trackSid}`} participant={participant} publication={publication} isLocal={participant === room?.localParticipant} />))}</div>
    <footer className="meeting-controls">
      <div className="meeting-control-left"><span className="class-code-pill">{session.room.code}</span><span className="role-tag">{session.role === 'teacher' ? 'Host' : 'Student'}</span></div>
      <div className="meeting-control-center">
        <button className={`meeting-control ${localMicOn ? '' : 'meeting-control-off'}`} onClick={toggleMic} title={localMicOn ? 'Mute microphone' : 'Unmute microphone'} aria-label={localMicOn ? 'Mute microphone' : 'Unmute microphone'}>{localMicOn ? <Mic size={20} /> : <MicOff size={20} />}<span>{localMicOn ? 'Mute' : 'Unmute'}</span></button>
        <button className={`meeting-control ${localCameraOn ? '' : 'meeting-control-off'}`} onClick={toggleCamera} title={localCameraOn ? 'Turn camera off' : 'Turn camera on'} aria-label={localCameraOn ? 'Turn camera off' : 'Turn camera on'}>{localCameraOn ? <Video size={20} /> : <VideoOff size={20} />}<span>{localCameraOn ? 'Camera' : 'Camera off'}</span></button>
        <div className="share-control-wrap"><button className={`meeting-control meeting-share ${screenShares.length ? 'meeting-control-active' : ''}`} onClick={() => setShowShareMenu((v) => !v)} title="Share your screen"><MonitorUp size={20} /><span>Share screen</span><ChevronDown size={13} /></button>{showShareMenu && <div className="share-popover"><label className="checkbox-row"><input type="checkbox" checked={shareAudio} onChange={(e) => setShareAudio(e.target.checked)} /><span><strong>Also share tab/system audio</strong><small>Only if your browser offers audio for the selected source.</small></span></label><button className="button button-primary button-wide" onClick={startScreenShare}><MonitorUp size={16} /> Share another screen</button><span className="muted small-text">Multiple shares may be limited by the browser or operating system.</span></div>}</div>
        <button className={`meeting-control ${raised ? 'meeting-control-active' : ''}`} onClick={toggleHand} title={raised ? 'Lower hand' : 'Raise hand'} aria-label={raised ? 'Lower hand' : 'Raise hand'}>{raised ? <Hand size={20} fill="currentColor" /> : <Hand size={20} />}<span>{raised ? 'Lower hand' : 'Raise hand'}</span></button>
        <button className="meeting-control" onClick={() => currentPanel('chat')} title="Open chat"><MessageCircle size={20} /><span>Chat</span>{chatMessages.length > 0 && <span className="control-badge">{chatMessages.length > 99 ? '99+' : chatMessages.length}</span>}</button>
        <div className="more-control-wrap"><button className="meeting-control" onClick={() => setShowMore((v) => !v)} title="More controls"><MoreHorizontal size={21} /><span>More</span></button>{showMore && <div className="more-popover"><button onClick={() => { currentPanel('people'); setShowMore(false); }}><Users size={16} /> People</button><button onClick={() => { currentPanel('files'); setShowMore(false); }}><Paperclip size={16} /> Class materials</button><button onClick={() => { currentPanel('notes'); setShowMore(false); }}><FileText size={16} /> Private notes</button><button onClick={() => { changeStage('board'); setShowMore(false); }}><BookOpen size={16} /> Shared whiteboard</button><div className="reaction-picker">{['👏', '👍', '❤️', '😂', '🎉', '🙌'].map((emoji) => <button key={emoji} aria-label={`React ${emoji}`} onClick={() => { sendReaction(emoji); setShowMore(false); }}>{emoji}</button>)}</div>{session.role === 'teacher' && <button onClick={() => { setShowAnnouncement(true); setShowMore(false); }}><Bell size={16} /> Make announcement</button>}</div>}</div>
      </div>
      <div className="meeting-control-right"><button className="leave-button" onClick={leave} title="Leave classroom"><PhoneOff size={19} /><span>Leave</span></button>{session.role === 'teacher' && <button className="end-meeting-button" onClick={endMeeting} title="End classroom for everyone"><X size={17} /> End for all</button>}</div>
    </footer>
    {showAnnouncement && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAnnouncement(false); }}><div className="modal-card small-modal" role="dialog" aria-modal="true"><div className="modal-head"><div><span className="eyebrow">TEACHER TOOL</span><h2>Class announcement</h2></div><button className="icon-button" onClick={() => setShowAnnouncement(false)} aria-label="Close"><X size={18} /></button></div><form className="join-form" onSubmit={(e) => { e.preventDefault(); const input = (e.currentTarget.elements.namedItem('announcement') as HTMLInputElement); const message = input.value.trim(); if (message) { socket?.emit('meeting:announcement', { message }); setShowAnnouncement(false); setAnnouncement(`You: ${message}`); } }}><label htmlFor="announcement">Message for everyone</label><input id="announcement" name="announcement" autoFocus maxLength={500} placeholder="e.g. Please open page 12 in your workbook." required /><div className="modal-actions"><button type="button" className="button button-outline" onClick={() => setShowAnnouncement(false)}>Cancel</button><button type="submit" className="button button-primary"><Send size={16} /> Send announcement</button></div></form></div></div>}
  </div>;
}

function VideoTile({ participant, publication, displayName, isLocal, cameraOn, screen = false, raised, onStop }: {
  participant: Participant; publication?: TrackPublication; displayName: string; isLocal: boolean; cameraOn: boolean; screen?: boolean; raised?: boolean; onStop?: () => void;
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
    <div className="tile-overlay"><div className="tile-name"><span className="tile-live-dot" />{actualName}{isLocal ? ' (You)' : ''}</div><div className="tile-status-icons">{raised && <span className="raised-hand-badge"><Hand size={14} /></span>}{!isScreen && <span className={`mic-status ${micOn ? '' : 'mic-status-off'}`}>{micOn ? <Mic size={13} /> : <MicOff size={13} />}</span>}{isScreen && <span className="mic-status"><MonitorUp size={13} /></span>}</div></div>
    {isLocal && isScreen && onStop && <button className="tile-stop-share" onClick={onStop}><Square size={12} fill="currentColor" /> Stop sharing</button>}
    <button className="tile-fullscreen" onClick={toggleFullscreen} aria-label={`View ${actualName} ${isScreen ? 'screen' : 'video'} fullscreen`} title="Full screen"><Maximize2 size={15} /></button>
    {isLocal && !isScreen && <span className="local-preview-pill">You</span>}
  </article>;
}


function AudioTrack({ participant: _participant, publication, isLocal }: { participant: Participant; publication: TrackPublication; isLocal: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const track = publication.track;
  useEffect(() => {
    if (isLocal || !track || track.kind !== Track.Kind.Audio || !audioRef.current) return;
    track.attach(audioRef.current);
    return () => { track.detach(audioRef.current!); };
  }, [track, isLocal]);
  return <audio ref={audioRef} autoPlay playsInline />;
}

function ChatPanel({ messages, socket, participantId }: { messages: ChatMessage[]; socket: Socket | null; participantId: string }) {
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages.length]);
  const send = (event: React.FormEvent) => { event.preventDefault(); const body = draft.trim(); if (!body) return; socket?.emit('chat:send', { body }); setDraft(''); setEmojiOpen(false); };
  return <div className="chat-panel-content"><div className="chat-guideline"><ShieldCheck size={15} /><span>Be respectful. Messages are visible to everyone in this classroom.</span></div><div className="chat-messages" ref={scrollRef}>{messages.length === 0 ? <div className="panel-empty"><div className="empty-illustration"><MessageCircle size={25} /></div><strong>Start the conversation</strong><span>Send a message to your classmates or teacher.</span></div> : messages.map((message) => <article className={`chat-message ${message.senderId === participantId ? 'chat-message-own' : ''}`} key={message.id}><div className="chat-message-avatar">{message.senderName?.[0]?.toUpperCase() || '?'}</div><div className="chat-message-body"><div className="chat-message-meta"><strong>{message.senderName}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.body}</p></div></article>)}</div><form className="chat-composer" onSubmit={send}><div className="chat-composer-wrap"><textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Send a message…" maxLength={2000} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement)?.requestSubmit(); } }} /><div className="chat-composer-tools"><div className="emoji-wrap"><button className="composer-tool" type="button" title="Add emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={17} /></button>{emojiOpen && <div className="composer-emoji-pop">{['🙂', '👏', '👍', '❤️', '😂', '🎉'].map((emoji) => <button type="button" key={emoji} onClick={() => { setDraft((old) => old + emoji); setEmojiOpen(false); }}>{emoji}</button>)}</div>}</div><span className="composer-hint">Enter to send</span><button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message"><Send size={16} /></button></div></div></form></div>;
}

function PeoplePanel({ participants, localParticipant, hands, session, socket, onAnnouncement }: {
  participants: Participant[]; localParticipant: Participant | null; hands: Record<string, boolean>; session: RoomSession; socket: Socket | null; onAnnouncement: () => void;
}) {
  return <div className="people-panel-content"><div className="people-count-line"><span>In this classroom</span><strong>{participants.length}</strong></div><div className="people-list">{participants.map((p) => <div className="person-row" key={p.sid || p.identity}><div className={`person-avatar ${p === localParticipant ? 'person-avatar-own' : ''}`}>{(p.name || p.identity).slice(0, 1).toUpperCase()}</div><div className="person-info"><strong>{p.name || p.identity}{p === localParticipant ? ' (You)' : ''}</strong><span>{p === localParticipant ? session.role === 'teacher' ? 'Host' : 'You' : 'Participant'}</span></div><div className="person-badges">{(hands[p.identity.replace(/^(guest|teacher)-/, '')] || hands[p.identity]) && <span className="raised-hand-badge"><Hand size={13} /></span>}{p.isMicrophoneEnabled ? <Mic size={15} /> : <MicOff size={15} className="muted-icon" />}{p.isCameraEnabled ? <Video size={15} /> : <VideoOff size={15} className="muted-icon" />}</div></div>)}</div>{session.role === 'teacher' && <button className="button button-outline button-wide announcement-action" onClick={onAnnouncement}><Bell size={16} /> Make announcement</button>}<div className="people-safety-note"><ShieldCheck size={16} /><span>Names in a guest classroom are self-selected and are not identity-verified.</span></div><button className="button button-quiet button-wide" onClick={() => socket?.emit('meeting:reaction', { emoji: '👏' })}><Sparkles size={16} /> Celebrate the class</button></div>;
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
