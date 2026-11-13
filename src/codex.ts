import { ORIGINATOR, accessToken } from "./auth.ts";

const BASE_URL = "https://chatgpt.com/backend-api/codex";
const AUTH_CLAIM = "https://api.openai.com/auth";

export function accountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = payload?.[AUTH_CLAIM]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

/** One request to the Codex backend. Throws a one-line message prefixed with `label`. */
export async function post(label: string, path: string, body: unknown, timeoutSeconds: number,
  accept: string): Promise<string> {
  const token = await accessToken();
  const account = accountId(token);
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: accept,
        "OpenAI-Beta": "responses=experimental",
        originator: ORIGINATOR,
        ...(account ? { "chatgpt-account-id": account } : {}),
      },
      body: JSON.stringify(body),
      // A redirect would forward the bearer token to another host.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${label} failed: timed out after ${timeoutSeconds} seconds.`);
    }
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 401) throw new Error(`${label} failed: the login was rejected. Run \`oai login\`.`);
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${text.replace(/\s+/gu, " ").slice(0, 300)}`);
  }
  return text;
}

/**
 * Completed output items of a Responses event stream.
 *
 * Item-done events and the terminal snapshot are reconciled by output index:
 * arrival order is not output order, and the Codex backend can end with an
 * empty snapshot that must not erase what already arrived.
 */
export function finalOutput(stream: string): { output: unknown[]; types: Set<string> } {
  const items = new Map<number, unknown>();
  const types = new Set<string>();
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: { type?: unknown; output_index?: unknown; item?: unknown; response?: { output?: unknown } };
    try { event = JSON.parse(data); } catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    if (typeof event.type === "string") types.add(event.type);
    if (event.type === "response.output_item.done") {
      if (typeof event.output_index === "number" && typeof event.item === "object" && event.item !== null) {
        items.set(event.output_index, event.item);
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      const output = event.response?.output;
      if (Array.isArray(output)) {
        output.forEach((item, index) => {
          if (typeof item === "object" && item !== null) items.set(index, item);
        });
      }
    }
  }
  return { output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item), types };
}
