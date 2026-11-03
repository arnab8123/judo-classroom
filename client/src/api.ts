// Same-origin by default in production; local Vite uses the separate API port.
const configuredApiBase = import.meta.env.VITE_API_URL?.trim();
// In local development, derive the API host from the page host so a second device on the same LAN
// does not accidentally call its own localhost. Keep the API port separate from Vite's port.
export const API_BASE = configuredApiBase || (import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:3001`
  : '');

export type Classroom = {
  id?: string;
  code: string;
  title: string;
  language: string;
  active: boolean;
  permanent?: boolean;
  teacherName?: string | null;
  participantCount?: number;
  createdAt?: string;
  scheduledAt?: string | null;
};
export type RoomSession = {
  sessionToken: string;
  livekitToken: string;
  livekitUrl: string;
  room: Classroom;
  role: 'teacher' | 'participant';
  displayName: string;
  participantId: string;
};
export type TeacherUser = { id: string; name: string; email: string; role: string };
export type ChatMessage = { id: string; senderName: string; senderId?: string; body: string; createdAt: string };
export type ClassroomFile = { id: string; uploaderName: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string };
export type PersonalNote = { id: string; classroomCode?: string; title: string; content: string; updatedAt: string };

function tokenFromStorage() {
  return sessionStorage.getItem('classroomSessionToken') || getTeacherToken();
}
export function getTeacherToken() { return sessionStorage.getItem('teacherToken') || localStorage.getItem('teacherToken') || ''; }
export function getTeacherUser(): TeacherUser | null {
  try { return JSON.parse(sessionStorage.getItem('teacherUser') || localStorage.getItem('teacherUser') || 'null'); } catch { return null; }
}
export function saveTeacherSession(token: string, user: TeacherUser, remember = true) {
  const persistent = remember ? localStorage : sessionStorage;
  const temporary = remember ? sessionStorage : localStorage;
  temporary.removeItem('teacherToken'); temporary.removeItem('teacherUser');
  persistent.setItem('teacherToken', token); persistent.setItem('teacherUser', JSON.stringify(user));
}
export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const authToken = token ?? tokenFromStorage();
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}

export async function lookupRoom(code: string) {
  return api<{ room: Classroom }>(`/api/rooms/lookup/${encodeURIComponent(code.trim())}`, { method: 'GET' }, '');
}
export async function joinRoom(code: string, displayName: string): Promise<RoomSession> {
  // Modern supported browsers expose crypto.randomUUID() on localhost/HTTPS.
  // Keeping the guest key to UUID-derived characters matches the API validation rules.
  let guestKey = localStorage.getItem('judoGuestKey') || localStorage.getItem('linguaroomGuestKey');
  if (!guestKey) {
    // randomUUID may be unavailable on non-secure LAN HTTP origins, while getRandomValues remains usable.
    const cryptoApi = window.crypto as unknown as { randomUUID?: () => string; getRandomValues: (array: Uint8Array) => Uint8Array };
    if (typeof cryptoApi.randomUUID === 'function') {
      guestKey = `${cryptoApi.randomUUID().replaceAll('-', '')}${cryptoApi.randomUUID().replaceAll('-', '')}`;
    } else {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
      guestKey = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
  localStorage.setItem('judoGuestKey', guestKey);
  const teacherToken = getTeacherToken();
  const result = await api<RoomSession>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify({ displayName, guestKey })
  }, teacherToken);
  sessionStorage.setItem('classroomSessionToken', result.sessionToken);
  return result;
}

export async function loginTeacher(email: string, password: string, remember = true) {
  const result = await api<{ token: string; user: TeacherUser }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password })
  }, '');
  saveTeacherSession(result.token, result.user, remember);
  return result;
}
export async function startTeacherRegistration(name: string, email: string, password: string) {
  return api<{ ok: boolean; email: string }>('/api/auth/register/start', { method: 'POST', body: JSON.stringify({ name, email, password }) }, '');
}
export async function verifyTeacherRegistration(email: string, code: string, remember = true) {
  const result = await api<{ token: string; user: TeacherUser }>('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ email, code }) }, '');
  saveTeacherSession(result.token, result.user, remember);
  return result;
}
export async function getOAuthProviders() { return api<{ providers: Record<string, boolean>; whatsapp: boolean }>('/api/auth/providers', {}, ''); }
export async function finishOAuth(token: string) { return api<{ user: TeacherUser }>('/api/auth/me', {}, token); }
export function logoutTeacher() {
  localStorage.removeItem('teacherToken');
  localStorage.removeItem('teacherUser');
  sessionStorage.removeItem('teacherToken');
  sessionStorage.removeItem('teacherUser');
}
export async function getRooms() { return api<{ rooms: Classroom[] }>('/api/rooms', {}, getTeacherToken()); }
export async function createRoom(title: string, language: string, permanent: boolean, scheduledAt?: string) {
  const parsedSchedule = scheduledAt ? new Date(scheduledAt) : null;
  const scheduleValue = parsedSchedule && !Number.isNaN(parsedSchedule.getTime()) ? parsedSchedule.toISOString() : undefined;
  return api<{ room: Classroom }>('/api/rooms', { method: 'POST', body: JSON.stringify({ title, language, permanent, scheduledAt: scheduleValue }) }, getTeacherToken());
}
export async function endRoom(code: string) {
  // Ending a room is a teacher-only action. The in-room session token is guest-scoped,
  // so explicitly use the separately stored teacher account token.
  return api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(code)}/end`, { method: 'POST' }, getTeacherToken());
}
export async function deleteRoom(code: string) { return api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(code)}`, { method: 'DELETE' }, getTeacherToken()); }
export async function getAttendance(code: string) { return api<{ attendance: { displayName: string; role: string; joinedAt: string; leftAt: string | null }[] }>(`/api/rooms/${encodeURIComponent(code)}/attendance`, {}, getTeacherToken()); }
export async function uploadFiles(code: string, files: FileList | File[]) {
  const form = new FormData();
  form.append('roomCode', code);
  Array.from(files).forEach((file) => form.append('files', file));
  return api<{ files: ClassroomFile[] }>('/api/files', { method: 'POST', body: form });
}
export async function getFiles(code: string, token: string) {
  return api<{ files: ClassroomFile[] }>(`/api/files?roomCode=${encodeURIComponent(code)}`, {}, token);
}
export async function downloadFile(id: string, filename: string, token: string) {
  const response = await fetch(`${API_BASE}/api/files/${encodeURIComponent(id)}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let message = 'Could not download file.';
    try { message = (await response.json()).error || message; } catch { /* non-JSON response */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
export async function downloadAttendance(code: string) {
  const token = getTeacherToken();
  const response = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(code)}/attendance.csv`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let message = 'Could not download attendance.';
    try { message = (await response.json()).error || message; } catch { /* noop */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `attendance-${code}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
export async function getNotes(token: string) { return api<{ notes: PersonalNote[] }>('/api/notes', {}, token); }
export async function saveNote(note: Partial<PersonalNote>, token: string) {
  return api<{ note: PersonalNote }>('/api/notes', { method: 'POST', body: JSON.stringify(note) }, token);
}
export async function deleteNote(id: string, token: string) {
  return api<{ ok: boolean }>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);
}
