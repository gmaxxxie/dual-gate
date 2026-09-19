// =============================================================================
// Dual-Gate Orchestrator — Executor sandbox (Docker Sandbox / sbx)
//
// Tier-2 execution isolation. The Executor pane's `pi` process still runs on
// the HOST (its own auth, config, model keys), but its built-in tools
// (bash/read/write/edit/grep/find/ls) execute inside a disposable Docker
// Sandbox microVM, via pi-docker-sandbox's `sandbox/` execution backend.
//
// Dual-Gate owns POLICY only: whether to sandbox, which backend, the sandbox
// name (per-task isolation vs per-repo warm reuse), and the preflight. The
// sandbox runtime itself belongs to pi-docker-sandbox — this module never
// talks to `sbx`/`docker` directly, and never parses their output.
//
// Workspace mounting: the sandbox backend mounts the Executor's cwd at its
// host absolute path, so the pane MUST start in the task's worktree/repo for
// the mount to be correct. spawnExecutor() therefore splits the pane at the
// task cwd when the sandbox is enabled (see sandboxPaneCwd).
// =============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig, ProjectLanguage } from "./types.ts";

export const SANDBOX_PACKAGE = "@stixxert/pi-docker-sandbox";
export const SANDBOX_EXTENSION_SUBDIR = "sandbox";

// ---------------------------------------------------------------------------
// Extension resolution
// ---------------------------------------------------------------------------

/**
 * Candidate locations of the sandbox execution-backend entry, in priority
 * order. Project-scoped install wins (the recommended layout), then a plain
 * project node_modules, then the global user install as a fallback.
 */
export function sandboxExtensionCandidates(repoPath: string, configured?: string): string[] {
  const out: string[] = [];
  if (configured && configured.trim()) out.push(configured.trim());
  out.push(join(repoPath, ".pi", "npm", "node_modules", SANDBOX_PACKAGE, SANDBOX_EXTENSION_SUBDIR));
  out.push(join(repoPath, "node_modules", SANDBOX_PACKAGE, SANDBOX_EXTENSION_SUBDIR));
  out.push(join(homedir(), ".pi", "agent", "npm", "node_modules", SANDBOX_PACKAGE, SANDBOX_EXTENSION_SUBDIR));
  return out;
}

/** First existing candidate, or null when the backend is not installed. */
export function resolveSandboxExtensionPath(
  repoPath: string,
  configured?: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const candidate of sandboxExtensionCandidates(repoPath, configured)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** PATH lookup without spawning a process (pure, testable). */
export function hasBinaryOnPath(bin: string, pathEnv: string = process.env.PATH ?? ""): boolean {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    try {
      if (existsSync(join(dir, bin))) return true;
    } catch {
      /* ignore unreadable PATH entries */
    }
  }
  return false;
}

export interface SandboxAvailability {
  ok: boolean;
  backend: "sbx" | "docker";
  detail: string;
  /** docker backend: true when Dual-Gate must create and own the container. */
  managed?: boolean;
  /** docker backend: the container to exec into (pinned or Dual-Gate-created). */
  container?: string;
}

/**
 * Decide whether the requested backend can actually run.
 *
 * `auto` prefers the sbx microVM (real isolation, own kernel) and falls back
 * to docker otherwise. For docker, a container pinned via
 * `SBX_DOCKER_CONTAINER` always wins (the caller owns it); without a pin,
 * Dual-Gate creates and owns a per-task container, which only needs a working
 * docker CLI.
 */
export function checkSandboxAvailability(
  backend: SandboxConfig["backend"],
  hasBinary: (bin: string) => boolean = (b) => hasBinaryOnPath(b),
  hostEnv: NodeJS.ProcessEnv = process.env,
): SandboxAvailability {
  const pinned = hostEnv.SBX_DOCKER_CONTAINER;

  if (backend === "docker") {
    if (pinned) {
      return { ok: true, backend: "docker", detail: `docker backend → caller-pinned container ${pinned}`, managed: false, container: pinned };
    }
    if (hasBinary("docker")) {
      return { ok: true, backend: "docker", detail: "docker backend → Dual-Gate creates a per-task container", managed: true };
    }
    return { ok: false, backend: "docker", detail: "backend=docker needs either SBX_DOCKER_CONTAINER or a usable docker CLI" };
  }
  if (hasBinary("sbx")) {
    return { ok: true, backend: "sbx", detail: "sbx CLI found on PATH" };
  }
  if (backend === "sbx") {
    return { ok: false, backend: "sbx", detail: "backend=sbx but the sbx CLI is not on PATH" };
  }
  // auto: sbx preferred, then docker (pinned container, else Dual-Gate-managed).
  if (pinned) {
    return { ok: true, backend: "docker", detail: `sbx CLI missing — falling back to pinned container ${pinned}`, managed: false, container: pinned };
  }
  if (hasBinary("docker")) {
    return { ok: true, backend: "docker", detail: "sbx CLI missing — falling back to a Dual-Gate-managed docker container", managed: true };
  }
  return { ok: false, backend: "sbx", detail: "neither the sbx CLI nor docker is on PATH" };
}

// ---------------------------------------------------------------------------
// Naming + environment
// ---------------------------------------------------------------------------

/** sbx/docker sandbox names allow a conservative character set. */
export function sanitizeSandboxName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._+-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Sandbox name for a task.
 *
 * `task` scope pins one sandbox per task: it matches Dual-Gate's "one task =
 * one session" principle, keeps Task A's pulled images/containers from
 * leaking into Task B, and — critically for parallel milestones — guarantees
 * two worktrees never share one sandbox mount. `repo` scope returns
 * undefined, letting pi-docker-sandbox derive a warm, per-project sandbox
 * that is reused across runs (cheaper, but shared).
 */
export function sandboxNameFor(taskId: string, scope: SandboxConfig["scope"]): string | undefined {
  if (scope === "repo") return undefined;
  const safe = sanitizeSandboxName(taskId);
  return safe ? `dg-${safe}` : undefined;
}

/**
 * Name of the docker container Dual-Gate creates for a task. One container per
 * task, so parallel milestones in different worktrees never share a mount.
 */
export function sandboxContainerNameFor(taskId: string): string | undefined {
  const safe = sanitizeSandboxName(taskId);
  return safe ? `dg-sbx-${safe}` : undefined;
}

/** Label marking containers Dual-Gate owns, so cleanup never touches others. */
export const SANDBOX_CONTAINER_LABEL = "com.dual-gate.sandbox";

/**
 * `docker run` argv for a per-task sandbox container. The project is mounted
 * at its HOST absolute path, which is what pi-docker-sandbox's docker backend
 * relies on (paths are identical on both sides).
 */
export function dockerRunArgs(opts: { name: string; repoPath: string; image: string; taskId: string }): string[] {
  return [
    "run", "-d",
    "--name", opts.name,
    "--label", `${SANDBOX_CONTAINER_LABEL}=true`,
    "--label", `${SANDBOX_CONTAINER_LABEL}.task=${opts.taskId}`,
    "-v", `${opts.repoPath}:${opts.repoPath}`,
    "-w", opts.repoPath,
    opts.image,
    "sleep", "infinity",
  ];
}

/**
 * `docker exec` argv that runs a gate command inside the sandbox container.
 *
 * argv is passed as positional arguments to docker (no shell), so a command
 * can never be reinterpreted as shell syntax. `-w` puts the command in the
 * task's worktree/repo, which the container mounts at its host absolute path.
 */
export function dockerExecArgs(opts: { container: string; cwd: string; argv: string[] }): string[] {
  return [
    "exec",
    "-w", opts.cwd,
    "-e", "NO_COLOR=1",
    "-e", "CI=1",
    opts.container,
    ...opts.argv,
  ];
}

/**
 * Images that already carry a project's toolchain. A per-task container is
 * thrown away when the task ends, so a bare image would force the Executor to
 * re-provision the toolchain on every task — and would make the gate fail.
 */
export function defaultImageForLanguage(lang: ProjectLanguage): string {
  switch (lang) {
    case "node": return "node:22-slim";
    case "python": return "python:3.12-slim";
    case "go": return "golang:1.23-bookworm";
    case "rust": return "rust:1-slim-bookworm";
    default: return "debian:stable-slim";
  }
}

/** Explicit config wins; otherwise pick an image from the detected language. */
export function resolveDockerImage(configured: string, lang: ProjectLanguage): string {
  const explicit = (configured ?? "").trim();
  return explicit || defaultImageForLanguage(lang);
}

/** Container Dual-Gate creates for a project's final gate. */
export function projectGateContainerNameFor(projectId: string): string | undefined {
  const safe = sanitizeSandboxName(projectId);
  return safe ? `dg-sbx-${safe}-final` : undefined;
}

/** Env handed to the Executor pane (via `herdr pane split --env`). */
export function buildSandboxEnv(opts: {
  taskId: string;
  scope: SandboxConfig["scope"];
  backend: SandboxConfig["backend"];
  keepalive: boolean;
  /** Resolved container (pinned or Dual-Gate-managed); docker backend only. */
  container?: string;
  hostEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const hostEnv = opts.hostEnv ?? process.env;
  const env: Record<string, string> = {
    DOCKER_SANDBOX_KEEPALIVE: opts.keepalive ? "1" : "0",
  };
  const name = sandboxNameFor(opts.taskId, opts.scope);
  if (name) env.DOCKER_SANDBOX = name;
  if (opts.backend === "docker") {
    env.SBX_BACKEND = "docker";
    const container = opts.container ?? hostEnv.SBX_DOCKER_CONTAINER;
    if (container) env.SBX_DOCKER_CONTAINER = container;
  }
  return env;
}

/** Extra `pi` args that load the sandbox execution backend in the pane. */
export function sandboxExecutorArgs(extensionPath: string): string[] {
  return ["--extension", extensionPath];
}

/**
 * Where the Executor pane must start.
 *
 * The sandbox mounts the pane process's cwd, so when the sandbox is on the
 * pane starts in the task's worktree/repo. When it is off we keep the
 * historical stable non-repository cwd (`$HOME`) — no behaviour change for
 * existing users.
 */
export function sandboxPaneCwd(taskCwd: string, stableCwd: string, sandboxEnabled: boolean): string {
  return sandboxEnabled ? taskCwd : stableCwd;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface SandboxPlan {
  /** True only when the sandbox will actually be used. */
  enabled: boolean;
  extensionPath: string | null;
  env: Record<string, string>;
  availability: SandboxAvailability;
  /** docker backend: true when Dual-Gate must create and own the container. */
  managedContainer: boolean;
  /** docker backend: container to exec into (pinned, or to be created). */
  container?: string;
  /** Image used when Dual-Gate creates the container. */
  dockerImage: string;
  /** Sandbox wanted but unusable → Executor runs on the HOST (fail-open). */
  warning?: string;
  /** `require` was set and the sandbox is unusable → caller must not spawn. */
  fatal?: string;
}

/**
 * Resolve everything the spawn path needs, with no side effects.
 *
 * Fail-open by default: pi-docker-sandbox itself degrades to local execution
 * and tells the model so, and a task that cannot be sandboxed is still worth
 * running. Set `sandbox.require = true` to fail closed instead.
 */
export function planExecutorSandbox(opts: {
  repoPath: string;
  taskId: string;
  config: SandboxConfig;
  /** Detected project language, used to pick a toolchain-bearing image. */
  language?: ProjectLanguage;
  hasBinary?: (bin: string) => boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): SandboxPlan {
  const cfg = opts.config;
  const hasBinary = opts.hasBinary ?? ((b: string) => hasBinaryOnPath(b));
  const hostEnv = opts.hostEnv ?? process.env;
  const base = { managedContainer: false, dockerImage: resolveDockerImage(cfg.docker_image, opts.language ?? "unknown") };

  if (!cfg.enabled) {
    return {
      ...base,
      enabled: false,
      extensionPath: null,
      env: {},
      availability: { ok: false, backend: "sbx", detail: "sandbox disabled" },
    };
  }

  const extensionPath = resolveSandboxExtensionPath(opts.repoPath, cfg.extension_path);
  const availability = checkSandboxAvailability(cfg.backend, hasBinary, hostEnv);
  // When Dual-Gate owns the container, the name is deterministic per task, so
  // recovery and cleanup can find it without any persisted state.
  const managedContainer = availability.ok && availability.backend === "docker" && availability.managed === true;
  const container = managedContainer ? sandboxContainerNameFor(opts.taskId) : availability.container;
  const env = buildSandboxEnv({
    taskId: opts.taskId,
    scope: cfg.scope,
    // Use the RESOLVED backend, not the configured one: `auto` with a docker
    // fallback must actually export SBX_BACKEND=docker, otherwise the pane
    // would still try sbx and silently degrade.
    backend: availability.ok ? availability.backend : cfg.backend,
    keepalive: cfg.keepalive,
    container,
    hostEnv,
  });

  const problems: string[] = [];
  if (!extensionPath) {
    problems.push(`pi-docker-sandbox execution backend not found (install: pi install -l npm:${SANDBOX_PACKAGE})`);
  }
  if (!availability.ok) problems.push(availability.detail);
  if (managedContainer && !container) problems.push("could not derive a container name from the task id");

  if (problems.length > 0) {
    const detail = problems.join("; ");
    if (cfg.require) {
      return { ...base, enabled: true, extensionPath, env, availability, fatal: `sandbox required but unusable — ${detail}` };
    }
    return {
      ...base,
      enabled: false,
      extensionPath,
      env,
      availability,
      warning: `sandbox unavailable — Executor will run on the HOST: ${detail}`,
    };
  }

  return { ...base, managedContainer, container, enabled: true, extensionPath, env, availability };
}

/** Human-readable status block for `/dual sandbox`. */
export function formatSandboxStatus(opts: {
  config: SandboxConfig;
  repoPath: string;
  /** gate.execution, shown alongside the sandbox so the whole tier is visible. */
  gateExecution?: string;
  hasBinary?: (bin: string) => boolean;
  hostEnv?: NodeJS.ProcessEnv;
}): string[] {
  const cfg = opts.config;
  const hasBinary = opts.hasBinary ?? ((b: string) => hasBinaryOnPath(b));
  const hostEnv = opts.hostEnv ?? process.env;
  const availability = checkSandboxAvailability(cfg.backend, hasBinary, hostEnv);
  const resolved = resolveSandboxExtensionPath(opts.repoPath, cfg.extension_path);

  return [
    "Dual-Gate Executor Sandbox (Docker Sandbox / sbx)",
    `  enabled:   ${cfg.enabled}`,
    `  backend:   ${cfg.backend} → ${availability.backend}${availability.ok ? "" : " (UNAVAILABLE)"}`,
    `  scope:     ${cfg.scope}${cfg.scope === "task" ? " (one sandbox per task — isolated)" : " (per-repo, warm reuse — shared)"}`,
    `  keepalive: ${cfg.keepalive}`,
    `  require:   ${cfg.require}${cfg.require ? " (fail closed when unusable)" : " (fail open → host)"}`,
    `  container: ${availability.managed ? `Dual-Gate-managed (image ${cfg.docker_image || "auto by language"})` : (availability.container ?? "—")}`,
    ...(opts.gateExecution ? [`  gate runs: ${opts.gateExecution}${opts.gateExecution === "auto" ? " (in the Executor's container when it has one)" : ""}`] : []),
    `  backend path: ${resolved ?? "NOT FOUND (pi install -l npm:" + SANDBOX_PACKAGE + ")"}`,
    `  availability: ${availability.detail}`,
    "",
    "  /dual sandbox on|off             enable/disable",
    "  /dual sandbox backend <auto|sbx|docker>",
    "  /dual sandbox scope <task|repo>",
    "  /dual sandbox require <on|off>",
    "  /dual sandbox gate <auto|host|sandbox>",
  ];
}
