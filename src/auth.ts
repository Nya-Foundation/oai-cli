import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/** The Codex CLI's public OAuth client: the only login the image endpoints accept. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const REFRESH_MARGIN_MS = 5 * 60_000;
export const ORIGINATOR = "oai-cli";

const STORE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oai-cli", "auth.json");

interface Credential {
  access: string;
  /** Absent for a copied access token, which cannot be renewed. */
  refresh?: string;
  expires: number;
}

async function load(): Promise<Credential | undefined> {
  try { return JSON.parse(await readFile(STORE, "utf8")) as Credential; }
  catch { return undefined; }
}

async function save(credential: Credential): Promise<void> {
  await mkdir(dirname(STORE), { recursive: true, mode: 0o700 });
  await writeFile(STORE, JSON.stringify(credential), { mode: 0o600 });
}

async function requestToken(params: Record<string, string>): Promise<Credential> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!response.ok) {
    throw new Error(`token request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("token response is missing fields.");
  }
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

/** A usable access token, refreshed when close to expiry. `OAI_ACCESS_TOKEN` bypasses the store. */
export async function accessToken(): Promise<string> {
  if (process.env.OAI_ACCESS_TOKEN) return process.env.OAI_ACCESS_TOKEN;
  const stored = await load();
  if (!stored) throw new Error("not signed in. Run `oai login`.");
  if (stored.expires - Date.now() > REFRESH_MARGIN_MS) return stored.access;
  if (!stored.refresh) throw new Error("the login expired. Run `oai login`.");
  try {
    const fresh = await requestToken({ grant_type: "refresh_token", refresh_token: stored.refresh });
    await save(fresh);
    return fresh.access;
  } catch (error) {
    // Refresh tokens are single-use, so a parallel run may have rotated this one first.
    const other = await load();
    if (other && other.access !== stored.access) return other.access;
    throw new Error(`${error instanceof Error ? error.message : error} Run \`oai login\`.`);
  }
}

function authorizationCode(callback: URL, state: string): string {
  const error = callback.searchParams.get("error");
  if (error) throw new Error(`authorization failed: ${error}`);
  if (callback.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("missing authorization code.");
  return code;
}

/** Browser sign-in with PKCE; the redirect arrives on localhost or is pasted by hand. */
export async function login(): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  }).toString();

  const server = createServer();
  const input = createInterface({ input: process.stdin });
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server.on("request", (request, response) => {
        const callback = new URL(request.url ?? "", REDIRECT_URI);
        if (callback.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
        try {
          resolve(authorizationCode(callback, state));
          response.end("Signed in. You can close this tab.");
        } catch (error) {
          response.writeHead(400).end(error instanceof Error ? error.message : "Invalid callback.");
          if (callback.searchParams.has("error")) reject(error);
        }
      });
      // The port is fixed by the OAuth client and shared with the Codex CLI.
      server.on("error", error => {
        if (process.stdin.isTTY) console.error("Port 1455 is busy; paste the redirect URL instead.");
        else reject(error);
      });
      server.listen(1455, "127.0.0.1");
      input.on("line", line => {
        if (!line.trim()) return;
        try { resolve(authorizationCode(new URL(line.trim()), state)); }
        catch (error) { reject(error); }
      });
      console.error(`Open this URL to sign in:\n\n${url}\n\n`
        + "If the browser cannot reach this machine, paste the final redirect URL here.");
    });
    await save(await requestToken({
      grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI,
    }));
  } finally {
    input.close();
    server.close();
    server.closeAllConnections();
  }
  console.error(`Signed in. Credentials saved to ${STORE}.`);
}

export async function logout(): Promise<void> {
  await rm(STORE, { force: true });
}
