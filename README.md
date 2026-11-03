# Usage ledger — backend

Authenticated OpenTelemetry receiver and reporting API for Claude Code usage across Windows PCs. Node.js 22, Express, TypeScript and MongoDB. Dashboard: [claude-usage-tracker-frontend](https://github.com/KevalPatel27/claude-usage-tracker-frontend).

## What it does

- Receives Claude Code monotonic OTLP HTTP/JSON token sums at `POST /v1/metrics` with an ingestion-only device key.
- Stores usage and durable cumulative-counter state in MongoDB transactions. Retries, duplicates, out-of-order reports, resets and concurrent sessions are handled without summing successive running totals.
- Provides admin cookie authentication, person/device CRUD, assignment history, key generation/rotation/revocation/reactivation, archive/restore and explicitly confirmed permanent erasure.
- Reports usage by date, person, device, model and session; exports matching CSVs. New readable session IDs can enrich exactly matching historical streams without changing totals.
- Estimates API-equivalent costs using a verified model catalog. Estimates are separate from subscription billing; shared-PC assignments do not identify the actual human.

Normal Claude requests continue directly to Anthropic. This service receives token metrics; it does not collect prompts, responses, conversation titles or transcripts.

## Local setup

Requires Node.js 22 and **MongoDB replica set or Atlas**. Standalone MongoDB cannot support ingestion transactions.

```sh
npm ci
```

Copy `.env.example` to `.env`. Configure MONGODB_URI, a random JWT_SECRET of at least 32 characters, ADMIN_BOOTSTRAP_SECRET and the exact dashboard ALLOWED_ORIGINS. For local HTTP development use NODE_ENV=development. An example local URI is `mongodb://127.0.0.1:27017/claude_tracker?replicaSet=rs0` after configuring that replica set. Never commit real environment files, credentials or device keys.

```sh
npm run dev
```

The backend defaults to port 4000. `/health` returns 200 when MongoDB is connected. Create the first admin from the dashboard using your bootstrap secret, then remove the bootstrap secret and restart. Keep JWT_SECRET stable across normal restarts.

## Build and tests

```sh
npm run typecheck
npm run build
npm test
```

Database integration suites are skipped unless TRACKER_TEST_MONGODB_URI is set to a **loopback** replica-set URI, such as `mongodb://127.0.0.1:27017/?replicaSet=rs0`, with isolated JWT_SECRET and ADMIN_BOOTSTRAP_SECRET values. They create/drop only uniquely named temporary test databases, never the collected database. The latest local full run passed **78 tests in 6 suites**, including real isolated MongoDB persistence, process restart, deletion/accounting safety and session/API/CSV agreement. This is local evidence, not a deployed-service claim.

## Deploy on Render

Use this repository's root, Node runtime and Node 22:

- Build: `npm ci --include=dev && npm run build && npm prune --omit=dev`
- Start: `npm start`
- Health path: `/health`

`render.yaml` is configured for this standalone backend repository. Applying it creates a service; creating/pushing this repository does not deploy it. Set MONGODB_URI to Atlas, production secrets, NODE_ENV=production and exact frontend ALLOWED_ORIGINS in Render. Leave HOST unset so it binds 0.0.0.0; Render supplies PORT. Do not upload .env or local MongoDB files. Dockerfile is an optional alternative.

Free Render services can sleep and restart. Later cumulative exports can recover increments within a surviving counter lifetime, but process exit during an outage can lose unreported usage. There is no durable queue on each PC. Always verify a real Desktop Code report through the deployed service before claiming collection works.

## Important behavior

- Device keys authorize ingestion only; admin routes require a separate signed session cookie.
- Permanent delete requires an explicit purge flag and exact current name. Device deletion erases its usage/key. Person deletion erases their usage and unassigns/revokes their current devices while preserving other owners' usage. Opaque replay floors prevent erased cumulative usage from returning. Existing downloaded exports/backups are outside this path.
- The model catalog is checked into `src/lib/model-rates.ts`; MODEL_RATES_JSON optionally overrides defaults. Haiku 5.5 estimates assume prompts ≤100k tokens; the >100k tier is higher and cannot be inferred from aggregate telemetry. Standard speed and five-minute cache writes are assumed. Unknown models remain unpriced.
- Session IDs group reported usage, not conversation purpose or actual human activity. Unmatched historical IDs remain unavailable; first/last report times are observations, not active duration.

No automatic retention policy is enabled. Back up usage and checkpoints together. No production deployment or public authenticated acceptance test is claimed by this repository.

## TypeScript editor configuration

The main tsconfig.json includes src and tests with explicit Node/Jest types, modern Node16 module/resolution rules, isolatedModules and noEmit. It is used by editor checks and `npm run typecheck`, so test globals are recognized. Production `npm run build` uses tsconfig.build.json to emit only src into dist; test globals/files are excluded from that output. The Dockerfile copies both configs. No ignoreDeprecations suppression is used. Both configurations were checked with the installed TypeScript 5.9.3 and an isolated TypeScript 6.0.3 compiler; all 78 tests pass. If an editor keeps showing an old diagnostic, restart its TypeScript language server once to reload the project.

The public /health response is not cacheable. The dashboard uses a same-origin /api/backend-health rewrite to call it without admin cookies or device keys. Browser health requests can reduce Render idle sleep while the dashboard runs; they are not a deployment or availability guarantee, and backend self-pinging is not configured.
