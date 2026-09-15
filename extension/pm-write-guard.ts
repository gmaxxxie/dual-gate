import { resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Product Manager panes may persist protocol responses, never project source.
 * This extension is loaded explicitly into the otherwise extension-free PM Pi.
 */
export default function productManagerWriteGuard(pi: ExtensionAPI): void {
  const configuredRoot = process.env.DUAL_GATE_PM_ARTIFACT_DIR;
  const root = configuredRoot ? resolve(configuredRoot) : "";

  pi.on("tool_call", (event) => {
    if (event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    const path = typeof input.path === "string" ? resolve(input.path) : "";
    if (!root || !path || (path !== root && !path.startsWith(root + sep))) {
      return { block: true, reason: "Product Manager may write only inside its assigned artifact directory.", terminate: true };
    }
  });
}
