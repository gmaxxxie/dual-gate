// =============================================================================
// Dual-Gate Entry Triage — Jev decides inline vs pipeline BEFORE orchestration.
//
// The input handler used to send every non-command prompt into the full
// pipeline (pane + Executor + Gate + Judge). This module adds a ~0.5s / ~$0.00002
// classification step so chat / quick questions stay on normal Pi while real
// implementation tasks still enter Dual-Gate.
//
// Modes (mirrors reflex: observe first, enforce later):
//   off     → never called; input handler keeps legacy behavior
//   observe → decide + log, always fall through to the pipeline (no behavior change)
//   enforce → inline (confident) returns to normal Pi; everything else pipelines
//
// Fail-closed: any Jev error/timeout holds the legacy behavior (pipeline).
// The confidence gate (default 0.5) holds uncertain lanes at pipeline too —
// misrouting a real task to inline costs quality; over-routing costs tokens.
// =============================================================================

import { appendFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JevBackend, type S1Answers } from "./reflex/backend.ts";

export type TriageLane = "inline" | "pipeline" | "project";

export interface TriageConfig {
	mode: "off" | "observe" | "enforce";
	gate: number;
	excerpt_chars: number;
	timeout_ms: number;
	/** Only intercept interactive TUI input. Keeps `pi -p` scripts, RPC/SDK
	 *  automation and nested pi instances out of the pipeline (default: true). */
	interactive_only: boolean;
}

export interface TriageDecision {
	lane: TriageLane;
	confidence: number;
	/** true when the gate forced a hold to the pipeline lane */
	hold: boolean;
	probabilities: Record<string, number>;
	latencyMs: number;
}

export const TRIAGE_LOG_FILE = join(homedir(), ".pi", "agent", "dual-gate-triage.jsonl");

const TRIAGE_QUESTIONS = {
	lane: {
		type: "choice" as const,
		instructions:
			"Entry triage for an orchestration gate. Decide how this user request should be handled.",
		criteria: {
			inline:
				"Chat, questions, explanations, quick lookups, or a trivial one-line edit — the main assistant answers directly; no plan/execute/verify loop is needed",
			pipeline:
				"A real implementation task — multi-step code change, debugging, refactor, or feature work that benefits from plan → execute → verify with a deterministic gate",
			project:
				"A multi-milestone program — several coordinated deliverables that need a WBS and phased execution",
		},
	},
};

/** One shared backend; the jev CLI is a stable local binary. */
let backend: JevBackend | null = null;
function getBackend(): JevBackend {
	if (!backend) backend = new JevBackend();
	return backend;
}

export async function runTriage(text: string, cfg: TriageConfig): Promise<TriageDecision> {
	const state = text.slice(0, cfg.excerpt_chars);
	const { answers, latencyMs } = await getBackend().decide(
		{ state, questions: TRIAGE_QUESTIONS },
		{ timeoutMs: cfg.timeout_ms },
	);
	return decideLane(answers, latencyMs, cfg);
}

export function decideLane(answers: S1Answers, latencyMs: number, cfg: TriageConfig): TriageDecision {
	const a = answers.lane;
	const choice = a && a.type === "choice" ? a.choice : "";
	const confidence = a && a.type === "choice" ? (a.confidence ?? 0) : 0;
	const probabilities = a && a.type === "choice" ? a.probabilities : {};

	let lane: TriageLane = choice === "inline" || choice === "project" ? choice : "pipeline";
	// Gate: uncertain → hold at pipeline (fail toward the heavyweight path,
	// which is exactly the pre-triage behavior; never a quality regression).
	const hold = lane !== "pipeline" && confidence < cfg.gate;
	if (hold) lane = "pipeline";
	return { lane, confidence, hold, probabilities, latencyMs };
}

export function logTriage(entry: Record<string, unknown>): void {
	try {
		appendFile(TRIAGE_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", () => {});
	} catch {
		/* never break the input flow on log errors */
	}
}
