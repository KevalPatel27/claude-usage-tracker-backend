# Persistence and query indexes

The backend owns MongoDB access. Device keys authorize ingestion only; dashboard APIs require an admin cookie. The existing collections remain intact. Schema changes below are Mongoose application validation, **not MongoDB collection validators or a historical-data migration**. Direct writes made through Compass bypass Mongoose. Existing records are not rewritten or erased.

## Collections and relationships

| Collection | Purpose | Relationships and invariants |
| --- | --- | --- |
| people | Assigned person, name, notes, lifecycle | Names trimmed, required, at most 120 characters; notes at most 2,000 |
| devices | Reporting identity and assignment history | Current person plus dated assignment snapshots; full key stored only as a hash; friendly name at most 120 characters |
| usagerecords | One accepted counter export per stream/time | Device, optional readable session ID, historical person snapshot, model, token category, exact nanosecond timestamps and calculated increment |
| checkpoints | Durable stream serialization and deletion floors | Unique device + stream; retains replay protection through restarts and permanent history deletion |
| admins | Dashboard sign-in | Unique normalized username; password hash |

Usage counters and checkpoint totals must be nonnegative safe integers; fractions, Infinity, NaN and unsafe integers are rejected. Token categories are input/output/cacheRead/cacheCreation. Temporality is delta (1) or cumulative (2). Nano timestamps remain digit strings, avoiding Number precision loss. Model/query source dimensions are limited to 200 characters at the parser and model layers; unknown model names are still accepted and explicitly unpriced. Request parsing and transactional logic remain necessary: Mongoose update validators do not validate every update operator.

Historical attribution remains in `personIdAtTime`; reassignment does not relabel old reports. Successive cumulative values are converted to increments transactionally. Do not manually sum cumulative values or delete checkpoints to clean up usage.

## Index inventory

| Collection / key | Query or invariant |
| --- | --- |
| people: archivedAt, name | Active directory, name ordering |
| devices: personId; assignments.personId | Current assignments and historical-person deletion checks |
| devices: archivedAt, createdAt descending; revokedAt | Device directory and lifecycle filters |
| devices: keyPrefix, revokedAt, archivedAt (`ingestion_key_lookup`) | Resolve active candidates before verifying the full key hash; **not unique**, prefix collisions are allowed |
| usage: deviceId, seriesKey, timeUnixNano (unique) | Durable duplicate-export protection and neighboring stream samples |
| usage: deviceId, exportedAt descending | Device period summaries/export |
| usage: personIdAtTime, exportedAt descending | Person period summaries/export |
| usage: exportedAt descending | Overall date ranges |
| usage: usageModel, exportedAt descending (`usage_model_period`) | Model-filtered date ranges |
| usage: sessionId, deviceId, exportedAt descending | Session drill-down |
| checkpoints: deviceId, seriesKey (unique) | Per-stream checkpoint |
| admins: username (unique) | Sign-in identity |

The existing standalone usage deviceId index is retained for compatibility; assess redundant indexes on real workloads before removal. Indexes add storage and ingestion write cost. Avoid indexing every dashboard combination without query evidence. No automatic TTL is enabled: independent expiry could remove baselines or replay protection and corrupt totals.

Startup waits for `Model.init()` before listening. The two new nonunique indexes are additive; startup may take longer while they build. There is no `syncIndexes()`, automatic index deletion, or Atlas migration command. Inspect deployment logs for index failures. This update has only been applied and measured on local MongoDB; Atlas build duration/performance remain unverified.

## Verification

Run `npm run typecheck`, `npm run build`, then `npm test`. For database coverage set `TRACKER_TEST_MONGODB_URI` to the local replica-set URI, plus isolated test JWT/bootstrap secrets. Tests use their own `tracker_*_test_*` databases, never the collected database, and reject non-loopback MongoDB. Without this URI, integration suites are skipped.

`tests/schema.test.ts` validates bad writes and uses **unhinted executionStats explain** on isolated data: the planner must select each new index and examine at most two documents for one match. It also checks the existing duplicate-export unique constraint. This is bounded fixture evidence, not a production performance benchmark. Existing integration tests verify restarts, retries, concurrency, out-of-order exports, resets, deletion and API/trend/CSV agreement.

Reference: [Mongoose validation](https://mongoosejs.com/docs/validation.html), [MongoDB compound index prefixes and field order](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/).

Further milestones: durable client buffering for outage/process-exit recovery; coordinated retention; audit history for administrative changes; query budgets and pagination for large directories. Each needs a separate correctness review; none is implied by this update.
