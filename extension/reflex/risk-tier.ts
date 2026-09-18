// =============================================================================
// Dual-Gate Reflex Layer — Tool Risk Gate
//
// Deterministic risk classification of a proposed tool call / command into
// LOW / MEDIUM / HIGH / CRITICAL tiers. Borrowed and extended from Bicameral's
// `s1-runtime/src/high-risk.ts` (isHighRiskByPattern / isOutsideCwd): pure
// local regex + path checks, zero model calls, zero I/O.
//
// Policy mapping (see policy.ts / orchestration):
//   LOW      → auto-execute (no judgment at all)
//   MEDIUM   → record + count, never interrupts
//   HIGH     → record + warn (configurable: warn_high)
//   CRITICAL → block or user confirm (critical_confirm)
// =============================================================================

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RiskTier, TierVerdict } from "./types.ts";

// ---------------------------------------------------------------------------
// Read-only / common dev tools — always LOW, no judgment
// ---------------------------------------------------------------------------

const READONLY_TOOLS = new Set(["read", "grep", "rg", "ls", "find", "cat", "head", "tail", "less", "which", "pwd", "git", "git-status", "git_diff", "git-log", "git_show"]);
const SAFE_EDIT_TOOLS = new Set(["edit", "write"]); // under version control → reversible → LOW

// ---------------------------------------------------------------------------
// Pattern tables (regex → tier). First match wins; most specific first.
// ---------------------------------------------------------------------------

const CRITICAL_CMDS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)/, reason: "recursive rm" },
  { re: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard" },
  { re: /\bgit\s+clean\b/, reason: "git clean" },
  { re: /\bgit\s+push\s+(?:-[a-zA-Z]*f|--force)\b/, reason: "force push" },
  { re: /\bgit\s+push\s+--force-with-lease\b/, reason: "force push (lease)" },
  { re: /\b(?:drop|truncate)\s+table\b/i, reason: "db drop/truncate" },
  { re: /\brm\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\s+(?!-)/, reason: "forced rm" },
];

const HIGH_CMDS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+push\b/, reason: "git push" },
  { re: /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|nmap)\b/, reason: "network egress" },
  { re: /\bsudo\b/, reason: "sudo" },
  { re: /(?:^|[\s;])(?:export|set|env)\s+[A-Za-z_][A-Za-z0-9_]*\s*=/, reason: "env mutation" },
  { re: /\.env(?:\.|$)|credentials?|secrets?|api[_-]?keys?|passwords?|tokens?/i, reason: "credential touch" },
  { re: /(?:chmod|chown)\s+[0-7]{3,}/, reason: "permission change" },
  { re: /(?:kill|pkill|killall)\b/, reason: "process kill" },
  { re: /(?:systemctl|service)\b/, reason: "system service control" },
  { re: /\/etc\//, reason: "system config" },
];

const MEDIUM_CMDS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b/, reason: "package install" },
  { re: /pip3?\s+install\b/, reason: "package install" },
  { re: /(?:apt(-get)?|brew|cargo|go|uv)\s+(?:install|add|remove|update)\b/, reason: "package manager" },
  { re: /\brm\b/, reason: "rm (non-recursive)" },
  { re: /\bmv\s+-f\b|\brm\s+-f\b/, reason: "forced file op" },
  { re: /git\s+checkout\s+(?:-f|--force)/, reason: "force checkout" },
  { re: /git\s+reset\s+(?!--hard)/, reason: "git reset (soft/mixed)" },
  { re: /git\s+stash\s+(?:pop|drop)/, reason: "git stash pop/drop" },
];

const LOW_CMDS: Array<{ re: RegExp; reason: string }> = [
  { re: /^(?:mkdir|touch|cp|mv|sed|awk|grep|rg|cat|ls|find|echo|export|cd|pwd|head|tail|wc|sort|uniq|diff|node|npm\s+run|npm\s+test|npm\s+run\s+test|pnpm\s+(?:run|test)|yarn\s+(?:run|test)|python3?\s+(?:-m\s+)?(?:pytest|unittest|test)|go\s+test|cargo\s+test|make\s+)/, reason: "common dev command" },
  { re: /^git\s+(?:status|diff|log|show|ls-files|branch|remote\s+-v|rev-parse|config\s+--(?:get|list)|check-ignore)/, reason: "read-only git" },
];

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function isOutsideCwd(filePath: string, cwd: string): boolean {
  const root = resolve(cwd);
  const resolved = resolve(cwd, filePath);
  const rel = relative(root, resolved);
  if (!rel) return false;
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Classify a tool call into a risk tier. Deterministic, no side effects.
 * Mirrors Bicameral's isHighRiskByPattern() with tier granularity.
 */
export function tierOf(toolName: string, input: unknown, cwd: string): TierVerdict {
  const name = toolName.toLowerCase();
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const command = typeof rec.command === "string" ? rec.command : "";
  const pathValue = typeof rec.path === "string" ? rec.path : undefined;

  // Path outside cwd → HIGH regardless of tool (checked BEFORE tool-name
  // classification so an edit/write outside the project is never LOW).
  if (pathValue && isOutsideCwd(pathValue, cwd)) {
    return { tier: "HIGH", reason: "path outside cwd", matched: "path" };
  }

  // Tool-name classification first (bash/powershell delegate to command table).
  if (READONLY_TOOLS.has(name)) return { tier: "LOW", reason: "readonly tool" };
  if (SAFE_EDIT_TOOLS.has(name)) return { tier: "LOW", reason: "edit under VCS" };

  if (name === "bash" || name === "powershell" || command) {
    const cmd = command || (name === "bash" || name === "powershell" ? "" : name);

    // CRITICAL
    for (const p of CRITICAL_CMDS) {
      if (p.re.test(cmd)) return { tier: "CRITICAL", reason: p.reason, matched: p.re.source };
    }
    // HIGH
    for (const p of HIGH_CMDS) {
      if (p.re.test(cmd)) return { tier: "HIGH", reason: p.reason, matched: p.re.source };
    }
    // MEDIUM
    for (const p of MEDIUM_CMDS) {
      if (p.re.test(cmd)) return { tier: "MEDIUM", reason: p.reason, matched: p.re.source };
    }
    // LOW common dev
    for (const p of LOW_CMDS) {
      if (p.re.test(cmd)) return { tier: "LOW", reason: p.reason, matched: p.re.source };
    }
    // Unknown command → MEDIUM (conservative default for shell, not LOW).
    return { tier: "MEDIUM", reason: "unclassified shell command" };
  }

  // Unknown tool with no command/path → MEDIUM (conservative).
  return { tier: "MEDIUM", reason: "unclassified tool" };
}

/** Task-level risk scan over a request / contract text (orchestration-time). */
export function scanTaskRisk(text: string, cwd: string): TierVerdict {
  const verdict = tierOf("bash", { command: text }, cwd);
  // A natural-language request rarely matches command regexes; treat explicit
  // destructive intent keywords as the signal instead.
  if (verdict.tier === "LOW" || verdict.tier === "MEDIUM") {
    if (/\b(?:rm -rf|delete (?:the )?(?:entire|whole)|reset --hard|force push|drop database|truncate)\b/i.test(text)) {
      return { tier: "HIGH", reason: "destructive intent keywords", matched: "intent" };
    }
  }
  return verdict;
}
