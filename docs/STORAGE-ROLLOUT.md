# Reversible compact storage rollout

Production defaults to `mirror` when NODE_ENV=production or RENDER=true. Otherwise the default is legacy. Explicit STORAGE_MODE accepts `legacy`, `mirror`, `compact` and the local-only `compact-v2` prototype. `compact` requires a verified cutover marker. Existing domains, authentication cookies, device keys, OTLP payloads and PC setup remain unchanged.

Mirror mode writes raw `usagerecords` and bounded `usagebuckets` in the same device-locked transaction. IDs, timestamps, ownership and increments are identical. It also mirrors session enrichment, late-successor corrections and permanent deletions. First report for a historical stream atomically backfills that stream before adding a new point. A durable checkpoint version makes this idempotent. Online backfill bounds each stream to100,000 points; larger/orphaned streams stop for review rather than silently truncate.

Mirror mode retains both representations, including after a reader switch. Disk usage only benefits from retiring raw storage after the compact-only cutover.

Each journal holds at most256 points, with scalar date bounds and indexes. `usagepoints` is a read-only compatibility view. Selective report queries filter arrays before expansion. The compact path is smaller in document count but has been slower overall than raw locally; storage and latency are separate measures. Keep raw readers until restoration, full parity, API/CSV checks and acceptable bounded latency have been proven.

## Before deployment

Run build/typecheck,118 mirrored-mode tests and113 legacy-mode tests against disposable loopback MongoDB databases. The rollout suite covers retries/late reports/resets/concurrency, failure atomicity, live backfill and reader rollback after new exports. `scripts/rehearse-release.cjs` tests backfill, complete document parity and API/CSV output across raw, compact and rollback on an anonymized local restore.

`node scripts/backup-restore.cjs` uses backend .env for a read-only snapshot transaction, stores a PRIVATE EJSON application backup under ignored `.local/production-backups`, then proves document restoration in a disposable loopback DB. Text/search and ordinary indexes are reconstructed. TTL indexes are retained in its manifest and deferred during parity checking. This is an application-data restoration proof, not a cluster users/roles/configuration backup. Keep private and apply retention controls. Windows Node may require NODE_USE_SYSTEM_CA=1 for authorized system certificate trust; never disable TLS verification.

## Deploy and migrate

1. Push the tested release to Render's auto-deploy branch. Confirm `/health` reports the exact `release` SHA, db1, `storage.writerMode=mirror` and `storage.readMode=raw`. A successful Git push alone does not prove deployment.
2. Upgrade every writer connected to this database, including any local backend. Do not continue if old binaries still write raw only. Database writes outside this application can invalidate parity too.
3. From backend working directory, use its existing private .env and set only the operator mode:

```powershell
$env:STORAGE_MODE='mirror'
# Only on Windows Node versions supporting system CA trust when needed:
$env:NODE_USE_SYSTEM_CA='1'
node dist/scripts/storage-rollout.js backfill
node dist/scripts/storage-rollout.js verify
```

Backfill takes the existing device lock per stream and writes chunks plus the completion marker atomically. It is resumable by repeating the command. Current reports, reassignment and purge serialize with backfill; deleted people/devices cannot be recreated by an older snapshot. Original documents and checkpoints are not replaced from a stale backup.

Verify compares count, token sum AND a canonical SHA256 of every raw/reconstructed document in the SAME snapshot transaction. Missing IDs, altered times/ownership/deltas or duplicate points fail the comparison. It does not mutate raw records or reader selection.

4. After parity and acceptable query behavior, switch readers:

```powershell
node dist/scripts/storage-rollout.js read-compact
```

This re-verifies full document parity, then records the reader request in `storageRollout`. Running mirror backends poll it every15 seconds; `/health` reports the actual current reader. Existing UI and CSV remain compatible. Some ancillary accounting/detail checks intentionally retain raw canonical reads while rollback data remains available.

5. Check health, new real reports, full parity again, person/device/session/model/date breakdowns and CSV. Do not send invented telemetry to the real employee devices. Observe real incoming reports instead.

## Compact-only cutover

1. Verify the intended database and restore a current private backup into a disposable database. Rehearse the cutover there. Include both usage representations and checkpoints in the recovery plan.
2. Stop every process that writes to the production database, including Render, local tracker backends and old deployment instances. Leave them stopped during the final backfill and verification. Older binaries do not check the cutover marker.
3. With `STORAGE_MODE=mirror`, run `node dist/scripts/storage-rollout.js backfill`, then `node dist/scripts/storage-rollout.js prepare-compact-only`. The second command checks full document parity and records the cutover marker. The backend then requires `STORAGE_MODE=compact` to start against this database.
4. Start the updated backend with `STORAGE_MODE=compact`. Confirm `/health` reports compact writer and reader modes. Check that existing totals and CSV export match the pre-cutover results, that real reports increase the counts in compact storage, and that raw storage remains frozen.
5. After confirming the compact backend and restore plan, retire the frozen `usagerecords` collection. The cutover command never drops it. Keep `usagebuckets`, the `usagepoints` view, checkpoints and the cutover marker.

After compact writes start, the raw collection becomes stale. Recover by restoring or repairing the compact backend with current data. A return to mirror mode requires rebuilding and verifying the raw representation from current compact data before enabling raw readers.

## Mirror-mode reader rollback

```powershell
$env:STORAGE_MODE='mirror'
node dist/scripts/storage-rollout.js read-raw
```

Within15 seconds, readers return to raw. BOTH writers remain active, so reports accepted after cutover remain visible. If control lookup fails, the reader falls back to raw. Do not roll back to an old raw-only binary without coordinating writer pause/reconciliation and re-backfilling before compact reads resume. A valid historical verification marker alone cannot protect against an unknown old writer.

Admin-only `/api/dashboard/storage-status` exposes writer/reader mode and counts. Public `/health` exposes deployment SHA and format version, without keys, URI or account data. Production login behavior is unchanged. The local optimization copy and its private fixture login are separate from this release.
