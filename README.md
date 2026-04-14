# Nigs Browser Automation

Browser-first local automation built with:

- `Playwright` for headed Google Chrome control
- `MCP` for tool/resource/prompt exposure
- `OpenAI Responses API` for prompt-to-plan generation

Phase 1 is browser-only. The current implementation supports launching Chrome, navigating sites, interacting with pages, extracting YouTube results, and storing structured run artifacts under `runtime/`.

## Workspace

- `apps/mcp-server`: local stdio MCP server
- `apps/task-runner`: natural-language task runner using `OPENAI_API_KEY`
- `packages/core`: schemas, artifact store, executor, registry
- `packages/browser-playwright`: Chrome session manager and generic browser tools
- `packages/site-youtube`: YouTube search/open/extraction tools

## Requirements

- Node.js `18.16+`
- Google Chrome installed locally
- OpenAI API key for `apps/task-runner`

## Setup

```bash
npm install
cp .env.example .env
```

## Run The Task Runner

This uses OpenAI in the background to create a validated JSON plan, then executes only local tools.

```bash
npm run dev:runner -- --prompt "Go to YouTube, find the top 3 LeBron James videos, collect their text, and save the results."
```

Useful flags:

- `--dry-run`
- `--plan-file ./plan.json`
- `--max-steps 8`
- `--runtime-dir ./runtime`

The runner prints the run id, the generated plan, and the summary file path. Artifacts are written under `runtime/artifacts/<runId>/`.

## Run The MCP Server

```bash
npm run dev:mcp
```

The MCP server exposes:

- Tools: browser, YouTube, and artifact tools
- Resources:
  - `run://latest/summary`
  - `run://{runId}/summary`
  - `run://{runId}/artifacts/{artifactId}`
- Prompts:
  - `youtube-top-results`
  - `browser-research-run`

## Test And Typecheck

```bash
npm run typecheck
npm test
```

Optional real-browser integration tests:

```bash
RUN_BROWSER_INTEGRATION=1 npm test
RUN_YOUTUBE_INTEGRATION=1 npm test
```

## Notes

- The OpenAI layer is planner-only. It never executes side effects directly.
- Browser runs prefer semantic targets over raw CSS selectors.
- YouTube transcript extraction is best-effort. Missing transcript is non-fatal.
- Phase 2 desktop automation is intentionally not implemented yet.

