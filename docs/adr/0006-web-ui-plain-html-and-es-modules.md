# Web UI is plain HTML and ES modules with no build step

The web UI lives in `web/` as static HTML, CSS and native ES modules, served by the same Node server (`src/static.ts`) that serves the API. We chose this over a bundled framework (React/Vite etc.) to keep ADR 0002's single container simple: no bundler, no extra Dockerfile stage, no second deployment, and the app still runs straight from source with `tsx`. The cost is no type checking or component framework in the UI; if a screen outgrows hand-written DOM code we can revisit with a build step then.

The shell needs no authentication (it holds no data; the API enforces access). Any non-API `GET` for an extensionless path returns `index.html` so client routes survive a reload, while `/api/*` misses stay JSON 404s. The session cookie stays `HttpOnly`, script never sees a token, and a Content-Security-Policy restricts the page to its own origin.
