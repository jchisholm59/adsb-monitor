#!/usr/bin/env bash
# adsb-monitor installer: checks Node 22+, sets up .env (asks for the key settings), and runs the monitor under pm2
# so it starts on boot. Safe to run again: it keeps an existing .env unless you choose to change it.
#   ./install.sh            interactive
#   ./install.sh --yes      use the defaults / existing .env, no questions (set PIAWARE=... etc. in the environment)
set -euo pipefail
cd "$(dirname "$0")"
NAME=adsb-monitor PORT_DEFAULT=7100 YES=0
[ "${1:-}" = "--yes" ] && YES=1
say() { printf '\033[1m%s\033[0m\n' "$*"; }
ask() { # ask VAR "question" default
  local var=$1 q=$2 def=${3:-} cur=${!1:-}
  [ -n "$cur" ] && def=$cur
  if [ $YES = 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "$q${def:+ [$def]}: " ans || true
  printf -v "$var" '%s' "${ans:-$def}"
}
setenv() { # setenv KEY VALUE: set or add KEY=VALUE in .env
  local k=$1 v=$2 e
  e=${v//\\/\\\\}; e=${e//&/\\&}; e=${e//|/\\|}
  if grep -q "^$k=" .env; then sed -i.bak "s|^$k=.*|$k=$e|" .env && rm -f .env.bak; else echo "$k=$v" >>.env; fi
}

say "1/4 Node.js"
if ! command -v node >/dev/null; then
  echo "Node.js isn't installed. Install Node 22 or newer (https://github.com/nodesource/distributions, or nvm), then run this again."; exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then echo "Node $(node -v) is too old: $NAME needs 22 or newer."; exit 1; fi
echo "Node $(node -v): OK"

say "2/4 pm2"
if ! command -v pm2 >/dev/null; then
  echo "Installing pm2 (npm i -g pm2)..."
  npm i -g pm2 || { echo "Couldn't install pm2 globally. Try: sudo npm i -g pm2   (then run this again)"; exit 1; }
fi
echo "pm2 $(pm2 -v 2>/dev/null | tail -1): OK"

say "3/4 Settings (.env)"
change=y
if [ -f .env ]; then
  if [ $YES = 1 ]; then change=n; else read -r -p ".env already exists. Change its main settings? [y/N]: " change || true; fi
else
  cp .env.example .env
fi
if [[ "${change,,}" == y* ]] || [ ! -s .env ] || [ $YES = 1 -a ! -f .env.installed ]; then
  cur() { sed -n "s/^$1=//p" .env | head -1; }
  PIAWARE=${PIAWARE:-$(cur PIAWARE)}; AIRPORT=${AIRPORT:-$(cur AIRPORT)}; NTFY_URL=${NTFY_URL:-$(cur NTFY_URL)}
  HA_WEBHOOK=${HA_WEBHOOK:-$(cur HA_WEBHOOK)}; PORT=${PORT:-$(cur PORT)}
  ask PIAWARE "Your PiAware / dump1090-fa (SkyAware) address" "${PIAWARE:-http://localhost}"
  ask AIRPORT "Your local airport's ICAO code, for arrival alerts (blank: none)" "$AIRPORT"
  ask NTFY_URL "ntfy topic URL for phone alerts without Home Assistant (blank: none)" "$NTFY_URL"
  ask HA_WEBHOOK "Home Assistant webhook URL for phone alerts (blank: none)" "$HA_WEBHOOK"
  ask PORT "Port for the dashboard" "${PORT:-$PORT_DEFAULT}"
  setenv PIAWARE "$PIAWARE"; setenv AIRPORT "$AIRPORT"; setenv NTFY_URL "$NTFY_URL"; setenv HA_WEBHOOK "$HA_WEBHOOK"; setenv PORT "$PORT"
  touch .env.installed
fi
chmod 600 .env
PORT=$(sed -n 's/^PORT=//p' .env | head -1); PORT=${PORT:-$PORT_DEFAULT}

say "4/4 Start under pm2"
if pm2 describe "$NAME" >/dev/null 2>&1; then pm2 restart "$NAME" --update-env >/dev/null; else pm2 start ecosystem.config.js >/dev/null; fi
pm2 save >/dev/null
sleep 3
if curl -fsS -m 5 "http://localhost:$PORT/api/status" >/dev/null 2>&1; then echo "$NAME is running."; else echo "$NAME started, but isn't answering yet: pm2 logs $NAME"; fi
startup=$(pm2 startup 2>/dev/null | grep -E '^sudo ' | head -1 || true)
[ -n "$startup" ] && { echo; echo "To start it on boot, run this once (it needs sudo):"; echo "  $startup"; }
echo
ip=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$ip" ] || ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
say "Dashboard: http://${ip:-localhost}:$PORT/"
echo "Logs: pm2 logs $NAME    Settings: nano .env, then pm2 restart $NAME --update-env"
