// =============================================================================
// Dual-Gate Reflex Layer — System-1 backend
//
// S1Backend abstracts "who produces the probability scores" behind one
// interface (borrowed from Bicameral s1-runtime/src/types.ts):
//
//   RuleBackend  → deterministic heuristics (zero cost, zero latency)
//   JevBackend   → the local `jev` CLI (TypeSafe Jev System One, OpenRouter
//                  Decisions API, ~0.5s / ~$0.00002 per call)
//
// The policy `backend` field selects the primary; on Jev timeout/error the
// caller falls back to the rule signals (borrowing Bicameral's degraded-mode
// fallback: System-1 unavailable → deterministic high-risk patterns still
// protect, everything else proceeds on rules).
// =============================================================================

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number };
export type ScoreAnswer = { type: "score"; score: number; confidence?: number; probabilities?: Record<number, number>; legend?: Record<string, string> };
export type S1Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface S1Answers {
  [name: string]: S1Answer;
}

export interface S1Question {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface S1Request {
  state: string;
  questions: Record<string, S1Question>;
}

export interface S1Result {
  answers: S1Answers;
  latencyMs: number;
  /** "jev" | "rule" | "degraded" */
  source: "jev" | "rule" | "degraded";
}

export interface S1Backend {
  readonly name: string;
  decide(req: S1Request, opts: { timeoutMs: number }): Promise<S1Result>;
}

// ---------------------------------------------------------------------------
// JevBackend — local `jev` CLI
// ---------------------------------------------------------------------------

export interface JevBackendOptions {
  /** Path to the jev CLI. Default: ~/.local/bin/jev */
  bin?: string;
  /** Model id passed to jev -m. Default: typesafe/jev-1.13 (CLI default). */
  model?: string;
  /** Override the questions-to-ask mapping for a backend call. */
  questions?: Record<string, S1Question>;
}

/**
 * Invoke the local `jev` CLI once with all questions (it supports multiple
 * questions per call, returning one JSON object). This mirrors Bicameral's
 * TypeSafeBackend (one request, all questions) but over the CLI instead of the
 * SDK — zero new runtime dependencies.
 */
export class JevBackend implements S1Backend {
  readonly name: string;
  private readonly bin: string;
  private readonly model: string | undefined;

  constructor(opts: JevBackendOptions = {}) {
    this.bin = opts.bin ?? join(homedir(), ".local", "bin", "jev");
    this.model = opts.model;
    this.name = `jev:${this.model ?? "typesafe/jev-1.13"}`;
  }

  async decide(req: S1Request, opts: { timeoutMs: number }): Promise<S1Result> {
    const started = Date.now();
    const args = ["--json", req.state];
    if (this.model) args.push("-m", this.model);
    const qJson = JSON.stringify(req.questions);
    args.push("-q", qJson);
    const { stdout, code } = await execFileAsync(this.bin, args, { timeoutMs: opts.timeoutMs });
    if (code !== 0 || !stdout) {
      throw new Error(`jev CLI failed (exit ${code})`);
    }
    let parsed: { answers?: S1Answers } | null = null;
    try {
      parsed = JSON.parse(stdout) as { answers?: S1Answers };
    } catch {
      throw new Error(`jev CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (!parsed || !parsed.answers) throw new Error(`jev CLI returned no answers`);
    return { answers: parsed.answers, latencyMs: Date.now() - started, source: "jev" };
  }
}

function execFileAsync(
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (!existsSync(bin)) {
      reject(new Error(`jev CLI not found at ${bin}`));
      return;
    }
    execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        // Timeouts and spawn errors reject; non-zero exit with stdout still resolves.
        const code = typeof e.code === "number" ? e.code : e.killed ? -1 : null;
        if (stdout) resolve({ stdout, code });
        else reject(new Error(`jev CLI error: ${e.message}`));
        return;
      }
      resolve({ stdout, code: 0 });
    });
  });
}

// ---------------------------------------------------------------------------
// RuleBackend — deterministic heuristics (the v0.1 reflex signals)
// ---------------------------------------------------------------------------

/**
 * Supplies the deterministic signal values as pseudo-answers so the policy
 * layer can consume them uniformly whether or not Jev is used. For example the
 * progress module's quantified comparison produces a `no_progress` signal that
 * a rule backend turns into a noul answer.
 */
export class RuleBackend implements S1Backend {
  readonly name = "rule";
  private readonly signals: Record<string, number>;

  constructor(signals: Record<string, number>) {
    this.signals = signals;
  }

  async decide(req: S1Request): Promise<S1Result> {
    const answers: S1Answers = {};
    for (const [name, q] of Object.entries(req.questions)) {
      if (q.type === "noul") {
        answers[name] = { type: "noul", noul: this.signals[name] ?? 0.5 };
      } else if (q.type === "choice") {
        // Rule backend cannot produce choices; caller should not rely on it.
        answers[name] = { type: "choice", choice: "", probabilities: {} };
      } else {
        answers[name] = { type: "score", score: 0, confidence: 0 };
      }
    }
    return { answers, latencyMs: 0, source: "rule" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function noulOf(a: S1Answers, name: string): number {
  const v = a[name];
  return v && v.type === "noul" ? v.noul : 0;
}

export function choiceOf(a: S1Answers, name: string): string | undefined {
  const v = a[name];
  return v && v.type === "choice" ? v.choice : undefined;
}

export function scoreOf(a: S1Answers, name: string): number {
  const v = a[name];
  return v && v.type === "score" ? v.score : 0;
}

/** Map a rule signal (0..1) to a noul answer shape. */
export function ruleNoul(p: number): NoulAnswer {
  return { type: "noul", noul: p };
}
