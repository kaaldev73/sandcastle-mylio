# sandcastle-mylio

Familio — a self-hosted family photo library that runs as a single container on
Coolify (ADR 0002).

- Deploying it: [`docs/deployment.md`](docs/deployment.md) — every environment
  variable and the Coolify steps.
- Web UI: plain HTML and ES modules in [`web/`](web), served by the app itself
  at `/` with no build step ([ADR 0006](docs/adr/0006-web-ui-plain-html-and-es-modules.md)).
  Open the server's URL in a browser: the first visit offers first-Admin setup,
  then sign-in, invite acceptance (`/invite?token=…`) and password reset.
- Domain terms: [`GLOSSARY.md`](GLOSSARY.md). Decisions: [`docs/adr/`](docs/adr).

## Sandcastle with Claude Code

The planner, implementer, reviewer, and merger use Claude Code inside Docker.

1. Copy `.sandcastle/.env.example` to `.sandcastle/.env` and set `GH_TOKEN`.
   Uncomment and set `ANTHROPIC_API_KEY`; host Claude login
   credentials are not mounted into the sandbox. Keep this file out of Git.
2. Build (or rebuild) the sandbox image: `npx sandcastle docker build-image`.
3. Run `npm run sandcastle`. Every agent uses `claude-sonnet-5-5`; the model is
   fixed in `.sandcastle/main.mts` and has no environment override.

The workflow reads GitHub issues, creates commits, and merges completed branches
into the current branch. Authentication and model availability depend on your
[Anthropic account](https://docs.claude.com/en/docs/claude-code/overview).
