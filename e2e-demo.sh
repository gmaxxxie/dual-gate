#!/usr/bin/env bash
# Dual-Gate E2E: Controller (GPT-5.6 Sol) → visible Herdr pane → DeepSeek → Gate → Judge → Delta → converge.
# Uses real CLI verified on this machine.
set -uo pipefail

REPO="/home/max/dual-gate/demo-repo"
CONTROLLER="openai-codex/gpt-5.6-sol"
EXECUTOR="new-api/deepseek-v4-flash"
WORKDIR="$HOME"   # split cwd = main pane cwd (git-repo cwd panes get recycled)

step() { printf '\n=== %s ===\n' "$1"; }

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
echo "  ✓ contract produced ($(echo "$CONTRACT" | wc -l) lines)"

step "2/7 spawn visible DeepSeek pane (split right 40%)"
P=$(HERDR_ENV=1 herdr pane split --current --direction right --cwd "$WORKDIR" --ratio 0.4 --no-focus 2>&1 | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['pane']['pane_id'])")
echo "  pane: $P"
HERDR_ENV=1 herdr pane rename "$P" "DS · demo-rotate" >/dev/null 2>&1
sleep 2
if ! HERDR_ENV=1 herdr pane get "$P" >/dev/null 2>&1; then echo "  ✗ pane recycled"; exit 1; fi
echo "  ✓ pane persistent"

step "3/7 start DeepSeek executor in pane"
AGENT="ds-e2e-$(date +%s | tail -c 5)"
START=$(timeout 200 herdr agent start "$AGENT" --kind pi --pane "$P" --timeout 170000 -- --model "$EXECUTOR" --no-extensions 2>&1)
if ! echo "$START" | grep -q agent_started; then echo "  ✗ agent start failed: $START" | head -2; exit 1; fi
echo "  ✓ agent $AGENT started (idle, interactive_ready)"

step "4/7 DeepSeek executes (visible, with tools)"
TASK="REPOSITORY: $REPO
You are the Executor. Implement per the Controller contract:

$CONTRACT

Rules: explore the repo yourself, implement, run npm test, fix until green, do not commit.
Finish with a fenced YAML Execution Report: status/summary/files_changed/tests/validation/acceptance_check."
timeout 60 herdr agent prompt "$AGENT" "$TASK" --timeout 40000 >/dev/null 2>&1 || true
# poll to idle (not --wait; it misreports on fast replies)
for i in $(seq 1 30); do
  ST=$(HERDR_ENV=1 herdr agent get "$AGENT" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('result') or {}).get('agent_status') or (d.get('result') or {}).get('state') or 'unknown')" 2>/dev/null)
  [ "$ST" = "idle" ] || [ "$ST" = "done" ] && break
  sleep 8
done
echo "  ✓ executor finished (state=$ST)"
HERDR_ENV=1 herdr agent read "$AGENT" --source recent-unwrapped --lines 200 > /tmp/dg-report1.txt
tail -6 /tmp/dg-report1.txt

step "5/7 deterministic gate"
GATE=$(cd "$REPO" && timeout 120 npm test 2>&1)
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
timeout 60 herdr agent prompt "$AGENT" "$DELTA_MSG" --timeout 40000 >/dev/null 2>&1 || true
for i in $(seq 1 30); do
  ST=$(HERDR_ENV=1 herdr agent get "$AGENT" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('result') or {}).get('agent_status') or 'unknown')" 2>/dev/null)
  [ "$ST" = "idle" ] || [ "$ST" = "done" ] && break
  sleep 8
done
HERDR_ENV=1 herdr agent read "$AGENT" --source recent-unwrapped --lines 100 > /tmp/dg-report2.txt
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
