```
 ██████╗  █████╗ ██╗
██╔═══██╗██╔══██╗██║
██║   ██║███████║██║
██║   ██║██╔══██║██║
╚██████╔╝██║  ██║██║
 ╚═════╝ ╚═╝  ╚═╝╚═╝  web search and image generation
```

# oai-cli

OpenAI web search and image generation from the terminal, on a ChatGPT
subscription login. One 20 kB file with no dependencies; needs Node 22 or newer.

```sh
npm install -g @k3scat/oai-cli
oai login           # browser sign-in, once

oai web 'What changed in the latest stable Bun release?'
oai image 'A coastal town at dusk, wide landscape, no text.' --out coast.png
oai image 'Image 1: edit target. Image 2: style reference. Recolor Image 1 like Image 2.' \
  --from draft.png --from style.jpg --out revised.png
```

`oai --help` lists every option; `oai image --help` adds the prompting guide.
The query or prompt can also come from stdin.

## Login

`oai login` uses the Codex CLI's OAuth client, the only credential the image
endpoints accept. It is its own session: signing in here does not touch a Codex
CLI login. The token is stored in `~/.config/oai-cli/auth.json` (mode 600) and
refreshed when it nears expiry.

The sign-in redirects to `localhost:1455`. On a remote or headless machine,
paste the final redirect URL from the browser into the prompt instead. Codex CLI
uses the same port, so finish one login at a time.

`OAI_ACCESS_TOKEN` supplies an access token directly and skips the store.

## Behavior

- **web** asks `gpt-6.1-sol` with the hosted `web_search` tool and prints the
  answer, then up to eight source URLs: cited ones first, then pages consulted.
  `--json` prints `{answer, sources}`.
- **image** writes one PNG and reports its real dimensions. It never
  overwrites, and checks the path before spending a generation. The endpoint
  ignores `size`, `quality` and other model names, so ask for the aspect ratio
  in the prompt. `--from` switches to the edit endpoint and can be repeated;
  refer to references as Image 1, Image 2, ... in flag order.
- Errors go to stderr with exit code 1. Requests are not retried.

Both commands call private Codex backend endpoints (`chatgpt.com/backend-api/codex`)
and count against the subscription's usage. Those endpoints can change without notice.

## Development

```sh
bun install
bun run dev web 'query'   # run from source
bun run check             # typecheck, tests, build, smoke check
```

## Releases

Work lands on `dev`; `main` is what users install. Every push to either branch
runs [check.yml](.github/workflows/check.yml), and a green run hands over to
semantic-release, which picks the version from the commits, tags it, publishes
to npm and writes the GitHub release. Nothing is committed back: tags and npm
are the release record.

| Branch | Version | npm dist-tag |
| --- | --- | --- |
| `main` | `1.2.0` | `latest` |
| `dev` | `1.2.0-dev.1` | `dev` |

Use Conventional Commits: `fix:` is a patch, `feat:` a minor, a
`BREAKING CHANGE:` footer a major; `docs:`, `test:` and `chore:` release nothing.
Bring `dev` into `main` with a fast-forward or a merge commit, not a squash, so
the prerelease tags stay in `main`'s history.

Publishing uses npm trusted publishing through the GitHub environment `npm`, so
the repository holds no npm token.

## License

[MIT](LICENSE)
