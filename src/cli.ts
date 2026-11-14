#!/usr/bin/env node
import { text as readAll } from "node:stream/consumers";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { login, logout } from "./auth.ts";
import { IMAGE_HELP, generateImage } from "./image.ts";
import { sessionImage } from "./session.ts";
import { DEFAULT_WEB_MODEL, render, searchWeb } from "./web.ts";

const BANNER = `
 ██████╗  █████╗ ██╗
██╔═══██╗██╔══██╗██║
██║   ██║███████║██║
██║   ██║██╔══██║██║
╚██████╔╝██║  ██║██║
 ╚═════╝ ╚═╝  ╚═╝╚═╝  web search and image generation, v${manifest.version}
`;

const USAGE = `oai <command> [options]

  web <query>       one web search, answered with its sources
      --model M     search model (default ${DEFAULT_WEB_MODEL})
      --json        print {answer, sources} as JSON
      --timeout S   total request limit in seconds (default 300)

  image <prompt>    generate a PNG, or edit from reference images; ask for aspect ratio in the prompt
      --out PATH    new .png path (default oai-<timestamp>.png); never overwrites
      --from PATH   reference image, up to 5; the prompt names them Image 1, Image 2, ...
      --session N   continue conversation N: the model sees its earlier images, for consistent
                    characters; it rewrites the prompt and can return several images
      --transparent transparent background
      --timeout S   total request limit in seconds (default 300)
      --help        usage, sessions and prompting guide; read it before writing a prompt

  login             sign in with a ChatGPT subscription
  logout            delete the saved login

  -v, --version     print the version

The query or prompt is read from stdin when no argument is given.
OAI_ACCESS_TOKEN overrides the saved login.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      model: { type: "string", short: "m" },
      timeout: { type: "string", short: "t", default: "300" },
      out: { type: "string", short: "o" },
      from: { type: "string", short: "f", multiple: true, default: [] },
      session: { type: "string" },
      transparent: { type: "boolean", default: false },
    },
  });
  const [command, ...words] = positionals;
  if (values.version) { console.log(manifest.version); return; }
  if (values.help || !command) {
    // Piped help stays plain for scripts and agents.
    if (process.stdout.isTTY && command !== "image") console.log(BANNER);
    console.log(command === "image" ? IMAGE_HELP : USAGE);
    return;
  }
  if (command === "login") return login();
  if (command === "logout") return logout();
  if (command !== "web" && command !== "image") throw new Error(`unknown command "${command}". See oai --help.`);

  const timeoutSeconds = Number(values.timeout);
  if (!(timeoutSeconds > 0)) throw new Error("--timeout needs a positive number of seconds.");
  const text = (words.length || process.stdin.isTTY ? words.join(" ") : await readAll(process.stdin)).trim();
  if (!text) throw new Error(`${command} needs a ${command === "web" ? "query" : "prompt"}.`);

  if (command === "web") {
    const found = await searchWeb(text, values.model ?? DEFAULT_WEB_MODEL, timeoutSeconds);
    console.log(values.json ? JSON.stringify({ answer: found.answer, sources: found.sources }) : render(found));
    return;
  }
  const stamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
  const request = {
    prompt: text,
    out: values.out ?? `oai-${stamp}.png`,
    from: values.from,
    transparent: values.transparent,
    timeoutSeconds,
  };
  console.log(values.session === undefined ? await generateImage(request)
    : await sessionImage(values.session, values.model ?? DEFAULT_WEB_MODEL, request));
}

try {
  await main();
} catch (error) {
  console.error(`oai: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
