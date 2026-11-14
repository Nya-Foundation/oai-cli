import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { finalOutput, post } from "./codex.ts";

/** The endpoint picks size and quality itself: it ignores `size`, `quality` and other models. */
const MODEL = "gpt-image-2";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export const MAX_REFERENCES = 5;

export const IMAGE_HELP = `oai image <prompt> [--out PATH] [--from PATH ...] [--session NAME] [--transparent] [--timeout S]

Writes one PNG and reports its real dimensions. --out must be a new .png path
(default oai-<timestamp>.png); missing parents are created, nothing is overwritten.
The prompt is sent unchanged. Pipe it on stdin when it spans several lines.
--transparent asks for a transparent background.

References
Repeat --from for up to ${MAX_REFERENCES} reference images (${Object.keys(MIME).map(ext => ext.slice(1)).join(", ")}). Inputs are numbered
Image 1, Image 2, ... in flag order. Name each role: edit target, subject, style
or composition reference. References need not be edit targets.

Sessions
--session NAME keeps a conversation for consistent characters and style: each call
sees every earlier image of that session, so "the same character, now ..." works
without --from. A new NAME starts a new conversation.
- One call can ask for several images; they are saved as PATH-1.png, PATH-2.png, ...
- A chat model (--model, default gpt-6.1-sol) rewrites the prompt before drawing.
  That helps consistency but the prompt is no longer sent unchanged: state what
  must stay the same, and use a call without --session for exact prompt control.
- Start with a plain reference image of the subject (full body, plain background),
  then ask for scenes. --from still works, to bring outside images into a session.
- Size and quality are chosen per image and vary between calls of one session.
- Each generated or referenced image is uploaded to the ChatGPT account's file
  store and cited by id in later calls. Nothing deletes those uploads.
- The transcript is ~/.config/oai-cli/sessions/NAME.json; delete it to end the
  session. If a session stops working because old uploads expired, start a new
  NAME and pass the saved PNGs with --from.
- Slower than a single image: allow about 30 seconds per image.

Prompting guidance (optional scaffolding, not a required form or model schema):
- Describe scene/backdrop, subject, key details, constraints, then intended use.
- For complex requests, use short labeled lines; omit unhelpful fields.
- Preserve detailed user requirements without inventing extra creative requirements.
- For edits, say what changes and what stays; repeat invariants when iterating.
- Quote required image text verbatim; specify placement and typography.
- Ask for aspect ratio/composition in the prompt: there is no size or quality
  setting, and exact dimensions are not guaranteed. Nothing is resized or cropped.

Use only the lines that help:
Use case: <type of image>
Asset type: <where it will be used>
Primary request: <main goal>
Input images: <Image 1: role; Image 2: role>
Scene/backdrop: <setting>
Subject: <main subject>
Style/medium: <photo, illustration, 3D, etc.>
Composition/framing: <viewpoint, placement, aspect ratio>
Lighting/mood: <lighting>
Text (verbatim): "<exact text>"
Constraints: <what must stay or must happen>
Avoid: <specific unwanted elements>

Example session:
oai image --session courier 'Character sheet: a young courier with short teal hair, yellow raincoat, round glasses, red satchel. Full body, front view, plain white background, flat vector.' --out sheet.png
oai image --session courier 'The same courier cycling through a rainy street at night. Keep face, hair, outfit and colors unchanged. Wide landscape.' --out street.png

Example with two inputs:
oai image 'Image 1: edit target. Image 2: style reference. Apply Image 2 coloring to Image 1; keep its subject and framing unchanged.' --from base.png --from style.jpg --out result.png

The result is a saved path, not a displayed picture. Inspect subject, composition,
text and invariants, then iterate with one targeted change.`;

export interface ImageRequest {
  prompt: string;
  out: string;
  /** Reference images; the prompt refers to them as Image 1, Image 2, ... in this order. */
  from: string[];
  transparent: boolean;
  timeoutSeconds: number;
}

export async function readReference(path: string): Promise<{ mime: string; bytes: Buffer }> {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`image failed: ${path} is not a png, jpg, webp or gif.`);
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) throw new Error(`image failed: cannot read ${path}.`);
  return { mime, bytes };
}

/** Rejects a request before it is paid for: bad extension, existing output, too many references. */
export function checkRequest(out: string, from: string[]): void {
  if (extname(out).toLowerCase() !== ".png") throw new Error("image failed: --out needs a .png extension.");
  if (existsSync(out)) throw new Error(`image failed: ${out} already exists.`);
  if (from.length > MAX_REFERENCES) throw new Error(`image failed: --from accepts up to ${MAX_REFERENCES} images.`);
}

/** Validate and write one base64 PNG without overwriting; returns the line shown to the user. */
export async function savePng(out: string, data: string): Promise<{ bytes: Buffer; line: string }> {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("image failed: the provider returned invalid PNG data.");
  }
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, bytes, { flag: "wx" });
  return { bytes, line: `Wrote ${out}, ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, ${bytes.byteLength} bytes.` };
}

/** Every base64 PNG in the Codex Images JSON, or in a Responses stream, in output order. */
export function collectImages(payload: string): string[] {
  const found: string[] = [];
  let output: unknown[] = [];
  try {
    const json = JSON.parse(payload) as { data?: unknown } | null;
    if (Array.isArray(json?.data)) output = json.data;
  } catch { output = finalOutput(payload).output; }
  for (const item of output as Array<{ type?: unknown; result?: unknown; b64_json?: unknown } | null>) {
    const result = item?.type === "image_generation_call" ? item.result : item?.b64_json;
    if (typeof result !== "string") continue;
    const data = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/iu.exec(result)?.[1] ?? result;
    // A short partial is not a generated image.
    if (data.length > 100 && /^[A-Za-z0-9+/=]+$/u.test(data)) found.push(data);
  }
  return found;
}

/** Generate, or edit when references are given, and save one PNG. Never overwrites. */
export async function generateImage(request: ImageRequest): Promise<string> {
  checkRequest(request.out, request.from);
  const images = await Promise.all(request.from.map(async path => {
    const { mime, bytes } = await readReference(path);
    return { image_url: `data:${mime};base64,${bytes.toString("base64")}` };
  }));
  const [data] = collectImages(await post("image", `/codex/images/${images.length ? "edits" : "generations"}`, {
    model: MODEL,
    prompt: request.prompt,
    background: request.transparent ? "transparent" : "auto",
    quality: "auto",
    ...(images.length ? { images } : {}),
  }, request.timeoutSeconds, "application/json"));
  if (!data) throw new Error("image failed: the provider returned no image.");
  return (await savePng(request.out, data)).line;
}
