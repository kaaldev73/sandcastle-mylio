# sandcastle-mylio

Familio — a self-hosted family photo library that runs as a single container on
Coolify (ADR 0002).

- Deploying it: [`docs/deployment.md`](docs/deployment.md) — every environment
  variable and the Coolify steps.
- Domain terms: [`GLOSSARY.md`](GLOSSARY.md). Decisions: [`docs/adr/`](docs/adr).

## Sandcastle with OpenCode

The planner, implementer, reviewer, and merger use OpenCode inside Docker.

1. Copy `.sandcastle/.env.example` to `.sandcastle/.env` and set `GH_TOKEN`.
   Uncomment and set the API key for your selected provider; host OpenCode login
   credentials are not mounted into the sandbox. Keep this file out of Git.
2. Build (or rebuild) the sandbox image: `npx sandcastle docker build-image`.
3. Run `npm run sandcastle`. The default model is `opencode/big-pickle`, matching
   Sandcastle's OpenCode template. To select another model, run
   `OPENCODE_MODEL=provider/model npm run sandcastle` with an available model ID.

The workflow reads GitHub issues, creates commits, and merges completed branches
into the current branch. Provider authentication and model availability depend on
[your OpenCode provider](https://opencode.ai/docs/providers/).
