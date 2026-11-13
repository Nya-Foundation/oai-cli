import { expect, test } from "bun:test";
import { accountId, finalOutput } from "../src/codex.ts";
import { collectImage } from "../src/image.ts";
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
  expect(collectImage(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))).toBe(PNG_B64);
  expect(collectImage(sse(done(0, { type: "image_generation_call", result: `data:image/png;base64,${PNG_B64}` }))))
    .toBe(PNG_B64);
  expect(collectImage(JSON.stringify({ data: [{ b64_json: "short" }] }))).toBeUndefined();
});

test("the account id comes from the token's auth claim", () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))
    .toString("base64url");
  expect(accountId(`h.${payload}.s`)).toBe("acct");
  expect(accountId("opaque")).toBeUndefined();
});
