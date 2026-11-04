import type React from 'react';
import { useEffect, useState } from 'react';
import {
  ArrowRight, BookOpen, CalendarClock, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronRight, Copy, Download, GraduationCap, Link2, Moon,
  ShieldCheck, Sun, Video, X, Zap
} from 'lucide-react';
import { API_BASE, Classroom, RoomSession, createRoom, finishOAuth, getTeacherToken, getTeacherUser, joinRoom, lookupRoom, logoutTeacher, saveTeacherSession } from './api';
import PreJoin from './pages/PreJoin';
import ClassroomView from './pages/Classroom';
import TeacherDashboard from './pages/TeacherDashboard';
import './styles.css';

type Page = 'home' | 'prejoin' | 'classroom' | 'teacher';
type PendingJoin = { code: string; displayName: string; room: Classroom };
type MediaChoice = { cameraEnabled: boolean; micEnabled: boolean; cameraId: string; micId: string };
type Theme = 'light' | 'dark';
type MeetingIntent = { kind: 'instant' | 'schedule' | 'host'; title: string; language: string; permanent: boolean; scheduledAt?: string };
type RecentClass = { code: string; title: string; language: string; displayName: string; leftAt: number };
const RECENT_CLASS_KEY = 'judoRecentClass';

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [pending, setPending] = useState<PendingJoin | null>(null);
  const [session, setSession] = useState<RoomSession | null>(null);
  const [mediaChoice, setMediaChoice] = useState<MediaChoice>({ cameraEnabled: true, micEnabled: true, cameraId: '', micId: '' });
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('judoTheme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [hasThemeChoice, setHasThemeChoice] = useState(() => ['dark', 'light'].includes(localStorage.getItem('judoTheme') || ''));
  const [hostIntent, setHostIntent] = useState<MeetingIntent | null>(null);
  const [inviteRoom, setInviteRoom] = useState<Classroom | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (hasThemeChoice) localStorage.setItem('judoTheme', theme);
  }, [theme, hasThemeChoice]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const syncSystemTheme = () => { if (!hasThemeChoice) setTheme(media.matches ? 'dark' : 'light'); };
    media.addEventListener?.('change', syncSystemTheme);
    return () => media.removeEventListener?.('change', syncSystemTheme);
  }, [hasThemeChoice]);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('host_auth_token');
    const authError = fragment.get('host_auth_error');
    if (token) {
      window.history.replaceState({}, '', window.location.pathname + window.location.search);
      const remember = sessionStorage.getItem('judoRememberTeacher') !== 'false';
      sessionStorage.removeItem('judoRememberTeacher');
      finishOAuth(token).then(({ user }) => {
        saveTeacherSession(token, user, remember);
        setPage('teacher');
      }).catch(() => { setError('Could not finish sign-in. Please try again.'); setPage('teacher'); });
    } else if (authError) {
      window.history.replaceState({}, '', window.location.pathname + window.location.search);
      setError(authError === 'provider_unavailable' ? 'That sign-in option needs to be configured by the site owner.' : authError === 'account_exists' ? 'An account already uses this email. Sign in with it first.' : 'Sign-in did not finish. Please try again.');
      setPage('teacher');
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (code) {
      window.history.replaceState({}, '', window.location.pathname);
      setPending({ code, displayName: '', room: { code, title: 'Classroom', language: 'German', active: true } });
    }
  }, []);

  const beginJoin = async (code: string, displayName: string) => {
    setError('');
    try {
      const { room } = await lookupRoom(code);
      setPending({ code: room.code, displayName, room });
      setPage('prejoin');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not find that meeting.'); }
  };

  const enterClassroom = async (choice: MediaChoice) => {
    if (!pending || joining) return;
    setJoining(true);
    setError('');
    try {
      const result = await joinRoom(pending.code, pending.displayName);
      setSession(result);
      setMediaChoice(choice);
      setInviteRoom(null);
      setPage('classroom');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join this classroom.');
    } finally { setJoining(false); }
  };

  const createMeeting = async (intent: MeetingIntent) => {
    setError('');
    if (!getTeacherToken()) {
      setHostIntent(intent);
      setPage('teacher');
      return;
    }
    try {
      const { room } = await createRoom(intent.title, intent.language, intent.permanent, intent.scheduledAt);
      setInviteRoom(room);
      setPending(null);
      setPage('home');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create the meeting.';
      // Expired teacher tokens used to strand users on the dashboard and make every
      // create action fail. Clear stale credentials and preserve the requested action.
      if (/sign.?in has expired|teacher sign.?in required|sign in again|teacher access required/i.test(message)) {
        logoutTeacher();
        setHostIntent(intent);
        setError('Your sign-in expired. Sign in again to create this meeting.');
        setPage('teacher');
        return;
      }
      setError(message);
      setPage('home');
    }
  };

  const onTeacherAuthenticated = () => {
    if (hostIntent) {
      const intent = hostIntent;
      setHostIntent(null);
      void createMeeting(intent);
    }
  };

  const enterFromTeacherDashboard = async (room: Classroom) => {
    setError('');
    setPending({ code: room.code, displayName: getStoredTeacherName(), room });
    setPage('prejoin');
  };

  const leaveClassroom = () => {
    if (session) {
      const recent: RecentClass = { code: session.room.code, title: session.room.title, language: session.room.language, displayName: session.displayName, leftAt: Date.now() };
      localStorage.setItem(RECENT_CLASS_KEY, JSON.stringify(recent));
    }
    sessionStorage.removeItem('classroomSessionToken');
    setSession(null);
    setPending(null);
    setPage(getTeacherToken() ? 'teacher' : 'home');
  };

  if (page === 'prejoin' && pending) return <PreJoin theme={theme} onToggleTheme={() => { setHasThemeChoice(true); setTheme((value) => value === 'light' ? 'dark' : 'light'); }} pending={pending} busy={joining} error={error} onBack={() => { setPage('home'); setError(''); }} onJoin={enterClassroom} />;
  if (page === 'classroom' && session) return <ClassroomView theme={theme} onToggleTheme={() => { setHasThemeChoice(true); setTheme((value) => value === 'light' ? 'dark' : 'light'); }} session={session} mediaChoice={mediaChoice} onLeave={leaveClassroom} />;
  if (page === 'teacher') return <TeacherDashboard theme={theme} onToggleTheme={() => { setHasThemeChoice(true); setTheme((value) => value === 'light' ? 'dark' : 'light'); }} onBack={() => { setPage('home'); setHostIntent(null); }} onEnterRoom={enterFromTeacherDashboard} onAuthenticated={onTeacherAuthenticated} hostIntent={Boolean(hostIntent)} initialError={error} />;

  return <LandingPage
    onJoin={beginJoin}
    error={error}
    onTeacher={() => { setPage('teacher'); setError(''); }}
    initialCode={pending?.code || ''}
    theme={theme}
    onToggleTheme={() => { setHasThemeChoice(true); setTheme((value) => value === 'light' ? 'dark' : 'light'); }}
    onCreateMeeting={createMeeting}
    inviteRoom={inviteRoom}
    onCloseInvite={() => setInviteRoom(null)}
    onJoinCreated={(code) => { setInviteRoom(null); void beginJoin(code, getStoredTeacherName()); }}
  />;
}

function getStoredTeacherName() {
  return getTeacherUser()?.name || 'Teacher';
}

function defaultDateTimeLocal() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function LandingPage({ onJoin, error, onTeacher, initialCode, theme, onToggleTheme, onCreateMeeting, inviteRoom, onCloseInvite, onJoinCreated }: {
  onJoin: (code: string, name: string) => Promise<void>;
  error: string;
  onTeacher: () => void;
  initialCode: string;
  theme: Theme;
  onToggleTheme: () => void;
  onCreateMeeting: (intent: MeetingIntent) => Promise<void>;
  inviteRoom: Classroom | null;
  onCloseInvite: () => void;
  onJoinCreated: (code: string) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [modalType, setModalType] = useState<'schedule' | 'host' | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('New meeting');
  const [language, setLanguage] = useState('German');
  const [scheduledAt, setScheduledAt] = useState(defaultDateTimeLocal);
  const [createBusy, setCreateBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [recentClass, setRecentClass] = useState<RecentClass | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_CLASS_KEY) || 'null') as RecentClass | null;
      return value && typeof value.code === 'string' && typeof value.displayName === 'string' ? value : null;
    } catch { return null; }
  });

  useEffect(() => { if (initialCode) setCode(initialCode); }, [initialCode]);
  useEffect(() => { setCopied(false); setCopiedCode(false); }, [inviteRoom?.code]);
  useEffect(() => {
    if (!recentClass) return;
    let active = true;
    const verifyRecentClass = () => {
      lookupRoom(recentClass.code).then(({ room }) => {
        if (active) setRecentClass((current) => current?.code === room.code ? { ...current, title: room.title, language: room.language } : current);
      }).catch((error) => {
        if (!active || !/does not exist or has ended|classroom not found/i.test(error instanceof Error ? error.message : '')) return;
        localStorage.removeItem(RECENT_CLASS_KEY);
        setRecentClass(null);
      });
    };
    verifyRecentClass();
    const timer = window.setInterval(verifyRecentClass, 30000);
    window.addEventListener('focus', verifyRecentClass);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', verifyRecentClass); };
  }, [recentClass?.code]);

  const submitJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setBusy(true);
    await onJoin(code.trim(), name.trim());
    setBusy(false);
  };

  const createInstant = async () => {
    setCreateBusy(true);
    await onCreateMeeting({ kind: 'instant', title: 'Instant meeting', language: 'General', permanent: false });
    setCreateBusy(false);
  };

  const submitModal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!meetingTitle.trim()) return;
    if (modalType === 'schedule' && (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now())) return;
    setCreateBusy(true);
    const intent: MeetingIntent = modalType === 'schedule'
      ? { kind: 'schedule', title: meetingTitle.trim(), language, permanent: true, scheduledAt }
      : { kind: 'host', title: meetingTitle.trim(), language, permanent: true };
    await onCreateMeeting(intent);
    setCreateBusy(false);
    setModalType(null);
  };

  const teacherUser = (() => { try { return JSON.parse(localStorage.getItem('teacherUser') || 'null'); } catch { return null; } })();
  const inviteLink = inviteRoom ? `${window.location.origin}/?room=${encodeURIComponent(inviteRoom.code)}` : '';

  const copyText = async (text: string, setDone: (value: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      window.prompt('Copy this meeting information:', text);
    }
  };

  return <div className={`meet-landing-shell theme-${theme}`}>
    <header className="topbar meet-topbar">
      <a className="brand meet-brand" href="#top" aria-label="Judo home"><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo</span></a>
      <div className="meet-top-right"><span className="meet-top-caption"><span className="online-dot" /> Simple video meetings</span><button className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}<span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span></button><button className="button button-quiet meet-teacher-button" onClick={onTeacher}>{teacherUser ? 'Host dashboard' : 'Host sign in'} <ChevronRight size={16} /></button></div>
    </header>

    <main id="top" className="meet-main">
      <section className="meet-hero">
        <div className="meet-hero-copy">
          <div className="meet-eyebrow"><span className="meet-eyebrow-icon"><Video size={14} /></span> JUDO CLASSROOM</div>
          <h1>Join your class.<br /><span>Start learning.</span></h1>
          <p className="meet-hero-description">Enter your name and class code to join. Students do not need an account.</p>
          <div className="meet-trust-points"><span><CheckCircle2 size={16} /> Join with a link or code</span><span><CheckCircle2 size={16} /> Guests join with a link</span></div>
          <a className="meet-download-app" href={`${API_BASE}/downloads/android/latest.apk`}><Download size={16} /> Download the Android app</a>
          <details className="teacher-actions">
            <summary><span className="teacher-actions-icon"><GraduationCap size={19} /></span><span><strong>Need a meeting room?</strong><small>Start, schedule, or create a meeting room</small></span><ChevronDown className="teacher-actions-chevron" size={18} /></summary>
            <div className="teacher-action-list">
              <button className="teacher-action-row" onClick={createInstant} disabled={createBusy}><span><Zap size={17} /></span><strong>{createBusy ? 'Starting…' : 'Start a meeting now'}</strong><ArrowRight size={16} /></button>
              <button className="teacher-action-row" onClick={() => { setMeetingTitle('Team meeting'); setScheduledAt(defaultDateTimeLocal()); setModalType('schedule'); }}><span><CalendarDays size={17} /></span><strong>Schedule for later</strong><ArrowRight size={16} /></button>
              <button className="teacher-action-row" onClick={() => { setMeetingTitle('My meeting room'); setModalType('host'); }}><span><BookOpen size={17} /></span><strong>Create a reusable meeting room</strong><ArrowRight size={16} /></button>
            </div>
          </details>
        </div>

        <aside className="meet-join-column">
          <div className="meet-join-card">
            <div className="meet-join-card-header"><span className="meet-join-icon"><Link2 size={20} /></span><span className="meet-secure-tag"><ShieldCheck size={13} /> Ready when you are</span></div>
            <h2>Join a class</h2><p>Type your name and the meeting code.</p>
            {recentClass && <div className="recent-class-card"><div className="recent-class-icon"><Video size={17} /></div><div className="recent-class-info"><span>Recently left · Still active</span><strong>{recentClass.title}</strong><small>{recentClass.language} · {recentClass.code}</small></div><button className="button button-outline button-small" disabled={busy} onClick={async () => { setBusy(true); await onJoin(recentClass.code, recentClass.displayName); setBusy(false); }}>{busy ? <span className="spinner" /> : 'Rejoin'}</button></div>}
            <form className="meet-join-form" onSubmit={submitJoin}>
              <label htmlFor="meet-display-name">What is your name?</label><input id="meet-display-name" autoComplete="name" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" required />
              <label htmlFor="meet-room-code">Meeting code or link</label><input id="meet-room-code" autoCapitalize="characters" value={code} onChange={(e) => { const value = e.target.value; const match = value.match(/[?&]room=([^&]+)/); try { setCode((match ? decodeURIComponent(match[1]) : value).trim().toUpperCase()); } catch { setCode(value.trim().toUpperCase()); } }} placeholder="Paste link or type code" required />
              {error && <div role="alert" className="form-error">{error}</div>}
              <button type="submit" className="button button-primary button-wide" disabled={busy}>{busy ? <span className="spinner" /> : <>Join meeting <ArrowRight size={17} /></>}</button>
            </form>
            <div className="meet-join-foot"><span><Check size={13} /> No account needed</span><span><Check size={13} /> Secure room link</span></div>
          </div>
        </aside>
      </section>

    </main>
    <footer className="meet-footer"><span>© {new Date().getFullYear()} Judo</span><span>Simple meetings for everyone.</span><a className="orvina-credit" href="https://arnabmalakar.online" target="_blank" rel="noreferrer"><span className="orvina-credit-label"><span className="orvina-credit-by">Created by</span> <span className="orvina-credit-name">ARNAB</span></span></a><button onClick={onTeacher}>Host workspace <ArrowRight size={13} /></button></footer>

    {modalType && <div className="modal-backdrop meet-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setModalType(null); }}><div className="modal-card meet-create-modal" role="dialog" aria-modal="true" aria-labelledby="meet-create-title"><div className="modal-head"><div><span className="eyebrow">{modalType === 'schedule' ? 'PLAN AHEAD' : 'HOST WORKSPACE'}</span><h2 id="meet-create-title">{modalType === 'schedule' ? 'Schedule a meeting' : 'Create a meeting room'}</h2></div><button className="icon-button" onClick={() => setModalType(null)} aria-label="Close"><X size={19} /></button></div><form className="join-form" onSubmit={submitModal}><label htmlFor="new-meeting-title">Meeting title</label><input id="new-meeting-title" autoFocus maxLength={100} value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} placeholder="e.g. German A2 speaking practice" required /><label htmlFor="new-meeting-language">Meeting type</label><select id="new-meeting-language" value={language} onChange={(e) => setLanguage(e.target.value)}><option>German</option><option>English</option><option>French</option><option>Spanish</option><option>Other</option></select>{modalType === 'schedule' && <><label htmlFor="new-meeting-time">Date and time</label><input id="new-meeting-time" type="datetime-local" min={defaultDateTimeLocal()} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /><p className="meet-modal-help">The meeting link is created now, so you can share it with students in advance.</p></>}{error && <div role="alert" className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-outline" onClick={() => setModalType(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={createBusy}>{createBusy ? <span className="spinner" /> : <>{modalType === 'schedule' ? <CalendarClock size={16} /> : <GraduationCap size={16} />}{modalType === 'schedule' ? 'Schedule meeting' : 'Create meeting'} </>}</button></div></form><div className="meet-host-security"><ShieldCheck size={15} /> You’ll be the host and can manage the room.</div></div></div>}

    {inviteRoom && <div className="modal-backdrop meet-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseInvite(); }}><div className="modal-card meet-invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title"><button className="icon-button meet-invite-close" onClick={onCloseInvite} aria-label="Close"><X size={19} /></button><div className="meet-invite-success"><span><Check size={25} /></span></div><span className="eyebrow">MEETING CREATED</span><h2 id="invite-title">Your meeting is ready</h2><p className="meet-invite-description">Share the unique meeting ID or link with everyone you want to invite.</p><div className="meet-invite-detail"><span>Meeting</span><strong>{inviteRoom.title}</strong><small>{inviteRoom.language}{inviteRoom.scheduledAt ? ` · ${new Date(inviteRoom.scheduledAt).toLocaleString()}` : ' · Ready to start'}</small></div><div className="meet-code-box"><span>MEETING ID</span><strong>{inviteRoom.code}</strong><button className="button button-outline button-small" onClick={() => copyText(inviteRoom.code, setCopiedCode)}><Copy size={14} />{copiedCode ? 'Copied ID' : 'Copy ID'}</button></div><button className="button button-primary button-wide" onClick={() => copyText(inviteLink, setCopied)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Invitation link copied' : 'Copy invitation link'}</button><button className="button button-outline button-wide" onClick={() => onJoinCreated(inviteRoom.code)}><Video size={16} /> Join meeting now <ArrowRight size={15} /></button><p className="meet-invite-warning"><ShieldCheck size={14} /> You are the host. Keep the invite link private to your class.</p></div></div>}
  </div>;
}
