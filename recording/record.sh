#!/usr/bin/env bash
# Render the README demo + walkthrough GIFs with VHS on the host.
# Hermetic where it matters: every tape runs against an isolated tmux socket
# (-L smux-demo) and a fresh copy of the synthetic recording/demo-project
# fixture — your real tmux server, prompt, and config never appear on screen.
#
#   recording/record.sh                    # render all tapes
#   recording/record.sh dashboard init     # render only those tapes
#
# Outputs:
#   assets/demo.gif + assets/demo.mp4   (hero — tapes/demo.tape)
#   assets/usage/<name>.gif             (walkthroughs — tapes/<name>.tape)
#
# Requires: vhs, tmux ≥ 3.2, node ≥ 18, pnpm, a "JetBrainsMono Nerd Font"
# install (the tmux theme uses nerd-font pill glyphs).
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
SOCKET="smux-demo"

command -v vhs >/dev/null || { echo "vhs not on PATH" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux not on PATH" >&2; exit 1; }
[ -f "$REPO/dist/index.js" ] || { echo "dist/index.js missing — run pnpm build first" >&2; exit 1; }

TAPES=()
if [ "$#" -eq 0 ]; then
  for t in "$REPO"/recording/tapes/*.tape; do
    TAPES+=("$(basename "$t" .tape)")
  done
else
  TAPES=("$@")
fi

# Scratch area: demo project copy + a throwaway XDG home so `sidemux init`
# never prompts about (or touches) your real ~/.config/sidemux.
SCRATCH="$(mktemp -d -t sidemux-recording-XXXXXX)"
trap 'tmux -L "$SOCKET" kill-server 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/xdg/sidemux"
printf 'session = "smux"\n' > "$SCRATCH/xdg/sidemux/config.toml"

export SIDEMUX_REPO="$REPO"
export XDG_CONFIG_HOME="$SCRATCH/xdg"
export SIDEMUX_TMUX_SOCKET="$SOCKET"

mkdir -p "$REPO/assets/usage"
cd "$REPO"   # tape Output paths are relative to vhs's cwd

for name in "${TAPES[@]}"; do
  tape="$REPO/recording/tapes/$name.tape"
  [ -f "$tape" ] || { echo "no such tape: $tape" >&2; exit 1; }
  echo "==> $name"
  # Fresh fixture + clean socket per tape so journeys don't bleed into each other.
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH/acme-web"
  cp -r "$REPO/recording/demo-project" "$SCRATCH/acme-web"
  DEMO_DIR="$SCRATCH/acme-web" vhs "$tape"
done

tmux -L "$SOCKET" kill-server 2>/dev/null || true
echo "==> done"
ls -lh "$REPO"/assets/demo.* "$REPO"/assets/usage/*.gif 2>/dev/null || true
