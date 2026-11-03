import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, CameraOff, Check, ChevronDown, Headphones, Mic, MicOff, Moon, RefreshCw, ShieldCheck, Sun, Video } from 'lucide-react';
import type { Classroom } from '../api';

type MediaChoice = { cameraEnabled: boolean; micEnabled: boolean; cameraId: string; micId: string };
export default function PreJoin({ pending, busy, error, onBack, onJoin, theme, onToggleTheme }: {
  pending: { code: string; displayName: string; room: Classroom };
  busy: boolean; error: string; onBack: () => void; onJoin: (choice: MediaChoice) => Promise<void>;
  theme: 'light' | 'dark'; onToggleTheme: () => void;
}) {
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, cameraEnabled]);

  useEffect(() => {
    let cancelled = false;
    let current: MediaStream | null = null;
    async function preview() {
      setPreviewError('');
      if (!cameraEnabled && !micEnabled) {
        setStream(null);
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameras([]); setMicrophones([]);
        return;
      }
      try {
        const constraints = (useSelectedDevices: boolean): MediaStreamConstraints => ({
          video: cameraEnabled ? (useSelectedDevices && cameraId ? { deviceId: { exact: cameraId } } : { width: { ideal: 1280 }, height: { ideal: 720 } }) : false,
          audio: micEnabled ? (useSelectedDevices && micId ? { deviceId: { exact: micId } } : true) : false
        });
        try {
          current = await navigator.mediaDevices.getUserMedia(constraints(true));
        } catch (err) {
          const deviceMissing = err instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(err.name);
          if (!deviceMissing || (!cameraId && !micId)) throw err;
          // Device IDs can become stale after reconnecting hardware or changing browser
          // permissions. Retry with browser defaults so a missing selection doesn't block joining.
          setCameraId(''); setMicId('');
          current = await navigator.mediaDevices.getUserMedia(constraints(false));
          setPreviewError('A selected device is unavailable. Using your browser’s default devices.');
        }
        if (cancelled) { current.getTracks().forEach((t) => t.stop()); return; }
        setStream(current);
        if (videoRef.current) videoRef.current.srcObject = current;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((d) => d.kind === 'videoinput'));
        setMicrophones(devices.filter((d) => d.kind === 'audioinput'));
        // Keep the browser default selected unless the user explicitly picks a device.
      } catch (err) {
        if (cancelled) return;
        setStream(null);
        setPreviewError(err instanceof Error ? err.message : 'Camera or microphone access was blocked. You can still try joining with them off.');
      }
    }
    preview();
    return () => { cancelled = true; current?.getTracks().forEach((t) => t.stop()); };
  }, [cameraEnabled, micEnabled, cameraId, micId]);

  return <div className="prejoin-page">
    <header className="topbar prejoin-topbar"><button className="icon-button" aria-label="Go back" onClick={onBack}><ArrowLeft size={19} /></button><a className="brand" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo</span></a><span className="secure-label"><ShieldCheck size={14} /> Secure classroom</span><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button></header>
    <main className="prejoin-main">
      <div className="prejoin-copy"><span className="eyebrow">YOU’RE ALMOST THERE</span><h1>Ready to join,<br /><span>{pending.displayName || 'language learner'}?</span></h1><p>Make sure your camera and microphone are set the way you want before joining.</p>
        <div className="prejoin-room"><span className="room-avatar"><Video size={21} /></span><div><strong>{pending.room.title}</strong><span>{pending.room.language} lesson · Code {pending.code}</span></div><span className="status-pill status-live"><span className="online-dot" /> Ready</span></div>
        <div className="privacy-note"><ShieldCheck size={18} /><div><strong>Your privacy matters</strong><span>Your browser will ask permission before accessing your camera or microphone. Nothing is recorded by default.</span></div></div>
      </div>
      <div className="prejoin-media-column">
        <div className="preview-stage">
          {cameraEnabled && stream?.getVideoTracks().length ? <video ref={videoRef} autoPlay playsInline muted className="preview-video" /> : <div className="preview-placeholder"><div className="preview-avatar">{pending.displayName?.[0]?.toUpperCase() || 'Y'}</div><strong>{cameraEnabled ? 'Camera preview unavailable' : 'Your camera is off'}</strong><span>{cameraEnabled ? 'Check your browser permissions or choose another camera.' : 'You can turn it on before joining.'}</span></div>}
          <div className="preview-name-tag"><span className="online-dot" /> {pending.displayName}</div>
          {previewError && <div className="preview-warning" role="status">{previewError}</div>}
          <div className="preview-controls">
            <button className={`round-control ${micEnabled ? '' : 'control-off'}`} onClick={() => setMicEnabled((v) => !v)} aria-label={micEnabled ? 'Turn microphone off' : 'Turn microphone on'} title={micEnabled ? 'Turn microphone off' : 'Turn microphone on'}>{micEnabled ? <Mic size={19} /> : <MicOff size={19} />}</button>
            <button className={`round-control ${cameraEnabled ? '' : 'control-off'}`} onClick={() => setCameraEnabled((v) => !v)} aria-label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'} title={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}>{cameraEnabled ? <Camera size={19} /> : <CameraOff size={19} />}</button>
            <button className={`round-control ${devicesOpen ? 'control-selected' : ''}`} onClick={() => setDevicesOpen((v) => !v)} aria-label="Device settings" title="Device settings"><ChevronDown size={18} /></button>
          </div>
        </div>
        {devicesOpen && <div className="device-picker">
          <label>Camera<select value={cameraId} onChange={(e) => setCameraId(e.target.value)} disabled={!cameraEnabled}><option value="">Default camera</option>{cameras.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 5)}`}</option>)}</select></label>
          <label>Microphone<select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={!micEnabled}><option value="">Default microphone</option>{microphones.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 5)}`}</option>)}</select></label>
          <button className="button button-quiet" onClick={() => { setCameraId(''); setMicId(''); }}><RefreshCw size={14} /> Reset devices</button>
        </div>}
        <div className="prejoin-bottom"><div className="prejoin-audio-status"><span className={`status-check ${micEnabled && !previewError ? '' : 'status-check-muted'}`}><Check size={13} /></span><span>{micEnabled ? 'Microphone ready' : 'Joining muted'}</span><span className="small-separator">·</span><span>{cameraEnabled ? 'Camera on' : 'Camera off'}</span></div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary button-wide" onClick={() => onJoin({ cameraEnabled, micEnabled, cameraId, micId })} disabled={busy}>{busy ? <span className="spinner" /> : <>Join classroom <Video size={17} /></>}</button>
          <p className="muted small-text">You can change your camera and microphone any time during class.</p>
        </div>
      </div>
    </main>
  </div>;
}
