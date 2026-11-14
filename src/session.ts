import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { post, upload } from "./codex.ts";
import { checkRequest, collectImages, readReference, savePng, type ImageRequest } from "./image.ts";

const DIRECTORY = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oai-cli", "sessions");
const INSTRUCTIONS = "You make images with the image generation tool. Produce exactly the images the user asks for,"
  + " one tool call per image. Keep characters, style and details identical to the earlier images in this"
  + " conversation unless told to change them. Reply with at most one short sentence.";

type Part = { type: "input_text" | "output_text"; text: string } | { type: "input_image"; file_id: string };
interface Message { role: "user" | "assistant"; content: Part[] }

/** Messages of the request's own answer, as text. */
function reply(stream: string): string {
  return [...stream.matchAll(/^data: (\{"type":"response\.output_text\.done".*)$/gmu)]
    .map(match => (JSON.parse(match[1]!) as { text?: string }).text?.trim()).filter(Boolean).join(" ");
}

/** `out` for one image, `out-1`, `out-2`, ... for several; never an existing file, as the images are already paid for. */
export function outputPaths(out: string, count: number, taken: (path: string) => boolean = existsSync): string[] {
  const stem = out.replace(/\.png$/iu, "");
  const paths: string[] = [];
  for (let index = 1; paths.length < count; index++) {
    const path = count === 1 && index === 1 ? out : `${stem}-${index}.png`;
    if (!taken(path)) paths.push(path);
  }
  return paths;
}

/**
 * One turn of a named conversation in which the model sees every earlier image.
 *
 * The backend stores nothing, so the transcript lives in a local file and is sent
 * again each turn. Images are cited by uploaded file id, which keeps it small.
 */
export async function sessionImage(name: string, model: string, request: ImageRequest): Promise<string> {
  if (!/^[\w.-]+$/u.test(name)) throw new Error("image failed: a session name uses letters, digits, dot, dash or underscore.");
  checkRequest(request.out, request.from);
  const file = join(DIRECTORY, `${name}.json`);
  const history = await readFile(file, "utf8").then(text => JSON.parse(text) as Message[], () => []);

  const turn: Message = { role: "user", content: [{ type: "input_text", text: request.prompt }] };
  for (const path of request.from) {
    const { bytes } = await readReference(path);
    turn.content.push({ type: "input_image", file_id: await upload("image", basename(path), bytes, request.timeoutSeconds) });
  }
  const stream = await post("image", "/codex/responses", {
    model,
    instructions: INSTRUCTIONS,
    input: [...history, turn],
    tools: [{ type: "image_generation", ...(request.transparent ? { background: "transparent" } : {}) }],
    store: false,
    stream: true,
  }, request.timeoutSeconds, "text/event-stream");
  const images = collectImages(stream);
  const text = reply(stream);
  if (!images.length) throw new Error(`image failed: the model made no image.${text ? ` It said: ${text}` : ""}`);

  const paths = outputPaths(request.out, images.length);
  const lines: string[] = [];
  const made: Message = { role: "user", content: [{ type: "input_text", text: `The images you just made, in order: ${paths.map(path => basename(path)).join(", ")}.` }] };
  for (const [index, data] of images.entries()) {
    const saved = await savePng(paths[index]!, data);
    lines.push(saved.line);
    made.content.push({ type: "input_image", file_id: await upload("image", basename(paths[index]!), saved.bytes, request.timeoutSeconds) });
  }
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify([...history, turn,
    { role: "assistant", content: [{ type: "output_text", text: text || "Done." }] }, made]), { mode: 0o600 });
  return [...lines, ...(text ? [text] : [])].join("\n");
}
