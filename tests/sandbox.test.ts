// =============================================================================
// Dual-Gate Executor Sandbox — test suite
//
// Pure-logic tests for extension/sandbox.ts (Tier-2 execution isolation) plus
// the sandbox section of the config. No sbx/docker is required: every external
// fact (binary on PATH, file existence, pinned container) is injected.
//
// Run: node --experimental-strip-types tests/sandbox.test.ts
// =============================================================================

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SANDBOX_PACKAGE,
  SANDBOX_CONTAINER_LABEL,
  sandboxExtensionCandidates,
  resolveSandboxExtensionPath,
  hasBinaryOnPath,
  checkSandboxAvailability,
  sanitizeSandboxName,
  sandboxNameFor,
  sandboxContainerNameFor,
  projectGateContainerNameFor,
  dockerRunArgs,
  dockerExecArgs,
  defaultImageForLanguage,
  resolveDockerImage,
  buildSandboxEnv,
  sandboxExecutorArgs,
  sandboxPaneCwd,
  planExecutorSandbox,
  formatSandboxStatus,
} from "../extension/sandbox.ts";
import { detectProjectLanguage } from "../extension/gate.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../extension/core.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// =============================================================================
// Extension resolution
// =============================================================================

function testExtensionCandidates() {
  const withCustom = sandboxExtensionCandidates("/repo", "/custom/sandbox");
  assert.equal(withCustom[0], "/custom/sandbox", "configured path wins");
  assert.equal(withCustom[1], join("/repo", ".pi", "npm", "node_modules", SANDBOX_PACKAGE, "sandbox"));
  assert.equal(withCustom[2], join("/repo", "node_modules", SANDBOX_PACKAGE, "sandbox"));
  assert.ok(
    withCustom[3].endsWith(join(".pi", "agent", "npm", "node_modules", SANDBOX_PACKAGE, "sandbox")),
    "global install is the last fallback",
  );

  const plain = sandboxExtensionCandidates("/repo");
  assert.equal(plain.length, 3, "no configured path → 3 candidates");
  assert.equal(plain[0], join("/repo", ".pi", "npm", "node_modules", SANDBOX_PACKAGE, "sandbox"));
}

function testResolveExtensionPath() {
  const projectPath = join("/repo", ".pi", "npm", "node_modules", SANDBOX_PACKAGE, "sandbox");
  assert.equal(
    resolveSandboxExtensionPath("/repo", "", (p) => p === projectPath),
    projectPath,
  );
  assert.equal(resolveSandboxExtensionPath("/repo", "", () => false), null);

  // A configured path that does not exist must not shadow a real fallback.
  const fallback = join("/repo", ".pi", "npm", "node_modules", SANDBOX_PACKAGE, "sandbox");
  assert.equal(
    resolveSandboxExtensionPath("/repo", "/nope/missing", (p) => p === fallback),
    fallback,
  );
}

// =============================================================================
// Availability
// =============================================================================

function testHasBinaryOnPath() {
  const dir = tmp("dg-path-");
  writeFileSync(join(dir, "faketool"), "");
  assert.equal(hasBinaryOnPath("faketool", dir), true);
  assert.equal(hasBinaryOnPath("nope", dir), false);
  assert.equal(hasBinaryOnPath("faketool", ""), false);
  // Empty PATH segments must not resolve to the process cwd.
  assert.equal(hasBinaryOnPath("faketool", ":/nonexistent:"), false);
}

function testCheckSandboxAvailability() {
  const none = () => false;
  const yes = () => true;

  assert.equal(checkSandboxAvailability("sbx", none, {}).ok, false, "sbx required but missing");
  assert.equal(checkSandboxAvailability("sbx", yes, {}).backend, "sbx");
  assert.equal(checkSandboxAvailability("sbx", yes, {}).ok, true);

  assert.equal(checkSandboxAvailability("docker", none, {}).ok, false, "docker needs a pinned container");
  const docker = checkSandboxAvailability("docker", none, { SBX_DOCKER_CONTAINER: "cont" });
  assert.equal(docker.ok, true);
  assert.equal(docker.backend, "docker");
  assert.ok(docker.detail.includes("cont"));

  assert.equal(checkSandboxAvailability("auto", yes, {}).backend, "sbx", "auto prefers sbx");
  assert.equal(checkSandboxAvailability("auto", none, {}).ok, false, "auto with nothing usable");
  assert.equal(
    checkSandboxAvailability("auto", none, { SBX_DOCKER_CONTAINER: "cont" }).backend,
    "docker",
    "auto falls back to a pinned container",
  );
  // sbx wins over a pinned container when both are available.
  assert.equal(checkSandboxAvailability("auto", yes, { SBX_DOCKER_CONTAINER: "cont" }).backend, "sbx");

  // A docker CLI with no pin means Dual-Gate creates and owns the container.
  const dockerOnly = (b: string) => b === "docker";
  const managed = checkSandboxAvailability("docker", dockerOnly, {});
  assert.equal(managed.ok, true, "docker CLI alone is enough when Dual-Gate manages the container");
  assert.equal(managed.managed, true);
  assert.equal(managed.container, undefined, "no container exists yet — Dual-Gate will create it");

  // auto falls back to a managed container when sbx is missing.
  const autoManaged = checkSandboxAvailability("auto", dockerOnly, {});
  assert.equal(autoManaged.ok, true);
  assert.equal(autoManaged.backend, "docker");
  assert.equal(autoManaged.managed, true);

  // A caller-pinned container always wins over managing one.
  const pinnedWins = checkSandboxAvailability("docker", dockerOnly, { SBX_DOCKER_CONTAINER: "c" });
  assert.equal(pinnedWins.managed, false);
  assert.equal(pinnedWins.container, "c");
}

// =============================================================================
// Naming + env
// =============================================================================

function testNaming() {
  assert.equal(sanitizeSandboxName("task/2026:1 x"), "task-2026-1-x");
  assert.equal(sanitizeSandboxName("--a--b--"), "a-b");
  assert.equal(sanitizeSandboxName(""), "");
  assert.ok(sanitizeSandboxName("x".repeat(200)).length <= 60);

  assert.equal(sandboxNameFor("task-20260914-6985", "task"), "dg-task-20260914-6985");
  assert.equal(sandboxNameFor("task-1", "repo"), undefined, "repo scope lets the extension derive a warm sandbox");
  assert.equal(sandboxNameFor("", "task"), undefined);
  assert.equal(sandboxNameFor("!!!", "task"), undefined);

  assert.equal(sandboxContainerNameFor("task-20260914-6985"), "dg-sbx-task-20260914-6985");
  assert.equal(sandboxContainerNameFor(""), undefined);
  assert.equal(sandboxContainerNameFor("!!!"), undefined);
}

function testDockerRunArgs() {
  const args = dockerRunArgs({ name: "dg-sbx-t1", repoPath: "/repo/wt", image: "debian:stable-slim", taskId: "t1" });
  assert.equal(args[0], "run");
  assert.ok(args.includes("--name") && args.includes("dg-sbx-t1"));
  assert.ok(args.includes(`${SANDBOX_CONTAINER_LABEL}=true`), "containers must be labelled as ours");
  assert.ok(args.includes(`${SANDBOX_CONTAINER_LABEL}.task=t1`), "the owning task must be recorded");
  // The project is mounted at its HOST absolute path — that identity is what
  // pi-docker-sandbox's docker backend relies on.
  assert.ok(args.includes("/repo/wt:/repo/wt"));
  assert.equal(args[args.length - 2], "sleep");
  assert.equal(args[args.length - 1], "infinity");
}

function testBuildSandboxEnv() {
  const task = buildSandboxEnv({ taskId: "t1", scope: "task", backend: "sbx", keepalive: true, hostEnv: {} });
  assert.deepEqual(task, { DOCKER_SANDBOX: "dg-t1", DOCKER_SANDBOX_KEEPALIVE: "1" });

  const repo = buildSandboxEnv({ taskId: "t1", scope: "repo", backend: "sbx", keepalive: false, hostEnv: {} });
  assert.deepEqual(repo, { DOCKER_SANDBOX_KEEPALIVE: "0" }, "repo scope must not pin a name");

  const docker = buildSandboxEnv({
    taskId: "t1",
    scope: "task",
    backend: "docker",
    keepalive: true,
    hostEnv: { SBX_DOCKER_CONTAINER: "abc" },
  });
  assert.equal(docker.SBX_BACKEND, "docker");
  assert.equal(docker.SBX_DOCKER_CONTAINER, "abc");

  const auto = buildSandboxEnv({ taskId: "t1", scope: "task", backend: "auto", keepalive: true, hostEnv: {} });
  assert.equal(auto.SBX_BACKEND, undefined, "auto must not force a backend");
}

function testArgsAndPaneCwd() {
  assert.deepEqual(sandboxExecutorArgs("/x/sandbox"), ["--extension", "/x/sandbox"]);
  assert.equal(sandboxPaneCwd("/repo/wt", "/home/u", true), "/repo/wt", "sandbox mounts the pane cwd");
  assert.equal(sandboxPaneCwd("/repo/wt", "/home/u", false), "/home/u", "no sandbox → historical stable cwd");
}

// =============================================================================
// Plan
// =============================================================================

function testPlanDisabled() {
  const plan = planExecutorSandbox({ repoPath: "/repo", taskId: "t1", config: { ...DEFAULT_CONFIG.sandbox } });
  assert.equal(plan.enabled, false);
  assert.equal(plan.extensionPath, null);
  assert.deepEqual(plan.env, {});
  assert.equal(plan.fatal, undefined);
  assert.equal(plan.warning, undefined);
}

function testPlanFailsOpenByDefault() {
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "sbx" as const };
  const plan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "t1",
    config,
    hasBinary: () => false,
    hostEnv: {},
  });
  assert.equal(plan.enabled, false, "unusable sandbox must not claim to be enabled");
  assert.equal(plan.fatal, undefined);
  assert.ok(plan.warning?.includes("HOST"), "warning must say the Executor runs on the host");
  assert.ok(plan.warning?.includes("sbx"), "warning must name the cause");
}

function testPlanFailsClosedWhenRequired() {
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "sbx" as const, require: true };
  const plan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "t1",
    config,
    hasBinary: () => false,
    hostEnv: {},
  });
  assert.equal(plan.enabled, true);
  assert.ok(plan.fatal?.includes("required"), "require=true must produce a fatal plan");
  assert.equal(plan.warning, undefined);
}

function testPlanHappyPath() {
  const extensionDir = tmp("dg-ext-");
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "sbx" as const, extension_path: extensionDir };
  const plan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "t1",
    config,
    hasBinary: () => true,
    hostEnv: {},
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.extensionPath, extensionDir);
  assert.equal(plan.env.DOCKER_SANDBOX, "dg-t1");
  assert.equal(plan.availability.backend, "sbx");
  assert.equal(plan.warning, undefined);
  assert.equal(plan.fatal, undefined);
}

function testPlanAutoDockerFallbackExportsBackend() {
  const extensionDir = tmp("dg-ext-");
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "auto" as const, extension_path: extensionDir };
  const plan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "t1",
    config,
    hasBinary: () => false,
    hostEnv: { SBX_DOCKER_CONTAINER: "cont1" },
  });
  assert.equal(plan.enabled, true, "auto must fall back to the pinned container");
  assert.equal(plan.availability.backend, "docker");
  // Regression: the resolved backend (not the configured `auto`) must reach the pane.
  assert.equal(plan.env.SBX_BACKEND, "docker");
  assert.equal(plan.env.SBX_DOCKER_CONTAINER, "cont1");
}

function testPlanManagedDockerContainer() {
  const extensionDir = tmp("dg-ext-");
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "docker" as const, extension_path: extensionDir };
  const plan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "task-1",
    config,
    hasBinary: (b) => b === "docker",
    hostEnv: {},
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.managedContainer, true, "Dual-Gate must own the container when none is pinned");
  assert.equal(plan.container, "dg-sbx-task-1", "container name is derived from the task id");
  assert.equal(plan.env.SBX_BACKEND, "docker");
  assert.equal(plan.env.SBX_DOCKER_CONTAINER, "dg-sbx-task-1");
  assert.equal(plan.dockerImage, "debian:stable-slim", "unknown language → generic image");

  // A caller-pinned container wins and is never managed by Dual-Gate.
  const pinned = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "task-1",
    config,
    hasBinary: (b) => b === "docker",
    hostEnv: { SBX_DOCKER_CONTAINER: "mine" },
  });
  assert.equal(pinned.managedContainer, false);
  assert.equal(pinned.container, "mine");
  assert.equal(pinned.env.SBX_DOCKER_CONTAINER, "mine");

  // The detected language picks a toolchain-bearing image so a per-task
  // container does not force re-provisioning (and the gate can run in it).
  const nodePlan = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "task-1",
    config,
    language: "node",
    hasBinary: (b) => b === "docker",
    hostEnv: {},
  });
  assert.equal(nodePlan.dockerImage, "node:22-slim");

  const explicit = planExecutorSandbox({
    repoPath: "/repo",
    taskId: "task-1",
    config: { ...config, docker_image: "custom:1" },
    language: "node",
    hasBinary: (b) => b === "docker",
    hostEnv: {},
  });
  assert.equal(explicit.dockerImage, "custom:1", "explicit image beats language detection");
}

function testDockerExecArgs() {
  const args = dockerExecArgs({ container: "dg-sbx-t1", cwd: "/repo/wt", argv: ["npm", "test"] });
  assert.deepEqual(args, ["exec", "-w", "/repo/wt", "-e", "NO_COLOR=1", "-e", "CI=1", "dg-sbx-t1", "npm", "test"]);
  // argv stays positional: docker exec takes no shell, so a command can never
  // be reinterpreted as shell syntax.
  const hostile = dockerExecArgs({ container: "c", cwd: "/r", argv: ["sh", "-c", "echo $(whoami); rm -rf /"] });
  assert.equal(hostile[hostile.length - 1], "echo $(whoami); rm -rf /", "payload is passed as one opaque argv element");
  assert.equal(hostile[hostile.length - 3], "sh");
}

function testImageSelection() {
  assert.equal(defaultImageForLanguage("node"), "node:22-slim");
  assert.equal(defaultImageForLanguage("python"), "python:3.12-slim");
  assert.equal(defaultImageForLanguage("go"), "golang:1.23-bookworm");
  assert.equal(defaultImageForLanguage("rust"), "rust:1-slim-bookworm");
  assert.equal(defaultImageForLanguage("unknown"), "debian:stable-slim");

  assert.equal(resolveDockerImage("", "node"), "node:22-slim", "empty config → language default");
  assert.equal(resolveDockerImage("   ", "node"), "node:22-slim", "blank config → language default");
  assert.equal(resolveDockerImage("my/img:1", "node"), "my/img:1", "explicit config wins");
}

function testProjectGateContainerName() {
  assert.equal(projectGateContainerNameFor("proj-1"), "dg-sbx-proj-1-final");
  assert.equal(projectGateContainerNameFor(""), undefined);
}

function testDetectProjectLanguage() {
  const node = tmp("dg-lang-");
  writeFileSync(join(node, "package.json"), "{}");
  assert.equal(detectProjectLanguage(node), "node");
  const py = tmp("dg-lang-");
  writeFileSync(join(py, "requirements.txt"), "");
  assert.equal(detectProjectLanguage(py), "python");
  const go = tmp("dg-lang-");
  writeFileSync(join(go, "go.mod"), "module x");
  assert.equal(detectProjectLanguage(go), "go");
  const rs = tmp("dg-lang-");
  writeFileSync(join(rs, "Cargo.toml"), "[package]");
  assert.equal(detectProjectLanguage(rs), "rust");
  assert.equal(detectProjectLanguage(tmp("dg-lang-")), "unknown");
}

function testPlanMissingExtensionIsReported() {
  // Backend is fine, but the execution backend is not installed anywhere.
  const config = { ...DEFAULT_CONFIG.sandbox, enabled: true, backend: "sbx" as const, extension_path: "/definitely/not/here" };
  const plan = planExecutorSandbox({
    repoPath: join(tmp("dg-empty-"), "repo"),
    taskId: "t1",
    config,
    hasBinary: () => true,
    hostEnv: {},
  });
  // On a machine with a global install this may resolve; only assert the
  // contract that matters: either it resolved, or it warned about install.
  if (plan.enabled) {
    assert.ok(plan.extensionPath);
  } else {
    assert.ok(plan.warning?.includes(SANDBOX_PACKAGE));
  }
}

// =============================================================================
// Config + status
// =============================================================================

function testConfigDefaultsAndNormalization() {
  assert.equal(DEFAULT_CONFIG.sandbox.enabled, false, "sandbox is OFF by default");
  assert.equal(DEFAULT_CONFIG.sandbox.backend, "auto");
  assert.equal(DEFAULT_CONFIG.sandbox.scope, "task");
  assert.equal(DEFAULT_CONFIG.sandbox.keepalive, true);
  assert.equal(DEFAULT_CONFIG.sandbox.require, false);
  assert.equal(DEFAULT_CONFIG.sandbox.extension_path, "");
  assert.equal(DEFAULT_CONFIG.sandbox.docker_image, "", "empty = auto-detect the image from the project language");

  assert.deepEqual(normalizeConfig(null).sandbox, DEFAULT_CONFIG.sandbox, "null config keeps defaults");

  const n = normalizeConfig({
    sandbox: { enabled: true, backend: "docker", scope: "repo", keepalive: false, require: true, extension_path: "  /x/sandbox  " },
  });
  assert.equal(n.sandbox.enabled, true);
  assert.equal(n.sandbox.backend, "docker");
  assert.equal(n.sandbox.scope, "repo");
  assert.equal(n.sandbox.keepalive, false);
  assert.equal(n.sandbox.require, true);
  assert.equal(n.sandbox.extension_path, "/x/sandbox", "extension_path is trimmed");

  const img = normalizeConfig({ sandbox: { docker_image: "  node:22-slim  " } });
  assert.equal(img.sandbox.docker_image, "node:22-slim", "docker_image is trimmed");
  assert.equal(
    normalizeConfig({ sandbox: { docker_image: "   " } }).sandbox.docker_image,
    "",
    "blank image stays empty (auto-detect)",
  );

  // Gate execution target (Tier-1).
  assert.equal(DEFAULT_CONFIG.gate.execution, "auto");
  assert.equal(normalizeConfig({ gate: { execution: "sandbox" } }).gate.execution, "sandbox");
  assert.equal(normalizeConfig({ gate: { execution: "bogus" } as never }).gate.execution, "auto", "invalid execution falls back to auto");

  const bad = normalizeConfig({ sandbox: { backend: "bogus", scope: "bogus", enabled: "yes" } as never });
  assert.equal(bad.sandbox.backend, "auto", "invalid backend falls back to auto");
  assert.equal(bad.sandbox.scope, "task", "invalid scope falls back to task");
  assert.equal(bad.sandbox.enabled, false, "non-boolean enabled is ignored");
}

function testFormatStatus() {
  const text = formatSandboxStatus({
    config: { ...DEFAULT_CONFIG.sandbox },
    repoPath: "/repo",
    hasBinary: () => false,
    hostEnv: {},
  }).join("\n");
  assert.ok(text.includes("Executor Sandbox"));
  assert.ok(text.includes("enabled:   false"));
  assert.ok(text.includes("UNAVAILABLE"));
  assert.ok(text.includes("/dual sandbox on|off"));
}

// =============================================================================
// Runner
// =============================================================================

const tests: Array<[string, () => void]> = [
  ["extension candidates", testExtensionCandidates],
  ["resolve extension path", testResolveExtensionPath],
  ["hasBinaryOnPath", testHasBinaryOnPath],
  ["checkSandboxAvailability", testCheckSandboxAvailability],
  ["naming", testNaming],
  ["docker run args", testDockerRunArgs],
  ["docker exec args", testDockerExecArgs],
  ["image selection", testImageSelection],
  ["project gate container name", testProjectGateContainerName],
  ["detect project language", testDetectProjectLanguage],
  ["buildSandboxEnv", testBuildSandboxEnv],
  ["executor args + pane cwd", testArgsAndPaneCwd],
  ["plan disabled", testPlanDisabled],
  ["plan fails open", testPlanFailsOpenByDefault],
  ["plan fails closed when required", testPlanFailsClosedWhenRequired],
  ["plan happy path", testPlanHappyPath],
  ["plan auto→docker exports backend", testPlanAutoDockerFallbackExportsBackend],
  ["plan managed docker container", testPlanManagedDockerContainer],
  ["plan missing extension", testPlanMissingExtensionIsReported],
  ["config defaults/normalization", testConfigDefaultsAndNormalization],
  ["format status", testFormatStatus],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(e instanceof Error ? `    ${e.message}` : e);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures === 0 ? 0 : 1);
