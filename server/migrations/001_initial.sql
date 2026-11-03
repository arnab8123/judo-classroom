-- Initial Judo SQLite schema. db.js applies these CREATE TABLE IF NOT EXISTS statements on startup.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK(role IN ('teacher','admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (user_id, provider)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classrooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'German',
  host_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permanent INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_classrooms_host ON classrooms(host_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  classroom_code TEXT NOT NULL,
  participant_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attendance_room ON attendance(classroom_code, joined_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  classroom_code TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(classroom_code, created_at DESC);
CREATE TABLE IF NOT EXISTS board_events (
  id TEXT PRIMARY KEY,
  classroom_code TEXT NOT NULL,
  object_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_board_room ON board_events(classroom_code, created_at ASC);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  classroom_code TEXT,
  title TEXT NOT NULL DEFAULT 'Class notes',
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_key, updated_at DESC);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  classroom_code TEXT NOT NULL,
  uploader_key TEXT NOT NULL,
  uploader_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_uploads_room ON uploads(classroom_code, created_at DESC);
