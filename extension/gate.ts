// =============================================================================
// Dual-Gate Orchestrator — deterministic gate
//
// Discovers and runs the project's own validation commands. Never fabricates a
// tool that does not exist: "project existing command > plugin guess".
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { GateStep } from "./types.ts";

export interface GateDiscovery {
  commands: Array<{ name: string; command: string[]; cwd?: string }>;
  discovered: string[];
  notes: string[];
}

export interface GateResult {
  passed: boolean;
  steps: GateStep[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const COMMON_MAKEFILES = ["Makefile", "makefile", "GNUmakefile"];
const COMMON_MAKEFILE_TARGETS = ["test", "check", "lint", "validate", "build"];
const JUSTFILE_NAMES = ["justfile", "Justfile"];
const TASKFILE_NAMES = ["Taskfile.yml", "Taskfile.yaml", "Taskfile.dist.yml"];

function fileExists(base: string, name: string): boolean {
  try {
    return existsSync(join(base, name));
  } catch {
    return false;
  }
}

function readJson(base: string, name: string): Record<string, unknown> | null {
  const p = join(base, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readYamlish(base: string, name: string): Record<string, unknown> | null {
  const p = join(base, name);
  if (!existsSync(p)) return null;
  try {
    return parseYamlish(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Minimal tolerant key: value parser for common tool configs. */
function parseYamlish(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z0-9_.\-]+)\s*[:=]\s*(.*)$/);
    if (!m) return null;
    let v: unknown = m[2].trim();
    if (/^(true|false)$/i.test(v)) v = /^true$/i.test(v);
    else if (/^-?\d+$/.test(v)) v = Number(v);
    else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/[#].*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

export function discoverGateCommands(repoPath: string): GateDiscovery {
  const commands: Array<{ name: string; command: string[]; cwd?: string }> = [];
  const discovered: string[] = [];
  const notes: string[] = [];
  const base = repoPath;

  // --- 1. CI configuration first (project-authoritative intent) ---
  const ciYaml = readYamlish(base, ".github/workflows/ci.yml") ?? readYamlish(base, ".github/workflows/ci.yaml");
  if (ciYaml) {
    const jobs = (ciYaml as { jobs?: Record<string, { steps?: unknown }> }).jobs;
    if (jobs && typeof jobs === "object") {
      for (const job of Object.values(jobs)) {
        const jobSteps = (job as { steps?: unknown }).steps;
        if (!Array.isArray(jobSteps)) continue;
        for (const s of jobSteps) {
          const run = (s as { run?: unknown }).run;
          if (typeof run !== "string") continue;
          const first = run.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
          if (!first) continue;
          const lower = first.toLowerCase();
          if (lower.startsWith("npm test") || lower.startsWith("npm run test")) {
            commands.push({ name: "ci:test", command: ["npm", "test"] });
            discovered.push(".github/workflows/ci.yml → npm test");
          }
        }
      }
    }
  }

  // --- 2. Makefile / justfile / Taskfile (generic command runner) ---
  const makefile = COMMON_MAKEFILES.find((f) => fileExists(base, f));
  if (makefile) {
    const targets = COMMON_MAKEFILE_TARGETS.filter((t) => {
      const txt = readTextFile(join(base, makefile)) ?? "";
      return new RegExp(`^${t}[:\\s]`, "m").test(txt);
    });
    for (const t of targets) {
      commands.push({ name: `make:${t}`, command: ["make", t] });
      discovered.push(`${makefile} → make ${t}`);
    }
  }

  const justfile = JUSTFILE_NAMES.find((f) => fileExists(base, f));
  if (justfile) {
    for (const t of COMMON_MAKEFILE_TARGETS) {
      commands.push({ name: `just:${t}`, command: ["just", t] });
    }
    discovered.push(`${justfile} → just test/lint/check/build`);
  }

  const taskfile = TASKFILE_NAMES.find((f) => fileExists(base, f));
  if (taskfile) {
    for (const t of COMMON_MAKEFILE_TARGETS) {
      commands.push({ name: `task:${t}`, command: ["task", t] });
    }
    discovered.push(`${taskfile} → task test/lint/check/build`);
  }

  // --- 3. Language detection ---
  const hasPy = fileExists(base, "pyproject.toml") || fileExists(base, "pytest.ini") || fileExists(base, "setup.py") || fileExists(base, "requirements.txt");
  const hasNode = fileExists(base, "package.json");
  const hasGo = fileExists(base, "go.mod");
  const hasRust = fileExists(base, "Cargo.toml");

  if (hasPy) {
    const pyproject = readYamlish(base, "pyproject.toml");
    const pytestIni = readYamlish(base, "pytest.ini");
    const pyprojectRaw = readTextFile(join(base, "pyproject.toml")) ?? "";
    if (pyprojectRaw.includes("[tool.pytest.ini_options]") || (pytestIni && Object.keys(pytestIni).length)) {
      commands.push({ name: "pytest", command: ["pytest", "-q"] });
      discovered.push("pytest config → pytest -q");
    }
    if (fileExists(base, "ruff.toml") || fileExists(base, ".ruff.toml") || pyprojectRaw.includes("[tool.ruff]")) {
      commands.push({ name: "ruff", command: ["ruff", "check", "."] });
      discovered.push("ruff config → ruff check .");
    }
    if (fileExists(base, "mypy.ini") || fileExists(base, ".mypy.ini") || pyprojectRaw.includes("[tool.mypy]")) {
      commands.push({ name: "mypy", command: ["mypy", "."] });
      discovered.push("mypy config → mypy .");
    }
  }

  if (hasNode) {
    const pkg = readJson(base, "package.json") as { scripts?: Record<string, string> } | null;
    if (pkg?.scripts) {
      const scripts = pkg.scripts;
      const scriptOrder = ["test", "lint", "typecheck", "build"];
      for (const s of scriptOrder) {
        if (typeof scripts[s] === "string" && scripts[s].trim()) {
          commands.push({ name: `npm:${s}`, command: ["npm", "run", s, "--if-present"] });
          discovered.push(`package.json → npm run ${s}`);
        }
      }
      if (!commands.some((c) => c.name === "npm:test")) {
        commands.push({ name: "npm:test", command: ["npm", "test", "--if-present"] });
        discovered.push("package.json → npm test");
      }
    } else {
      commands.push({ name: "npm:test", command: ["npm", "test", "--if-present"] });
      discovered.push("package.json (no scripts) → npm test");
    }
  }

  if (hasGo) {
    commands.push({ name: "go:test", command: ["go", "test", "./..."] });
    discovered.push("go.mod → go test ./...");
  }

  if (hasRust) {
    commands.push({ name: "cargo:test", command: ["cargo", "test"] });
    discovered.push("Cargo.toml → cargo test");
    if (fileExists(base, "clippy.toml")) {
      commands.push({ name: "cargo:clippy", command: ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"] });
      discovered.push("clippy.toml → cargo clippy");
    }
    commands.push({ name: "cargo:build", command: ["cargo", "build"] });
    discovered.push("Cargo.toml → cargo build");
  }

  // --- 4. Fallback: only when nothing else matched, note it ---
  if (commands.length === 0) {
    notes.push("No project validation commands found; skipping gate (nothing authoritative to run).");
  }

  return { commands, discovered, notes };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function runCommand(
  cwd: string,
  argv: string[],
  opts: { timeoutMs?: number; maxOutputChars?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
    }, (err, stdout, stderr) => {
      const durationMs = Date.now() - started;
      let code: number | null = null;
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (typeof e.code === "number") code = e.code;
      } else {
        code = 0;
      }
      resolve({ code, stdout, stderr, durationMs });
    });
  });
}

export function tail(text: string, maxChars = 4000): string {
  const clean = stripAnsi(text);
  if (clean.length <= maxChars) return clean;
  return "…[truncated]…\n" + clean.slice(-maxChars);
}

export async function runGate(
  repoPath: string,
  discovery: GateDiscovery,
  opts: { timeoutMs?: number; onStep?: (step: GateStep) => void } = {},
): Promise<GateResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const steps: GateStep[] = [];
  for (const c of discovery.commands) {
    const started = Date.now();
    const { code, stdout, stderr } = await runCommand(c.cwd ?? repoPath, c.command, { timeoutMs });
    const out = tail((stdout || "") + (stderr || ""), 4000);
    const passed = code === 0;
    const step: GateStep = {
      name: c.name,
      command: c.command.join(" "),
      passed,
      skipped: false,
      exitCode: code,
      outputTail: out,
      durationMs: Date.now() - started,
    };
    steps.push(step);
    opts.onStep?.(step);
    if (!passed) {
      // Stop at first failing gate step; the executor needs the failure.
      return { passed: false, steps };
    }
  }
  const passed = steps.length > 0 && steps.every((s) => s.passed);
  return { passed, steps };
}

export function formatGateResult(result: GateResult): string {
  if (result.steps.length === 0) {
    return "Gate: no validation commands discovered (nothing authoritative to run).";
  }
  const lines = result.steps.map((s) => {
    const status = s.skipped ? "SKIP" : s.passed ? "PASS" : "FAIL";
    return `[${status}] ${s.name} — ${s.command}${s.passed ? "" : ` (exit ${s.exitCode})`}`;
  });
  return lines.join("\n");
}
