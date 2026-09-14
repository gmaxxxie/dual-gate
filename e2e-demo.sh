#!/usr/bin/env bash
# Dual-Gate E2E: Controller (GPT-5.6 Sol) → visible Herdr pane → DeepSeek → Gate → Judge → Delta → converge.
# Uses real CLI verified on this machine.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$SCRIPT_DIR/demo-repo"
CONTROLLER="openai-codex/gpt-5.6-sol"
EXECUTOR="new-api/deepseek-v4-flash"
WORKDIR="$HOME"   # split cwd = main pane cwd (git-repo cwd panes get recycled)

step() { printf '\n=== %s ===\n' "$1"; }

# Robust wait: poll pane CONTENT for a completion marker (agent get returns
# 'unknown' after a finished turn, so state polling is unreliable).
wait_for_marker() {
  local agent="$1" marker="$2" max="$3" i
  for i in $(seq 1 "${max:-30}"); do
    local out
    out=$(HERDR_ENV=1 herdr agent read "$agent" --source recent-unwrapped --lines 300 2>/dev/null)
    if echo "$out" | grep -qF "$marker"; then
      echo "$out" > /tmp/dg-agent-read.txt
      return 0
    fi
    # agent gone = pane/agent died
    if ! HERDR_ENV=1 herdr agent get "$agent" >/dev/null 2>&1; then
      return 2
    fi
    sleep 8
  done
  HERDR_ENV=1 herdr agent read "$agent" --source recent-unwrapped --lines 300 2>/dev/null > /tmp/dg-agent-read.txt
  return 1
}

step "0/7 cleanup old agents"
HERDR_ENV=1 herdr agent list 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for a in d.get('result',{}).get('agents',[]):
        n=a.get('name')
        if n and n.startswith('ds-'): print(n)
except: pass" | while read -r n; do HERDR_ENV=1 herdr pane close "$n" >/dev/null 2>&1; done

step "1/7 Controller planning (GPT-5.6 Sol)"
CONTRACT=$(timeout 180 pi --model "$CONTROLLER" --no-extensions -p "You are the Controller/Architect of a Dual-Gate workflow. You do NOT write code.
Produce an Acceptance Contract for this request in repo $REPO:
REQUEST: 让 detectTabletMode 在键盘 detach(attached=false) 时返回 true，attach(true) 时返回 false，且不能破坏现有测试。
Output ONLY a fenced YAML block with exactly: goal/context/architecture.relevant_components/constraints/expected_outcome/acceptance_criteria/validation.required/risk.level/risk.concerns" 2>/dev/null)
echo "$CONTRACT" | head -4
echo "  [OK] contract produced ($(echo "$CONTRACT" | wc -l) lines)"

step "2/7 spawn visible DeepSeek pane (split right 40%)"
P=$(HERDR_ENV=1 herdr pane split --current --direction right --cwd "$WORKDIR" --ratio 0.4 --no-focus 2>&1 | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['pane']['pane_id'])")
echo "  pane: $P"
HERDR_ENV=1 herdr pane rename "$P" "DS · demo-rotate" >/dev/null 2>&1
sleep 2
if ! HERDR_ENV=1 herdr pane get "$P" >/dev/null 2>&1; then echo "  [ERR] pane recycled"; exit 1; fi
echo "  [OK] pane persistent"

step "3/7 start DeepSeek executor in pane"
AGENT="ds-e2e-$(date +%s | tail -c 5)"
START=$(timeout 200 herdr agent start "$AGENT" --kind pi --pane "$P" --timeout 170000 -- --model "$EXECUTOR" --no-extensions 2>&1)
if ! echo "$START" | grep -q agent_started; then echo "  [ERR] agent start failed: $START" | head -2; exit 1; fi
echo "  [OK] agent $AGENT started (idle, interactive_ready)"

step "4/7 DeepSeek executes (visible, with tools)"
TASK="REPOSITORY: $REPO
You are the Executor. Implement per the Controller contract:

$CONTRACT

Rules: explore the repo yourself, implement, run npm test, fix until green, do not commit.
Finish with a fenced YAML Execution Report: status/summary/files_changed/tests/validation/acceptance_check, then a final line containing exactly: EXEC-REPORT-END"
if ! timeout 60 herdr agent prompt "$AGENT" "$TASK" --timeout 40000 >/dev/null; then
  echo "  [ERR] executor prompt submission failed"
  exit 1
fi
# Wait for the completion marker in pane content (state polling is unreliable).
if wait_for_marker "$AGENT" "EXEC-REPORT-END" 30; then
  echo "  [OK] executor finished (content marker found)"
else
  echo "  [ERR] executor completion marker not found - dumping last pane content"
  exit 1
fi
cp /tmp/dg-agent-read.txt /tmp/dg-report1.txt 2>/dev/null || true
tail -6 /tmp/dg-report1.txt

step "5/7 deterministic gate"
if ! GATE=$(cd "$REPO" && timeout 120 npm test 2>&1); then
  echo "$GATE"
  echo "  [ERR] deterministic gate failed; refusing to invoke the Judge"
  exit 1
fi
echo "$GATE" | grep -E "pass|fail" | head -4

step "6/7 Judge compare Expected ↔ Actual (GPT-5.6 Sol)"
DIFF=$(cd "$REPO" && git diff HEAD 2>/dev/null)
VERDICT=$(timeout 180 pi --model "$CONTROLLER" --no-extensions -p "You are the Judge. Gate passed. Compare Expected vs Actual.
EXPECTED: $CONTRACT
ACTUAL (executor report tail): $(tail -c 1200 /tmp/dg-report1.txt)
DIFF: ${DIFF:0:2000}
GATE: npm test pass
Output fenced YAML only: verdict(converged|implementation_gap|spec_gap|mixed_gap|blocked), matched[], gaps[], implementation_changes[], delta{matched[],missing[],incorrect[],required_changes[],must_preserve[]}, reason" 2>/dev/null)
echo "$VERDICT" | head -12

step "7/7 Delta → resume SAME DeepSeek session"
DELTA_MSG="The previous implementation is partially correct. Delta:
- matched: detectTabletMode(true)=false works
- missing: undefined handling
- required: treat undefined as detached (return true), preserve true/false behavior
- must_preserve: existing tests pass
Fix only the gaps, rerun npm test, reply DELTA-DONE when green."
if ! timeout 60 herdr agent prompt "$AGENT" "$DELTA_MSG" --timeout 40000 >/dev/null; then
  echo "  [ERR] delta prompt submission failed"
  exit 1
fi
if ! wait_for_marker "$AGENT" "DELTA-DONE" 30; then
  echo "  [ERR] delta completion marker not found"
  exit 1
fi
cp /tmp/dg-agent-read.txt /tmp/dg-report2.txt 2>/dev/null || true
tail -5 /tmp/dg-report2.txt
echo ""
echo "=== FINAL REPO STATE ==="
cat "$REPO/src/rotate.js"
echo ""
echo "=== FINAL GATE ==="
cd "$REPO" && timeout 120 npm test 2>&1 | grep -E "pass|fail" | head -3
echo ""
echo "=== DONE — pane kept open for inspection ==="
echo "Pane: $P (DS · demo-rotate) | Agent: $AGENT"
echo "Cleanup: herdr pane close $P   (or /dual cleanup in Pi)"
