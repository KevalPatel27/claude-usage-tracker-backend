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

## Troubleshoot repeated Render startup failures

The HTTP listener opens only after configuration, MongoDB connection, transaction support and indexes are ready. Therefore an early failure also causes Render's no-open-port warning; changing to a background worker will not fix it.

Startup now logs the current stage and a safe error tag without printing connection strings, credentials, raw driver errors or stack traces:

| Tag | Action |
| --- | --- |
| MISSING_MONGODB_URI / INVALID_MONGODB_URI | Configure the Atlas Drivers URI; replace placeholders, remove wrapping quotes and encode password characters |
| INVALID_JWT_SECRET | Generate a random JWT secret with at least 32 characters |
| LOCAL_DATABASE_ON_RENDER | Use Atlas; Render cannot reach your PC through localhost |
| MONGODB_UNREACHABLE | Check cluster availability, URI/DNS and Atlas Network Access for Render outbound CIDR ranges |
| MONGODB_AUTH_FAILED | Check the Atlas database user/password and authSource, not the Atlas website login |
| MONGODB_PERMISSION_DENIED | Grant the database user appropriate read/write and index creation permissions on this database |
| REPLICA_SET_REQUIRED | Use Atlas or a configured replica set |
| INDEX_CONFLICT | Inspect index/data conflicts without deleting accounting state blindly |
| INVALID_RENDER_HOST / HTTP_BIND_FAILED | Remove HOST or use 0.0.0.0; use Render's assigned PORT |

Obtain outbound ranges from the specific Render service → Connect → Outbound and add those ranges to Atlas → Network Access. Do not substitute your home IP. Once corrected, deploy the latest commit; success ends with `[Server] Ready <port>` and /health returning status=ok, db=1. Do not paste secrets to troubleshoot. The latest startup-diagnostic change passed typecheck/build and 81 tests in 7 suites, including credential-redaction and compiled-process failure checks. Actual Render environment values remain unverified until its new safe error line is reviewed.

### Schema and query indexes

See [schema and index guide](docs/SCHEMA-AND-INDEXES.md) for persistence rules, additive query indexes, local explain tests, deployment behavior and limits.
