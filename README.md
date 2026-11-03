# Judo — Simple Video Classes

Judo is a full-stack classroom app for a small language institute. The React website and Node API can run together as a single web service, while LiveKit carries the actual audio/video traffic. It is designed for a single API instance with persistent storage; it is not a static mockup, and it is not yet a feature-for-feature Google Meet replacement.

## Landing page and meeting creation

The home page uses a Google Meet-inspired single-screen layout with an orange-and-black light theme and an orange-and-white-on-dark theme. The theme choice is saved in the browser. Students can join using a meeting ID/code or paste an invitation URL. Hosts have three creation options: start an instant room, schedule a meeting for a chosen future date/time, or create a persistent hosted classroom. Creating a meeting requires a signed-in teacher account; the account that creates the room is its host/admin and receives a unique meeting ID and shareable link. Scheduled meeting times are stored and displayed in the host dashboard. The room link is created immediately and is not time-locked until the scheduled time.

## What is implemented

- Host registration with bcrypt password hashing, signed sessions, and a remember-me choice. Optional Google, Microsoft/Outlook, and GitHub sign-in can be enabled with provider credentials.
- Teacher dashboard to create classrooms, copy/share invite links, enter rooms, and end a room for everyone.
- Guest joining by meeting link/code and display name without a student account.
- Pre-join camera/microphone preview, toggles, and device selection where supported by the browser.
- LiveKit/WebRTC audio and video, participant tiles, camera/microphone indicators, active-speaker styling, reconnection status, and leave controls.
- Independently tracked screen shares with optional captured audio. Capture of multiple displays and system/tab audio depends on browser and operating-system capabilities.
- Socket.IO real-time chat and participant reactions, raised hands, teacher announcements, plus bounded chat history.
- Collaborative whiteboard with pen, eraser, color/width, undo-own-stroke, teacher-only clear, and PNG export.
- Shared classroom file upload/download for PDF, DOC/DOCX, TXT, PPT/PPTX, JPG/JPEG, PNG, and WEBP. File size, extension/MIME, and basic file signatures are checked; this is not a substitute for malware scanning.
- Private notes scoped to the current teacher/guest identity, with automatic saving and TXT/Markdown downloads.
- Join/leave attendance records, a teacher attendance view, CSV export, and deletion of ended classrooms with their stored class data.
- Rate limiting for login, room, file, and notes HTTP routes plus throttling for sensitive Socket.IO events.
- SQLite persistence, persistent-data path configuration, graceful shutdown, API health endpoint, and same-origin production hosting of the built frontend.

## Known limitations

- **LiveKit is required for media.** The application API does not relay audio/video. Use LiveKit Cloud or a correctly configured public server. The included Docker LiveKit service is for local development only.
- The whiteboard currently supports freehand pen/eraser, undo, teacher clear, zoom, and PNG export. Text objects, shapes, multi-page boards, PDF export, and teacher editing lock are not implemented.
- Notes are a practical plain-text editor with multiple pages and search/download utilities; rich-text editing and PDF export are not implemented. A guest's identity/recovery key is kept in that browser's local storage, so a display name alone cannot recover notes on another device.
- Waiting room approvals, room passwords, recording, breakout rooms, polls/quizzes, dictionary lookup, malware scanning, file previews, resumable uploads, and complete teacher moderation tools are not implemented.
- Files and SQLite are stored on one persistent filesystem. Run one API instance only. Before scaling to multiple instances, migrate to PostgreSQL/shared object storage and add distributed realtime coordination.
- Source checks and schema checks are useful but do not replace live browser-to-browser testing on the network/device combinations used by students.

## Architecture

```text
Browser: React + TypeScript + Vite
  ├── LiveKit client SDK ─────────── WebRTC audio/video/screen-share tracks
  └── Socket.IO client ───────────── presence, chat, whiteboard, reactions
                 │
                 ▼
Node.js + Express + Socket.IO API
  ├── teacher/guest token validation
  ├── room and attendance records
  ├── chat and whiteboard persistence
  ├── owner-scoped private notes
  └── authorized file upload/download
                 │
                 ├── SQLite file on persistent disk
                 └── uploaded files on persistent disk
```

## Requirements

- Node.js 22.22+ and npm. Use the current Node.js 22 LTS release.
- Docker Engine/Desktop for the bundled local LiveKit service, or an existing reachable LiveKit instance.
- HTTPS for public deployments. Modern browsers require a secure context for camera, microphone, and screen capture; `localhost` works during local development.

## Install Docker on Ubuntu (if `docker: command not found`)

The LiveKit service cannot start until Docker is installed. On a standard Ubuntu installation, run:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker --version
sudo docker compose version
```

If `docker-compose-v2` is unavailable in your Ubuntu repository, try `sudo apt install -y docker.io docker-compose` and check `docker compose version` again. Use `sudo docker compose ...` if your account is not in the Docker group. Do not add yourself to the Docker group unless you understand that it grants root-equivalent privileges.

## Run locally on Ubuntu/Linux

Run all commands from the extracted project root. The easiest way on Ubuntu is:

```bash
chmod +x ./start-judo.sh
./start-judo.sh
```

This helper checks the Node and Docker versions, creates the local `.env` files only if they do not already exist, installs dependencies, updates/recreates the existing local LiveKit service, creates the first local teacher account if needed, and launches both the API and website. The Compose project name is kept as `language-classroom` so an existing container from the earlier Judo/LinguaRoom folder is reused instead of creating a second container that competes for port 7880. It does not overwrite existing local `.env` files or reset an existing teacher password.

For manual setup, use the steps below.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local settings:

   ```bash
   cp server/.env.example server/.env
   cp client/.env.example client/.env
   ```

   These example files contain development-only values. Do not use the default credentials or LiveKit dev credentials in production.

3. Start the local LiveKit service:

   ```bash
   docker compose up -d livekit
   docker compose ps
   ```

4. Create the first local teacher account:

   ```bash
   npm run seed
   ```

   Local defaults are `teacher@demo.local` / `Classroom123!`.

5. Start the API and Vite frontend. The root launcher starts both workspaces directly and does not rely on `concurrently`, so a missing optional CLI cannot stop the app:

   ```bash
   npm run dev
   ```

6. Open <http://localhost:5173>, select **Teacher sign in**, create a classroom, and share its link. A second browser on the same computer is the easiest local test. The dev frontend derives both the API and the browser-facing LiveKit hostname from the page hostname. Localhost works on the same computer. For another device on your LAN, open Judo using the host computer’s LAN IP; the API and LiveKit must be reachable on that IP, and the browser generally requires HTTPS for camera/microphone access on non-localhost addresses. For reliable external student access, deploy Judo on HTTPS and use LiveKit Cloud or a properly configured public LiveKit server.

Useful local endpoints:

- Website: <http://localhost:5173>
- API health: <http://localhost:3001/api/health>
- Local LiveKit WebSocket: `ws://localhost:7880`
- LiveKit WebRTC UDP mux: `7882/udp` (published by the Docker Compose file)

Stop the app with `Ctrl+C`, and stop LiveKit with `docker compose down`.

### Start after the first setup

From the project root, start LiveKit (if it is not running) and the app:

```bash
docker compose up -d livekit
npm run dev
```

You normally do not need to repeat `npm install` or `npm run seed` unless dependencies or the initial database setup changes.

## Recommended deployment: Render + LiveKit Cloud

The included `render.yaml` describes a **single Render web service** that builds the frontend, serves it from the Node API, and stores SQLite data/uploads under `/var/data`. This avoids the common production bug where the browser mistakenly calls `localhost:3001` on a student's own device.

### 1. Create the LiveKit media project

Create a LiveKit Cloud project and copy the server URL, API key, and API secret from its dashboard. LiveKit access tokens must be signed on the server; never expose the API secret to the browser. Official guides: [LiveKit JS server SDK](https://docs.livekit.io/reference/server-sdk-js/) and [token grants](https://docs.livekit.io/home/server/generating-tokens/).

You will need these four values in the Render service environment:

| Environment variable | Value |
|---|---|
| `LIVEKIT_URL` | Public WebSocket URL beginning with `wss://` |
| `LIVEKIT_HTTP_URL` | Matching HTTPS API URL beginning with `https://` |
| `LIVEKIT_API_KEY` | Private server API key |
| `LIVEKIT_API_SECRET` | Private server API secret |

### 2. Push this project to GitHub

Create a repository and push the entire project root, including `render.yaml`. Do not commit `.env` files, database files, uploaded files, or real API credentials. The included `.gitignore` excludes the local environment files and runtime data.

### 3. Create the Render Blueprint

In Render, create a new **Blueprint** and select the GitHub repository. Render reads `render.yaml` from the repository root. Review the service settings before deploying. Render's official references explain [Blueprint configuration](https://render.com/docs/blueprint-spec) and [persistent disks](https://render.com/docs/disks).

The template provisions a paid web-service plan with a 1 GB persistent disk. This is intentional: Render's filesystem is otherwise ephemeral, so a SQLite database and uploaded files could be lost on a redeploy/restart. The persistent disk makes this a single-instance service and is appropriate for a small class, not a horizontally scaled production system.

### 4. Enter the initial teacher and LiveKit values

When the Blueprint asks for values, supply:

- `SEED_TEACHER_NAME`: the teacher's display name.
- `SEED_TEACHER_EMAIL`: the email used to sign in.
- `SEED_TEACHER_PASSWORD`: a unique password of **at least 14 characters**.
- The four `LIVEKIT_*` values from Step 1.

Render generates `AUTH_SECRET` for you. Keep the generated value private. The app's startup command runs `npm run seed` before starting the server: if the persistent database has no teacher account, it creates the initial account from these variables; after an account exists, it skips provisioning. Keep the seed variables private in Render and do not write their values into source code. The password is not logged in production.

If you attach a custom domain, add its full HTTPS origin to `CLIENT_ORIGIN` in the Render environment. For multiple origins, separate them with commas. The Render-provided service origin is automatically allowed by the application; production does not allow the local Vite origin unless you explicitly configure it.

### 5. Verify the deployment

After deployment completes:

1. Visit `https://your-service.onrender.com/api/health`. It should return JSON with `"ok": true`.
2. Open the service's HTTPS root URL and sign in with the initial teacher credentials from Step 4.
3. Create a classroom and test the invitation link in a second browser/device on a different network if possible.
4. Verify camera, microphone, screen share, chat, whiteboard synchronization, file uploads/downloads, notes privacy, and attendance CSV.
5. Inspect Render logs and LiveKit diagnostics if a room opens but media does not connect.

For production, **do not** expose the bundled `docker-compose.yml` LiveKit development service. Its `devkey`/`secret` values and development mode are for local testing only.

### Alternative hosting

You can deploy the built frontend separately and set `VITE_API_URL` in the frontend build to the HTTPS API origin. Then set the API's `CLIENT_ORIGIN` to the exact frontend origin. The simpler supported path for this repository is the single Render service. If hosting the frontend and API separately, make sure the Socket.IO origin is allowed too.

## Environment variables

### Server (`server/.env` locally; deployment environment variables in production)

| Variable | Purpose |
|---|---|
| `PORT` | API port, default `3001`; hosting providers usually set this automatically. |
| `NODE_ENV` | Set to `production` in deployment. |
| `CLIENT_ORIGIN` | Comma-separated browser origins allowed to use the API/Socket.IO. |
| `AUTH_SECRET` | Random secret used to sign app and guest tokens; production requires a long secret. |
| `DB_PATH` | SQLite file path; a relative value is resolved from `server/`. |
| `UPLOAD_DIR` | Upload path; a relative value is resolved from `server/`. |
| `MAX_UPLOAD_MB` | Maximum uploaded file size per file, default `15`. |
| `LIVEKIT_URL` | Default LiveKit websocket URL (`ws://` locally, `wss://` publicly); also used to derive the local HTTP API URL when `LIVEKIT_HTTP_URL` is omitted. |
| `LIVEKIT_PUBLIC_URL` | Optional browser-only override. Leave blank in local development to derive the browser hostname; set to the public `wss://` URL if it differs from `LIVEKIT_URL`. |
| `LIVEKIT_PUBLIC_PORT` | Optional local development port for the derived browser LiveKit URL; defaults to the configured `LIVEKIT_URL` port or `7880`. |
| `LIVEKIT_HTTP_URL` | Server API URL (`http://` locally, `https://` publicly). |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Private LiveKit server credentials. |
| `APP_BASE_URL` | Public frontend URL used after OAuth sign-in; defaults to the Render service URL in production. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google OAuth web client. Register `http://localhost:3001/api/auth/oauth/google/callback` locally and `https://your-domain/api/auth/oauth/google/callback` in production. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Optional Microsoft account (including Outlook) OAuth app. Register `/api/auth/oauth/microsoft/callback` as its web redirect URI. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional GitHub OAuth app. Register `/api/auth/oauth/github/callback` as its callback URL. |
| `SEED_TEACHER_NAME`, `SEED_TEACHER_EMAIL`, `SEED_TEACHER_PASSWORD` | Used only to provision the first teacher when the database is empty. |

Host accounts can also be created with an email and password (12 characters minimum). OAuth client secrets stay on the server. Provider buttons remain unavailable until both credentials are configured. WhatsApp does not provide a standard website sign-in flow; phone verification through WhatsApp requires a separate Meta WhatsApp Business OTP service and is not enabled here. Deleting an ended classroom permanently deletes its attendance, chat, whiteboard, private class notes, and uploaded files.

### Frontend (`client/.env` locally)

`VITE_API_URL` can stay blank for local Vite use (it derives the API host from the current page and uses port `3001`) and for same-origin production (it defaults to the current website origin). Only set it if the frontend and API are on different origins. `LIVEKIT_PUBLIC_URL` is optional: leave it blank during local development so Judo derives the websocket hostname from the browser origin; set it to the public `wss://` URL when it differs from `LIVEKIT_URL`. Never put `AUTH_SECRET` or `LIVEKIT_API_SECRET` in any `VITE_*` variable; browser bundles are public.

## Back up classroom data

SQLite and uploaded lesson files are important institute data. Before upgrades or large classes, run:

```bash
npm run backup
```

This creates a timestamped folder under `server/backups/` by default, containing a SQLite-consistent snapshot, a copy of uploaded files, and basic metadata. It uses SQLite's backup API rather than copying the live database file directly. The backup folder is git-ignored because it may contain private class information. Copy backups to a separate, access-controlled location; a backup on the same disk does not protect against loss of that disk. On the Render template, `BACKUP_DIR` is `/var/data/backups`. Configure an off-host backup routine before relying on this for important student data.

## Build and validation

```bash
npm run build
npm run check
npm test
```

The build type-checks and bundles the frontend, performs Node syntax checks for the backend, and runs the dependency-free file-signature tests. These checks do not verify actual media connectivity, browser permissions, or network traversal.

## Troubleshooting

- **`npm: command not found`:** install Node.js and npm, then reopen the terminal.
- **The website opens but API requests fail:** confirm the API is running at port 3001 in development, check `server/.env`, and look at the terminal logs.
- **Media doesn't connect:** verify the LiveKit URL is reachable from the browser and that `LIVEKIT_URL`, `LIVEKIT_HTTP_URL`, key, and secret belong to the same LiveKit project. Local `ws://localhost:7880` works only on the machine hosting Docker unless a reachable LAN/public address is configured. The local Compose config publishes LiveKit TCP 7880/7881 and UDP 7882 plus the 50000–60000 UDP range; firewalls must allow the corresponding traffic. If the container was already running before this port was added, recreate it with `docker compose up -d --force-recreate livekit`.
- **Public camera/microphone controls are unavailable:** make sure the website is HTTPS and grant browser permissions.
- **Uploads are rejected:** only the documented extensions/content types are accepted; files also need a matching basic signature and must fit within `MAX_UPLOAD_MB`.
- **Teacher sign-in fails locally:** check `server/.env`, then run `npm run seed` once and make sure the database path is the expected one. If the database already contains a teacher account, `seed` will not reset that account's password.
- **Guest notes don't appear on a second device:** guest recovery is tied to the browser's local identity key, not the display name.
- **Data disappears after deployment:** confirm `DB_PATH` and `UPLOAD_DIR` are under the attached persistent disk mount (for the template, `/var/data`).

## Final pre-class checklist

- [ ] Create a room as the teacher and join from a separate device.
- [ ] Test camera/mic on/off and denied permissions.
- [ ] Ensure a student can leave without ending the room for everyone.
- [ ] Verify the teacher can end the room.
- [ ] Test simultaneous screen sharing and optional audio on target browsers.
- [ ] Send chat messages and reconnect to verify history.
- [ ] Draw from two browsers; verify synchronization and role-based undo/clear.
- [ ] Upload valid files and try a disallowed or renamed file.
- [ ] Check notes are not exposed to another participant.
- [ ] Download attendance CSV and review the records.
- [ ] Test mobile layout and the real networks students will use.

Treat the first public deployment as a pilot. Do not use it for sensitive documents or rely on it for mission-critical classes until the full checklist has passed and you have a backup/restore procedure for persistent data.


## Meeting creation troubleshooting

- Creating an instant, scheduled, or hosted meeting requires a valid teacher sign-in. If the saved sign-in has expired, Judo clears the stale token, returns to the sign-in screen, and keeps the selected meeting action so it can continue after sign-in.
- For a local development teacher account, run `npm run seed` from the project root after setting up `server/.env`. Use the credentials configured by the seed script/environment, not public production defaults.
- If creation still fails, open the browser Developer Tools → Network, inspect the `POST /api/rooms` response, and check the backend terminal. A `401` means sign in again; a `400` usually means the meeting title or scheduled time is invalid; a `500` indicates a backend/database problem.

## Troubleshooting: meeting says Disconnected or media publishing times out

1. Start the local media server from the project root: `docker compose up -d livekit`.
2. Check it is running: `docker compose ps` and `docker compose logs --tail=100 livekit`.
3. In `server/.env`, for local use, confirm `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_HTTP_URL=http://localhost:7880`, `LIVEKIT_API_KEY=devkey`, and `LIVEKIT_API_SECRET=secret`.
4. Restart the app after editing `.env`: stop `npm run dev` with Ctrl+C, then run `npm run dev` again.
5. For a same-computer test, open `http://localhost:5173` and allow camera/microphone permissions. For a second device, `localhost` means that second device, not your Ubuntu PC; use a reachable LiveKit URL and HTTPS for camera/microphone access. The dev frontend API host is derived from the URL you opened, but the LiveKit URL still must be set in `server/.env` to a host reachable by every participant.
6. The classroom now reports media-publishing errors separately from the room connection. If the room says Connected but camera/microphone fails, use the device controls to retry and inspect the exact message.
7. To test host and student, open the copied invitation link in a second browser profile or a second device and enter a different name. Both devices must be able to reach the same LiveKit server.

For public deployment, do not use the local Docker URL or `devkey`/`secret`. Set `LIVEKIT_URL` to the public `wss://` URL and `LIVEKIT_HTTP_URL` to the matching `https://` API URL for LiveKit Cloud or a correctly deployed LiveKit server. Localhost works only from the same computer; it is not reachable by remote students. WebRTC also requires appropriate network/UDP connectivity or TURN support.


### Important: host/student connectivity

The included `ws://localhost:7880` LiveKit URL is only for testing on the same computer. For internet classes, use LiveKit Cloud (recommended for a small institute) or deploy LiveKit with a public `wss://` endpoint, TLS, firewall/UDP configuration, and TURN support. Set `LIVEKIT_URL` and `LIVEKIT_HTTP_URL` to the matching public endpoint values in the server environment. Never expose `LIVEKIT_API_SECRET` in the client environment. An HTTP LAN address may also prevent browser camera/microphone access because it is not a secure context.
