import { finalOutput, post } from "./codex.ts";

export const DEFAULT_WEB_MODEL = "gpt-6.1-sol";
const MAX_SOURCES = 8;

export interface Found { answer: string; sources: string[]; searched: boolean }

function body(query: string, model: string): unknown {
  return {
    model,
    instructions: "Search the web and answer with current facts. Be brief and concrete."
      + " Prefer primary sources, including official documentation and release notes."
      + " State the version or date a fact depends on. Say so when sources disagree.",
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    tool_choice: "required",
    parallel_tool_calls: true,
    store: false,
    stream: true,
  };
}

/** The answer text and its sources: URLs the answer cites first, then pages the search consulted. */
export function collect(stream: string): Found {
  const { output, types } = finalOutput(stream);
  let searched = [...types].some(type => type.startsWith("response.web_search_call"));
  const answer: string[] = [];
  const cited: string[] = [];
  const consulted: string[] = [];
  const add = (list: string[], value: unknown) => {
    // The tracking suffix otherwise lists a cited page twice.
    if (typeof value === "string" && /^https?:\/\//u.test(value)) list.push(value.replace(/[?&]utm_source=openai$/u, ""));
  };
  for (const item of output as Array<{ type?: unknown; content?: unknown; action?: { sources?: unknown } }>) {
    if (item.type === "web_search_call") {
      searched = true;
      const sources = item.action?.sources;
      if (Array.isArray(sources)) {
        for (const source of sources) add(consulted, typeof source === "string" ? source : source?.url);
      }
    } else if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Array<{ text?: unknown; annotations?: unknown }>) {
        if (typeof part?.text === "string" && part.text.trim()) answer.push(part.text.trim());
        if (Array.isArray(part?.annotations)) for (const note of part.annotations) add(cited, note?.url);
      }
    }
  }
  return {
    answer: answer.join("\n").trim(),
    sources: [...new Set([...cited, ...consulted])].slice(0, MAX_SOURCES),
    searched,
  };
}

export function render(found: Found): string {
  const lines = [found.answer || "The search returned no answer."];
  if (found.sources.length) lines.push("", "Sources:", ...found.sources.map(source => `  ${source}`));
  return lines.join("\n");
}

export async function searchWeb(query: string, model: string, timeoutSeconds: number): Promise<Found> {
  const found = collect(await post("web search", "/codex/responses", body(query, model), timeoutSeconds,
    "text/event-stream"));
  if (!found.searched && !found.answer) throw new Error("web search failed: the provider ran no search.");
  return found;
}
