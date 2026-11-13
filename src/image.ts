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

export const IMAGE_HELP = `oai image <prompt> [--out PATH] [--from PATH ...] [--timeout S]

Writes one PNG and reports its real dimensions. --out must be a new .png path
(default oai-<timestamp>.png); missing parents are created, nothing is overwritten.
Repeat --from for reference images (${Object.keys(MIME).map(ext => ext.slice(1)).join(", ")}). Inputs are numbered
Image 1, Image 2, ... in flag order. Name each role: edit target, subject, style
or composition reference. References need not be edit targets.
The prompt is sent unchanged. Pipe it on stdin when it spans several lines.

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

Example with two inputs:
oai image 'Image 1: edit target. Image 2: style reference. Apply Image 2 coloring to Image 1; keep its subject and framing unchanged.' --from base.png --from style.jpg --out result.png

The result is a saved path, not a displayed picture. Inspect subject, composition,
text and invariants, then iterate with one targeted change.`;

export interface ImageRequest {
  prompt: string;
  out: string;
  /** Reference images; the prompt refers to them as Image 1, Image 2, ... in this order. */
  from: string[];
  timeoutSeconds: number;
}

/** Base64 PNG from the Codex Images JSON, or from a Responses stream. */
export function collectImage(payload: string): string | undefined {
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
    if (data.length > 100 && /^[A-Za-z0-9+/=]+$/u.test(data)) return data;
  }
  return undefined;
}

/** Generate, or edit when references are given, and save one PNG. Never overwrites. */
export async function generateImage(request: ImageRequest): Promise<string> {
  const out = resolve(request.out);
  if (extname(out).toLowerCase() !== ".png") throw new Error("image failed: --out needs a .png extension.");
  // Checked before the request so a generation is not paid for and then discarded.
  if (existsSync(out)) throw new Error(`image failed: ${request.out} already exists.`);
  const images = await Promise.all(request.from.map(async path => {
    const mime = MIME[extname(path).toLowerCase()];
    if (!mime) throw new Error(`image failed: ${path} is not a png, jpg, webp or gif.`);
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) throw new Error(`image failed: cannot read ${path}.`);
    return { image_url: `data:${mime};base64,${bytes.toString("base64")}` };
  }));

  const data = collectImage(await post("image", images.length ? "/images/edits" : "/images/generations", {
    model: MODEL,
    prompt: request.prompt,
    background: "auto",
    quality: "auto",
    ...(images.length ? { images } : {}),
  }, request.timeoutSeconds, "application/json"));
  if (!data) throw new Error("image failed: the provider returned no image.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("image failed: the provider returned invalid PNG data.");
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes, { flag: "wx" });
  return `Wrote ${request.out}, ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, ${bytes.byteLength} bytes.`;
}
