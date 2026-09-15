import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Product Manager web-search skill.
 *
 * The PM pane gets one read-only `pm_search` tool backed by the host's
 * configured search API (Tavily/Exa from ~/.pi/web-search.json). This lets the
 * PM do market research ("has this been built before / is there an open-source
 * solution to adapt?") before deciding reuse-vs-build, without ever gaining
 * shell or write access to the repository.
 */
export default function productManagerSearch(pi: ExtensionAPI): void {
  const confPath = join(homedir(), ".pi", "web-search.json");
  let tavilyKey = "";
  let exaKey = "";
  try {
    if (existsSync(confPath)) {
      const conf = JSON.parse(readFileSync(confPath, "utf8")) as Record<string, string>;
      tavilyKey = conf.tavilyApiKey ?? "";
      exaKey = conf.exaApiKey ?? "";
    }
  } catch { /* fall through to no keys */ }

  pi.registerTool({
    name: "pm_search",
    label: "PM Search",
    description:
      "Read-only web search for market research. Query the web for existing open-source projects, prior implementations, or comparable products so you can decide whether to reuse/adapt or build from scratch. Never edits files. Returns short snippets with titles and URLs. Use 1-3 targeted queries.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query, e.g. 'open source AI code review agent' or 'existing npm package for X'" }),
    }),
    async execute(_toolCallId, params: { query: string }, _signal, _onUpdate, _ctx) {
      const query = params.query?.trim();
      if (!query) return { content: [{ type: "text", text: "Error: empty query" }], details: {} };

      // Try Exa first (semantic, returns content snippets), fall back to Tavily.
      if (exaKey) {
        try {
          const res = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": exaKey },
            body: JSON.stringify({ query, numResults: 5, type: "auto", contents: { text: { maxCharacters: 500 } } }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.ok) {
            const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
            const results = (data.results ?? []).slice(0, 5);
            if (results.length) {
              const lines = results.map((r, i) => `${i + 1}. ${r.title ?? "untitled"}\n   ${r.url ?? ""}\n   ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
              return { content: [{ type: "text", text: lines.join("\n\n") || "No results." }], details: { provider: "exa" } };
            }
          }
        } catch { /* fall through to Tavily */ }
      }

      if (tavilyKey) {
        try {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.ok) {
            const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
            const results = (data.results ?? []).slice(0, 5);
            if (results.length) {
              const lines = results.map((r, i) => `${i + 1}. ${r.title ?? "untitled"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
              return { content: [{ type: "text", text: lines.join("\n\n") || "No results." }], details: { provider: "tavily" } };
            }
          }
        } catch { /* no search available */ }
      }

      return {
        content: [{ type: "text", text: "Search unavailable: no search provider configured (pm_search needs Tavily/Exa keys in ~/.pi/web-search.json)." }],
        details: { error: "no_provider" },
      };
    },
  });
}
