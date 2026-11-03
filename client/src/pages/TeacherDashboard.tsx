import type React from 'react';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, BookOpen, CalendarClock, Check, Copy, ExternalLink, Github, LogIn, LogOut, Plus, Radio, RefreshCw, ShieldCheck, Sun, Moon, UserPlus, Video, X } from 'lucide-react';
import { API_BASE, Classroom, TeacherUser, createRoom, deleteRoom, downloadAttendance, endRoom, getAttendance, getOAuthProviders, getRooms, getTeacherUser, loginTeacher, logoutTeacher, startTeacherRegistration, verifyTeacherRegistration } from '../api';

type RoomForm = { title: string; language: string; permanent: boolean };
const initialForm: RoomForm = { title: '', language: 'German', permanent: false };

export default function TeacherDashboard({ onBack, onEnterRoom, onAuthenticated, hostIntent = false, theme, onToggleTheme, initialError = '' }: { onBack: () => void; onEnterRoom: (room: Classroom) => void; onAuthenticated?: () => void; hostIntent?: boolean; theme: 'light' | 'dark'; onToggleTheme: () => void; initialError?: string }) {
  const [teacher, setTeacher] = useState<TeacherUser | null>(() => getTeacherUser());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpPending, setOtpPending] = useState(false);
  const [fullName, setFullName] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [remember, setRemember] = useState(() => localStorage.getItem('judoRememberTeacher') !== 'false');
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [rooms, setRooms] = useState<Classroom[]>([]);
  const [form, setForm] = useState<RoomForm>(initialForm);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');
  const [copiedCode, setCopiedCode] = useState('');
  const [attendanceRoom, setAttendanceRoom] = useState<Classroom | null>(null);
  const [attendance, setAttendance] = useState<{ displayName: string; role: string; joinedAt: string; leftAt: string | null }[]>([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);

  const refresh = async () => {
    setError('');
    try { setRooms((await getRooms()).rooms); }
    catch (err) { const message = err instanceof Error ? err.message : 'Could not load classrooms.'; setError(message); if (/sign.?in has expired|teacher sign.?in required|sign in again/i.test(message)) { logoutTeacher(); setTeacher(null); setRooms([]); } }
  };
  useEffect(() => { if (teacher) refresh(); }, [teacher]);
  useEffect(() => { getOAuthProviders().then((result) => setProviders(result.providers)).catch(() => setProviders({})); }, []);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (authMode === 'signup' && !otpPending) {
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        await startTeacherRegistration(fullName, email, password);
        setOtpPending(true); setNotice('Verification code sent. Check your email.'); setBusy(false); return;
      }
      const result = authMode === 'signin' ? await loginTeacher(email, password, remember) : await verifyTeacherRegistration(email, otp, remember);
      setTeacher(result.user); setPassword(''); setConfirmPassword(''); setOtp(''); setOtpPending(false); onAuthenticated?.();
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  const beginOAuth = (provider: string) => {
    sessionStorage.setItem('judoRememberTeacher', String(remember));
    localStorage.setItem('judoRememberTeacher', String(remember));
    window.location.assign(`${API_BASE}/api/auth/oauth/${provider}`);
  };
  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await createRoom(form.title, form.language, form.permanent); setRooms((old) => [result.room, ...old]); setForm(initialForm); setShowCreate(false); setNotice('Classroom created. Copy the link and send it to your students.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create classroom.'); }
    finally { setBusy(false); }
  };
  const shareLink = (code: string) => `${window.location.origin}/?room=${encodeURIComponent(code)}`;
  const copyLink = async (room: Classroom) => {
    try { await navigator.clipboard.writeText(shareLink(room.code)); setCopiedCode(room.code); setNotice('Class link copied to clipboard.'); }
    catch { setNotice(`Share this link with students: ${shareLink(room.code)}`); }
  };
  const end = async (room: Classroom) => {
    if (!window.confirm(`End “${room.title}” for everyone? Participants will be disconnected.`)) return;
    try { await endRoom(room.code); setRooms((old) => old.map((r) => r.code === room.code ? { ...r, active: false } : r)); setNotice('Classroom ended.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not end classroom.'); }
  };
  const viewAttendance = async (room: Classroom) => {
    setAttendanceRoom(room); setAttendance([]); setAttendanceLoading(true);
    try { setAttendance((await getAttendance(room.code)).attendance); }
    catch (err) { setAttendanceRoom(null); setError(err instanceof Error ? err.message : 'Could not load attendance.'); }
    finally { setAttendanceLoading(false); }
  };
  const removeEndedRoom = async (room: Classroom) => {
    if (room.active) return;
    if (!window.confirm(`Delete “${room.title}” and its attendance, chat, whiteboard, and uploaded files? This cannot be undone.`)) return;
    try { await deleteRoom(room.code); setRooms((old) => old.filter((item) => item.code !== room.code)); setNotice('Ended classroom and its stored data deleted.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not delete classroom.'); }
  };
  const signOut = () => { logoutTeacher(); setTeacher(null); setRooms([]); setError(''); };

  if (!teacher) return <div className="auth-page"><header className="auth-topbar"><button className="button button-quiet back-button" onClick={onBack}><ArrowLeft size={17} /> Back</button><a className="brand" href="#" onClick={(e) => e.preventDefault()}><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo</span></a><button className="theme-toggle auth-theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button></header><div className="auth-card"><div className="auth-logo"><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo for teachers</span></div><span className="eyebrow">HOST WORKSPACE</span><h1>{authMode === 'signin' ? 'Welcome back.' : 'Create your host account.'}</h1><p className="muted">{hostIntent ? 'Sign in or register to host this class.' : 'Manage your classes, links, and attendance in one place.'}</p><div className="auth-mode-switch"><button className={authMode === 'signin' ? 'active' : ''} onClick={() => { setAuthMode('signin'); setOtpPending(false); setOtp(''); setError(''); }}>Sign in</button><button className={authMode === 'signup' ? 'active' : ''} onClick={() => { setAuthMode('signup'); setOtpPending(false); setOtp(''); setError(''); }}>Create account</button></div><form className="join-form" onSubmit={submitLogin}>{authMode === 'signup' && <><label htmlFor="teacherName">Your name</label><input id="teacherName" autoComplete="name" maxLength={100} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Name shown to your class" required /></>}<label htmlFor="teacherEmail">Email address</label><input type="email" id="teacherEmail" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />{!otpPending && <><label htmlFor="teacherPassword">Password</label><input type="password" id="teacherPassword" autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} minLength={authMode === 'signup' ? 12 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={authMode === 'signup' ? 'At least 12 characters' : 'Your password'} required />{authMode === 'signup' && <><label htmlFor="confirmTeacherPassword">Confirm password</label><input type="password" id="confirmTeacherPassword" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Enter the same password again" required /></>}</>}{otpPending && <><label htmlFor="teacherOtp">Email verification code</label><input id="teacherOtp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\\D/g, '').slice(0, 6))} placeholder="6-digit code" required /><p className="oauth-setup-note">Enter the code sent to {email}. It expires in 10 minutes.</p></>}<label className="remember-row"><input type="checkbox" checked={remember} onChange={(e) => { setRemember(e.target.checked); localStorage.setItem('judoRememberTeacher', String(e.target.checked)); }} /><span><strong>Remember me on this device</strong><small>Stay signed in after closing your browser</small></span></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-primary button-wide" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : authMode === 'signin' ? <>Sign in <LogIn size={17} /></> : otpPending ? <>Verify code &amp; create account <UserPlus size={17} /></> : <>Send verification code <UserPlus size={17} /></>}</button></form><div className="auth-divider"><span>or continue with</span></div><div className="oauth-buttons"><button onClick={() => beginOAuth('google')} disabled={!providers.google} title={providers.google ? 'Continue with Google' : 'Google sign-in needs client credentials in server/.env'}><span className="oauth-mark oauth-google">G</span>Google</button><button onClick={() => beginOAuth('microsoft')} disabled={!providers.microsoft} title={providers.microsoft ? 'Continue with Microsoft' : 'Microsoft sign-in needs client credentials in server/.env'}><span className="oauth-mark oauth-microsoft">M</span>Outlook</button><button onClick={() => beginOAuth('github')} disabled={!providers.github} title={providers.github ? 'Continue with GitHub' : 'GitHub sign-in needs client credentials in server/.env'}><Github size={17} />GitHub</button><button disabled title="WhatsApp phone verification needs a configured WhatsApp Business service"><span className="oauth-mark oauth-whatsapp">W</span>WhatsApp</button></div><p className="oauth-setup-note">Google, Outlook, and GitHub create a host account on first sign-in when their provider credentials are configured. WhatsApp needs a phone verification service.</p><div className="auth-foot"><ShieldCheck size={15} /> Your host sign-in is protected. Student accounts are not required.</div></div></div>;

  return <div className="dashboard-shell"><header className="topbar dashboard-topbar"><a className="brand" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}><span className="brand-mark brand-mark-logo"><img src="/judo-logo.svg" alt="" /></span><span>Judo</span></a><div className="dashboard-top-right"><span className="teacher-avatar">{teacher.name[0]?.toUpperCase()}</span><div className="teacher-heading"><strong>{teacher.name}</strong><span>Teacher workspace</span></div><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={signOut}><LogOut size={18} /></button></div></header>
    <main className="dashboard-main"><div className="dashboard-welcome"><div><span className="eyebrow">YOUR TEACHING SPACE</span><h1>Good to see you, {teacher.name.split(' ')[0]}.</h1><p>Make room for a great lesson. Your classrooms and links are all in one place.</p></div><button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={18} /> Create classroom</button></div>
      {notice && <div className="notice-bar"><Check size={16} /><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice('')}><X size={15} /></button></div>}{error && <div className="form-error dashboard-error" role="alert">{error}</div>}
      <div className="dashboard-stats"><div className="stat-card"><span className="stat-icon stat-violet"><BookOpen size={19} /></span><span className="stat-value">{rooms.length}</span><span className="stat-label">Classrooms created</span></div><div className="stat-card"><span className="stat-icon stat-green"><Radio size={19} /></span><span className="stat-value">{rooms.filter((r) => r.active).length}</span><span className="stat-label">Available to join</span></div><div className="stat-card"><span className="stat-icon stat-orange"><Video size={19} /></span><span className="stat-value">{rooms.reduce((total, r) => total + (r.participantCount || 0), 0)}</span><span className="stat-label">Currently connected</span></div></div>
      <div className="section-heading"><div><h2>Your classrooms</h2><p>Share a link to invite students without creating student accounts.</p></div><button className="button button-outline button-small" onClick={refresh}><RefreshCw size={15} /> Refresh</button></div>
      {rooms.length === 0 ? <div className="empty-state"><div className="empty-illustration"><BookOpen size={31} /></div><h3>Your first classroom starts here</h3><p>Create a room for a German, English, French, or any other language lesson.</p><button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={17} /> Create your first classroom</button></div> : <div className="classroom-list">{rooms.map((room) => <article className={`classroom-card ${!room.active ? 'classroom-inactive' : ''}`} key={room.code}><div className={`classroom-thumb ${room.language.toLowerCase() === 'german' ? 'thumb-german' : room.language.toLowerCase() === 'french' ? 'thumb-french' : 'thumb-default'}`}><span>{room.language.slice(0, 2).toUpperCase()}</span><BookOpen size={22} /></div><div className="classroom-info"><div className="classroom-title-line"><h3>{room.title}</h3><span className={`status-pill ${room.active ? 'status-live' : 'status-ended'}`}><span className={room.active ? 'online-dot' : ''} />{room.active ? 'Available' : 'Ended'}</span></div><p>{room.language} · Code <strong>{room.code}</strong></p><div className="room-meta"><span><Radio size={14} /> {room.participantCount || 0} connected now</span>{room.scheduledAt ? <span><CalendarClock size={14} /> Scheduled {new Date(room.scheduledAt).toLocaleString()}</span> : <span>{room.permanent ? 'Classroom link' : 'Room link'}</span>}</div><div className="room-actions"><button className="button button-outline button-small" onClick={() => copyLink(room)} disabled={!room.active}><Copy size={15} /> {copiedCode === room.code ? 'Copied' : 'Copy invite link'}</button><button className="button button-outline button-small" onClick={() => viewAttendance(room)}>View attendance</button><button className="button button-outline button-small" onClick={async () => { try { await downloadAttendance(room.code); } catch (err) { setError(err instanceof Error ? err.message : 'Could not download attendance.'); } }}><ArrowDownToLine size={15} /> Export CSV</button>{room.active ? <button className="button button-primary button-small" onClick={() => onEnterRoom(room)}>Enter classroom <ExternalLink size={14} /></button> : <button className="button button-danger-quiet button-small" onClick={() => removeEndedRoom(room)}>Delete</button>}{room.active && <button className="button button-danger-quiet button-small" onClick={() => end(room)}>End</button>}</div>{copiedCode === room.code && <div className="link-preview">{shareLink(room.code)}</div>}</div></article>)}</div>}
      <div className="dashboard-help"><div className="help-shield"><ShieldCheck size={21} /></div><div><strong>Teaching tip</strong><p>Only share classroom links with the students who should attend. A guest’s display name is not a verified identity.</p></div></div>
    </main>
    {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-head"><div><span className="eyebrow">NEW LESSON</span><h2 id="create-title">Create a classroom</h2></div><button className="icon-button" onClick={() => setShowCreate(false)} aria-label="Close"><X size={19} /></button></div><form className="join-form" onSubmit={submitCreate}><label htmlFor="classTitle">Classroom title</label><input autoFocus id="classTitle" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. German A2 — Conversation practice" maxLength={100} required /><label htmlFor="classLanguage">Language</label><select id="classLanguage" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option>German</option><option>English</option><option>French</option><option>Spanish</option><option>Japanese</option><option>Other</option></select><label className="checkbox-row"><input type="checkbox" checked={form.permanent} onChange={(e) => setForm({ ...form, permanent: e.target.checked })} /><span><strong>Reusable classroom</strong><small>Keep this room available until you end it manually.</small></span></label><div className="modal-actions"><button className="button button-outline" type="button" onClick={() => setShowCreate(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <><Plus size={17} /> Create classroom</>}</button></div></form></div></div>}
    {attendanceRoom && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setAttendanceRoom(null); }}><div className="modal-card attendance-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-title"><div className="modal-head"><div><span className="eyebrow">CLASS REPORT</span><h2 id="attendance-title">Attendance · {attendanceRoom.title}</h2><p className="muted">{attendance.length} join records for {attendanceRoom.code}</p></div><button className="icon-button" onClick={() => setAttendanceRoom(null)} aria-label="Close attendance"><X size={19} /></button></div>{attendanceLoading ? <p>Loading attendance…</p> : attendance.length === 0 ? <p>No attendance has been recorded for this class.</p> : <div className="attendance-list"><div className="attendance-row attendance-heading"><strong>Name</strong><strong>Joined</strong><strong>Left</strong></div>{attendance.map((entry, index) => <div className="attendance-row" key={`${entry.displayName}-${entry.joinedAt}-${index}`}><strong>{entry.displayName}</strong><span>{new Date(`${entry.joinedAt}Z`).toLocaleString()}</span><span>{entry.leftAt ? new Date(`${entry.leftAt}Z`).toLocaleString() : 'Still in class'}</span></div>)}</div>}<button className="button button-outline" onClick={async () => { try { await downloadAttendance(attendanceRoom.code); } catch (err) { setError(err instanceof Error ? err.message : 'Could not export attendance.'); } }}>Export CSV</button></div></div>}
  </div>;
}
