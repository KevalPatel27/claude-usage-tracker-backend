# Captured-input history and session insights

Updated 2026-11-04. This guide supersedes older statements that the tracker can never collect input text. Metrics-only devices continue to send no input text.

## What is included

- Sessions & prompts: daily submission counts, observed turn durations, character-length distribution, searchable input previews, person/device/date/project filters, CSV and collection diagnostics.
- Session details: readable expandable inputs in order, session/prompt IDs, manual project tags, incomplete/truncated states, permanent input deletion, session token/model/cost totals and input-cache reuse charts.
- Per-device opt-in/pause, setup version/platform, last history receipt and last client-reported queue/drop counts. These are observations, not proof a PC is online.
- Separate history retention, default 30 days. Existing token-counter accounting remains unchanged.

## Collection boundary

Claude Code's [documented hooks](https://code.claude.com/docs/en/hooks) provide UserPromptSubmit and Stop events. The installed Windows Desktop Code 2.1.317 emitted matching session_id and prompt_id in a prior real isolated Desktop test. That proves hook capability, not a fresh production-helper installation on every platform.

**The submit hook can also receive scheduled inputs, background-agent notifications and messages from another session. There is no verified reliable human-only discriminator. The user approved keeping opt-in captured-input history with this limitation disclosed. Do not label it a record of everything a particular employee typed.** Inputs can also contain pasted private information. Inform device users before enabling collection.

Only the hook's submitted `prompt` field and allowlisted IDs/timestamps are queued. Stop contributes correlation IDs/time only. The helper never reads transcript files, source files, assistant-response fields, tool-output fields, authentication stores or subscription APIs. Generated or pasted content inside an input is still input text. Direct assistant responses are not collected. Hook output is silent and never adds model context.

The first 16,000 Unicode characters of each input are captured; original character count and truncation are shown. This is not a token count. Empty input is distinguished from a missing submission. Text is rendered as text, without executing HTML or Markdown.

Observed turn duration runs from submission callback receipt to the latest matching completion callback receipt. It may include tool activity, waiting, interruptions and continuation. Missing, reversed or over-seven-day pairs have no duration. It is not API latency, session active time, working time or a productivity score. Tokens/models/cost are session-level and cannot be assigned exactly to one prompt. Five-hour/weekly allowance collection is deliberately excluded.

## Connect the first PC

1. Ensure the backend with `/v1/history` support is running and MongoDB is a replica set. Open the matching frontend and sign in as admin.
2. Open **Sessions & prompts → Collection diagnostics → Set up history**, or **Connect a PC**. Choose the existing device to preserve its assignment and key; do not register a duplicate. For a new device, register once and save its key privately.
3. Select the operating system and explicitly enable **Include captured-input history**. Download/run the normal metrics setup first if it is not already installed. Existing metrics-only PCs need only the history add-on.
4. Install Python 3.8+ if missing, then download `setup-history.py` from the dashboard. Run the dashboard's copied history command from Downloads as the ordinary Claude user. It includes your backend URL and the existing device ID, never a key.

Windows PowerShell:

```powershell
python ".\setup-history.py" --backend-url "https://claude-usage-tracker-backend.onrender.com" --device-id "COPY_THE_DEVICE_ID_FROM_DASHBOARD"
```

macOS/Linux Terminal:

```sh
python3 "./setup-history.py" --backend-url "https://claude-usage-tracker-backend.onrender.com" --device-id "COPY_THE_DEVICE_ID_FROM_DASHBOARD"
```

The helper reuses a valid metrics key only when its locally saved metrics endpoint matches this backend origin. Otherwise it requests the key privately. Do not paste keys into command arguments, chat or screenshots. If the key is lost, rotate that existing device's key and update its metrics/history setup; old keys stop working immediately.

5. Fully quit/reopen Claude Desktop and start a NEW local Code session; terminal users restart Code too. Workspace trust decisions belong to the user. Hooks/settings disabled by organizational policy or an overriding launch environment must be resolved by that PC's administrator.
6. Send a harmless input, let Claude finish, wait at least 60 seconds for metrics, then use **Verify**. History-enabled verification needs both a new positive token report and a new retained submission after verification started. A health response, setup success message or completion-only report is insufficient.
7. Check the correct device/person in the session list, input text/duration, token totals and collection diagnostics. Local setup can use `http://127.0.0.1:4000` on the backend PC only.

## Connect the second PC

Register the second physical PC once with its own key and desired person. Repeat the same steps on that PC, copying **its** device ID. Use the shared HTTPS backend; the other PC's loopback address cannot reach this backend. Neither PC needs MongoDB credentials. Verify one fresh session from each PC separately before comparing combined totals. Assignments are captured when the backend accepts a submission; delayed queued inputs use the assignment active at that receipt. Previously recorded assignments remain unchanged. Device names are friendly labels and need not match hostnames. Shared-PC assignments do not identify the actual person.

## Updates, diagnostics and removal

UI/backend changes using existing reports require no employee setup rerun. This new input-history feature requires one opt-in add-on install per participating PC; it is not automatic or silently enabled. Use the same device ID/key when updating. The installer preserves unrelated env/settings/hooks/statusLine, writes private backups, merges only owned handlers and refuses ambiguous edited ownership. It uses direct executable arguments, avoiding shell interpolation. `--settings-path` and `CLAUDE_CONFIG_DIR` can target the settings file the app actually reads. `--dry-run` previews changes.

Default helper/queue location: `~/.claude/usage-ledger-history`, alongside the chosen settings file. Settings, backups and helper config contain keys and must stay private. POSIX files/directories request modes 0600/0700. Windows uses the ordinary user's profile directory and inherited ACLs; native Windows ACL hardening beyond that is not implemented. Never install in a shared-readable folder.

```sh
python3 ./setup-history.py --status
python3 ./setup-history.py --flush
python3 ./setup-history.py --remove
```

Use `python` on Windows. Append `--settings-path` for a nondefault target. Removal erases owned pending input files/config and removes only owned hooks; it preserves other settings and keeps backups. Pause server collection in the dashboard as well. Pausing rejects server reports and the client pauses on its next 401/403; to stop capture on the PC immediately, remove its history hooks. Previously stored records remain until deletion/retention.

## Outages and accounting

Two async hooks queue input/completion separately. Queue limits: 5,000 events, 100 MiB, seven days. Flushes use batches of 20, four-second HTTP timeout and an eight-second work budget, on later hooks or manual `--flush`; no always-running updater/agent is installed. HTTPS is required except loopback HTTP. Redirects are refused to avoid forwarding a key elsewhere. Network/5xx failures retain the queue; invalid individual reports are isolated/dropped and counted; 401/403 pauses capture until setup is rerun. A missing correlation ID or oversized callback can be dropped.

Render cold starts can exceed an attempt timeout; a later hook/manual flush may recover queued inputs. Claude can terminate async work at session exit, and capture itself may never run. Queue overflow, expiry, process exit, clock mismatch, local removal or unavailable Python/hooks can lose records. **No lossless-delivery or always-on guarantee.** Real Render outage/cold-start and native macOS/Linux acceptance remain unverified.

Backend updates are transactional and serialized by device. Unique device/session/prompt identities prevent retry/concurrency duplication, including after backend restarts. Completion can arrive first. Older completion retries do not shorten a later observation. Conflicting repeated submissions return 409 without partially committing. Existing OTLP cumulative checkpoints and token dedup remain separate.

## Backend policy, indexes and APIs

Backend-only `PROMPT_RETENTION_DAYS=30`, range 1–365; no frontend env changes. New expiry values use this policy; changing it does not rewrite prior expiry dates. Token records/checkpoints have no new TTL. Expired input records are excluded from reads immediately; MongoDB TTL deletion is asynchronous. Backups/previously downloaded CSVs are outside automatic deletion. Project tags remain session metadata until changed/removed or device deletion; opaque deletion tombstones retain no text or person attribution and prevent queued deleted inputs reappearing.

Startup creates PromptTurn indexes: unique `(deviceId, sessionId, promptId)`, device/date, person/date, date, prompt fulltext (no stemming), and `expiresAt` TTL. SessionProject: unique device/session and project/device. PromptErasure: unique device/identity hash. No destructive migration of existing token collections is required. Atlas user needs the existing application's collection/index permissions.

- Ingestion-only device auth: `POST /v1/history` with `X-Tracker-Key`, strict version-2 schema and matching device ID. Opt-in required; revoked/archived keys cannot report. Device keys never grant admin access.
- Admin cookie auth: `GET /api/history/overview`, `/diagnostics`, `/export.csv`, `/sessions/:deviceId/:sessionId`; `PATCH` that session path with `{project}`; `DELETE /prompts/:recordId` with `{confirmation:"DELETE PROMPT"}`; `PATCH /api/devices/:id/prompt-history` with `{enabled}`.
- Search is MongoDB fulltext word search, not arbitrary substring search. Read queries have a 10-second database budget. Pages contain 25 records; input CSV is capped at 10,000 records. Reduce the date range for larger exports. CSV contains raw retained input text and protects formula-leading values. Admin access is all-or-nothing; per-manager roles/SSO/audit log are not implemented.
- Permanent input deletion removes its text, count and timing but preserves token accounting. Existing confirmed permanent person/device deletion includes matching history, with replay protection. Other assignments' usage stays intact.

## Verification and release state

Implemented and tested locally: strict auth/opt-in, duplicate/concurrent/out-of-order reports, deletion replay prevention, retention, filters/charts/CSV, setup merge/removal, bounded queue and 503 recovery. The actual standalone helper was exercised as a subprocess over HTTP → isolated MongoDB → admin APIs/CSV, using synthetic input. Browser fixtures test responsive 1440/390/360px states and mutations without changing employee records.

Prior real Windows Desktop submit/stop capability is verified. **A new real Desktop session through this production async helper, native macOS/Linux execution, public deployed frontend/backend and actual Render outage recovery are not yet independently verified.** No synthetic records were added to the collected local database.

Release backend first, then frontend; review provider build results and run the first/second-PC acceptance above. Routine Git pushes may trigger configured provider auto-deploy; no manual provider deployment or paid-resource purchase is performed by these changes.
