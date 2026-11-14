import { expect, test } from "bun:test";
import { accountId, finalOutput } from "../src/codex.ts";
import { collectImages } from "../src/image.ts";
import { outputPaths } from "../src/session.ts";
import { collect, render } from "../src/web.ts";

const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const done = (index: number, item: unknown) => ({ type: "response.output_item.done", output_index: index, item });
const message = (text: string, urls: string[] = []) => ({
  type: "message",
  content: [{ type: "output_text", text, annotations: urls.map(url => ({ type: "url_citation", url })) }],
});
const PNG_B64 = "A".repeat(200);

test("item-done events survive an empty terminal snapshot and are ordered by index", () => {
  const { output } = finalOutput(sse(
    done(1, message("second")),
    done(0, { type: "web_search_call" }),
    { type: "response.completed", response: { output: [] } },
  ) + "data: [DONE]\n");
  expect(output.map(item => (item as { type: string }).type)).toEqual(["web_search_call", "message"]);
});

test("a terminal snapshot fills items that never had a done event", () => {
  const { output } = finalOutput(sse({ type: "response.completed", response: { output: [message("only")] } }));
  expect(output).toHaveLength(1);
});

test("web lists cited URLs before consulted ones, without duplicates", () => {
  const found = collect(sse(
    done(0, { type: "web_search_call", action: { sources: [{ url: "https://a.example" }, "https://b.example", "ftp://x"] } }),
    done(1, message("Answer.", ["https://c.example", "https://a.example?utm_source=openai"])),
  ));
  expect(found).toEqual({
    answer: "Answer.",
    sources: ["https://c.example", "https://a.example", "https://b.example"],
    searched: true,
  });
  expect(render(found)).toBe("Answer.\n\nSources:\n  https://c.example\n  https://a.example\n  https://b.example");
});

test("web without a search call or answer reports that nothing was searched", () => {
  expect(collect(sse({ type: "response.completed", response: { output: [] } })))
    .toEqual({ answer: "", sources: [], searched: false });
});

test("image data is read from Images JSON and from a Responses stream", () => {
  expect(collectImages(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))).toEqual([PNG_B64]);
  const image = { type: "image_generation_call", result: `data:image/png;base64,${PNG_B64}` };
  expect(collectImages(sse(done(0, image), done(1, message("Done.")), done(2, image)))).toEqual([PNG_B64, PNG_B64]);
  expect(collectImages(JSON.stringify({ data: [{ b64_json: "short" }] }))).toEqual([]);
});

test("session outputs are numbered only when there are several, and skip existing files", () => {
  const none = () => false;
  expect(outputPaths("a.png", 1, none)).toEqual(["a.png"]);
  expect(outputPaths("a.png", 2, none)).toEqual(["a-1.png", "a-2.png"]);
  expect(outputPaths("a.png", 2, path => path === "a-1.png")).toEqual(["a-2.png", "a-3.png"]);
  expect(outputPaths("a.png", 1, path => path === "a.png")).toEqual(["a-2.png"]);
});

test("the account id comes from the token's auth claim", () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))
    .toString("base64url");
  expect(accountId(`h.${payload}.s`)).toBe("acct");
  expect(accountId("opaque")).toBeUndefined();
});
