#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1 || ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 22) ? 0 : 1)"; then
  echo "Judo requires Node.js 22.22.0 or newer. Current: $(node -v 2>/dev/null || echo 'not installed')" >&2
  echo "Install a current Node.js 22 LTS release, then run this script again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing. Install npm with Node.js, then run this script again." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. On Ubuntu run:" >&2
  echo "  sudo apt update && sudo apt install -y docker.io docker-compose-v2" >&2
  echo "  sudo systemctl enable --now docker" >&2
  exit 1
fi

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    echo "Docker is installed but its daemon is unavailable. Start Docker with: sudo systemctl start docker" >&2
    exit 1
  fi
fi

[[ -f server/.env ]] || cp server/.env.example server/.env
[[ -f client/.env ]] || cp client/.env.example client/.env

echo "Installing/verifying project dependencies..."
npm install

echo "Starting the local LiveKit media server..."
"${DOCKER[@]}" compose up -d livekit

echo "Creating the initial teacher account if the database is empty..."
npm run seed

echo "Starting Judo. Open http://localhost:5173 in your browser."
exec npm run dev
