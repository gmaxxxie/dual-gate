#!/usr/bin/env bash
# Install Dual-Gate Orchestrator into Pi global extensions.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/extension" && pwd)"
DEST_DIR="$HOME/.pi/agent/extensions/dual-gate"

echo "Installing Dual-Gate Orchestrator…"
echo "  source: $SRC_DIR"
echo "  dest:   $DEST_DIR"

mkdir -p "$DEST_DIR"
cp "$SRC_DIR"/*.ts "$DEST_DIR/" 2>/dev/null || true
cp "$SRC_DIR"/package.json "$DEST_DIR/" 2>/dev/null || true

echo ""
echo "Installed files:"
ls -1 "$DEST_DIR"/*.ts 2>/dev/null | sed "s|$HOME|~|"

echo ""
echo "Dual-Gate requires Herdr. Checking…"
if command -v herdr >/dev/null 2>&1; then
  HERDR_VER="$(herdr --version 2>/dev/null | head -1 || true)"
  echo "  herdr: $HERDR_VER ✓"
else
  echo "  herdr: NOT FOUND — Dual-Gate requires Herdr." >&2
  exit 1
fi

echo ""
echo "Next steps:"
echo "  1. Restart Pi (or /reload) to load the extension."
echo "  2. Run /dual on"
echo "  3. Type a task — Dual-Gate plans (GPT-5.6 Sol), spawns a visible DeepSeek pane, gates, judges, converges."
echo ""
echo "Config: ~/.pi/agent/dual-gate.json (auto-created with defaults on first run)."
