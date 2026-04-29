#!/bin/bash
# Trading cockpit — one-shot install for macOS
set -e

say() { printf "\n\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }

# Run from inside the project folder
if [ ! -f pnpm-workspace.yaml ]; then
  echo "ERROR: run this from inside the trading-cockpit directory"; exit 1
fi

# 1. Xcode Command Line Tools (better-sqlite3 needs to compile)
say "Xcode Command Line Tools"
if xcode-select -p &>/dev/null; then ok "installed"; else
  xcode-select --install || true
  echo "A popup just appeared — click Install, wait for it to finish, then re-run this script."
  exit 0
fi

# 2. Homebrew
say "Homebrew"
if command -v brew &>/dev/null; then ok "installed"; else
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Ensure brew is on PATH for this session (works on Apple Silicon and Intel)
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"

# 3. Node 20+
say "Node.js"
if command -v node &>/dev/null && [ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge 20 ]; then
  ok "$(node -v) installed"
else
  brew install node@20
  brew link --overwrite --force node@20 || true
fi

# 4. pnpm (via corepack which ships with Node 20)
say "pnpm"
if command -v pnpm &>/dev/null; then ok "$(pnpm -v) installed"; else
  corepack enable || true
  corepack prepare pnpm@latest --activate || true
  command -v pnpm &>/dev/null || npm install -g pnpm
fi

# 5. pm2
say "pm2"
if command -v pm2 &>/dev/null; then ok "$(pm2 -v) installed"; else
  npm install -g pm2
fi

# 6. Python 3 + websockets
say "Python 3"
command -v python3 &>/dev/null || brew install python@3.12
ok "$(python3 --version)"

say "Python websockets package"
python3 -m pip install --user --upgrade websockets 2>/dev/null \
  || python3 -m pip install --break-system-packages --upgrade websockets

# 7. .env
[ -f .env.example ] && [ ! -f .env ] && cp .env.example .env && ok ".env created"

# 8. Project deps
say "Installing JS dependencies (this is the slow part)"
pnpm install

printf "\n\033[1;32m═══ ALL SET ═══\033[0m\n"
echo ""
echo "Next:"
echo "  1. Edit .env — paste your Discord webhook URL into DISCORD_WEBHOOK"
echo "  2. Run:  pnpm dev"
echo "  3. Open: http://127.0.0.1:5173"
