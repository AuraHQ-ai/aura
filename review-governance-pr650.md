# Governance Layer Review — PR #650 vs Issue #649 Spec

**PR:** #650 "Action governance infrastructure"
**Branch:** `cursor/action-governance-infrastructure-79cf`
**Status:** CLOSED (without merge) — created and closed 2026-03-07
**Issue:** #649 "Governance Layer"

---

## ✅ Correct

- **TypeScript compiles cleanly** — `npx tsc --noEmit` passes with zero errors.
- **`credential_audit_log` not dropped** — old table is preserved; writes are mirrored to `action_log` (dual-write in `src/lib/api-credentials.ts`). Correct per spec: "drop is a follow-up."
- **`isAdmin()` check before `approval_policies` writes** — `upsertApprovalPolicy()` in `src/lib/approval.ts` line ~100 checks `isAdmin(userId)` and returns `{ ok: false, error }` if not admin. Correct.
- **Basic table structure** — `action_log` and `approval_policies` tables exist with appropriate columns, indexes, and pgEnum types.
- **Secret scrubbing** — `scrubSecrets()` redacts sensitive fields before writing params to `action_log`. Good safety net.
- **Approval reaction handler** — handles both ✅ (`white_check_mark`/`heavy_check_mark`) and ❌ (`x`/`no_entry_sign`) reactions. Checks approver authorization.

---

## ❌ Blockers (must fix before merge)

### 1. Missing `action_log` immutability trigger
**File:** `drizzle/0033_action_governance.sql`
**Issue:** Migration creates the table but does NOT include the Postgres trigger function `action_log_immutability()` or the `BEFORE UPDATE` trigger. Without this, the identity fields (`tool_name`, `params`, `triggered_by`, `created_at`) can be silently modified after the fact, destroying audit trail integrity.
**Fix:** Add the trigger function and `CREATE TRIGGER` statement from the spec to the migration SQL.

### 2. `risk` field added to `defineTool()` — spec explicitly forbids this
**File:** `src/lib/tool.ts` line 73
**Issue:** Adds `risk?: RiskTier` to the `defineTool()` config. Tools like `send_email`, `reply_to_email`, `delete_event`, `place_outbound_call`, `send_sms` are annotated with `risk: "destructive"` in their source files. The spec says: *"Do NOT add a risk field to defineTool() — risk comes from approval_policies at runtime, not from tool definitions. The whole point is that policy is configurable without code changes."*
**Fix:** Remove the `risk` field from `defineTool()`, remove all `risk:` annotations from tool files, and have the interceptor query `approval_policies` for every tool call.

### 3. No `url_pattern` / `http_methods` on `approval_policies`
**File:** `src/db/schema.ts` (approvalPolicies table)
**Issue:** The `approval_policies` table only has `tool_pattern` (exact match). Since every `http_request` call has `tool_name = "http_request"`, there is no way to differentiate between `GET api.close.com/leads` (read) and `POST api.close.com/leads/merge` (destructive).
**Fix:** Add `url_pattern TEXT`, `http_methods TEXT[]`, and `credential_name TEXT` columns. Update `lookupPolicy()` to support glob matching on URL pattern, filtered by HTTP method.

### 4. Missing `Authorization` header rejection in `http_request` input schema
**File:** `src/tools/http-request.ts` lines 49-52, 81-83
**Issue:** The `headers` field is `z.record(z.string()).optional()` with no `.refine()`. Callers can pass `{ authorization: "Bearer malicious-key" }` directly. Worse, line 82-83 spreads `extraHeaders` AFTER the server-injected `Authorization` (`{ Authorization: \`Bearer ${credentialValue}\`, ...extraHeaders }`), so caller-provided headers **override** the legitimate credential. This is a credential injection + bypass vulnerability.
**Fix:** Add `.refine()` per spec rejecting `authorization`, `x-api-key`, `x-auth-token` (case-insensitive). Also reverse the spread order to `{ ...extraHeaders, Authorization: \`Bearer ${credentialValue}\` }` so the server-injected credential always wins.

### 5. No SSRF protection in `http_request`
**File:** `src/tools/http-request.ts` lines 90-94
**Issue:** No hostname resolution before requesting, no RFC1918/loopback/link-local IP check, no `redirect: "manual"` on fetch. The tool will happily fetch `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint) or `http://127.0.0.1:5432/` (local Postgres).
**Fix:** Add DNS resolution via `dns.lookup()`, `isPrivateIP()` check blocking 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, and set `redirect: "manual"` on the fetch call.

### 6. Approval message does NOT embed `action_log.id` in block metadata
**File:** `src/lib/approval.ts` `buildApprovalMessage()`, `src/app.ts` lines 126-129
**Issue:** The action ID is placed in display text (`Action ID: \`${actionLogId}\``) but NOT in Slack's block `metadata` field. The reaction handler looks up by `approvalMessageTs` (message timestamp) instead of UUID from metadata. Spec requires UUID in block metadata: `metadata: { event_type: "action_approval", event_payload: { action_log_id: "..." } }`.
**Fix:** Add `metadata` field to the `postMessage` call; update reaction handler to extract `action_log_id` from message metadata via `conversations.history`.

### 7. No `PendingApprovalError` / no job suspension
**File:** `src/lib/action-governance.ts` lines 155-161
**Issue:** For destructive tools, the interceptor returns `{ ok: false, pending_approval: true }` instead of throwing `PendingApprovalError`. The LLM gets a text response and may try to work around it. The spec requires throwing `PendingApprovalError` so `executeJob()` catches it and sets `approval_status: awaiting_approval` on the job row.
**Fix:** Create `PendingApprovalError` class, throw it for destructive tools, add catch handler in `executeJob()`.

### 8. No `approval_status` / `pending_action_log_id` on `jobs` table
**Files:** `drizzle/0033_action_governance.sql`, `src/db/schema.ts`
**Issue:** The migration does not alter the `jobs` table at all. The spec requires `ALTER TABLE jobs ADD COLUMN approval_status TEXT CHECK (...)` and `ADD COLUMN pending_action_log_id UUID REFERENCES action_log(id)`. Without these, no mechanism exists to suspend and resume jobs pending approval.
**Fix:** Add both columns to Drizzle schema and migration SQL.

### 9. Heartbeat does NOT skip `awaiting_approval` jobs
**File:** `src/cron/execute-job.ts` line 74
**Issue:** Job query only checks `eq(jobs.status, "pending")` with no filter on `approval_status`. Jobs awaiting approval will be re-executed on every heartbeat.
**Fix:** Add `or(isNull(jobs.approvalStatus), ne(jobs.approvalStatus, "awaiting_approval"))` to the WHERE clause.

### 10. `getSandboxEnvs()` not scoped
**File:** `src/lib/sandbox.ts` lines 66-71
**Issue:** `POSTHOG_API_KEY` and `CLAAP_API_KEY` are still injected into the sandbox, allowing `run_command` to bypass governance entirely for these services.
**Fix:** Remove these keys from `getSandboxEnvs()`. Add a comment explaining the compute-only policy.

### 11. Missing `idempotency_key` column on `action_log`
**Files:** `src/db/schema.ts`, `drizzle/0033_action_governance.sql`
**Issue:** The spec requires `idempotency_key TEXT UNIQUE` to prevent duplicate execution on job retries. Missing from both schema and migration.
**Fix:** Add `idempotencyKey: text("idempotency_key")` with a unique constraint.

---

## ⚠️ Warnings (should fix)

1. **`trigger_type` values diverge from spec** — uses `"interactive"` and `"job"` instead of spec values `"user_message"`, `"scheduled_job"`, `"autonomous"`. No CHECK constraint either.

2. **`credential_id` instead of `credential_name`** — uses FK to credentials table instead of text field. Arguably better for referential integrity but diverges from spec and makes audit queries harder.

3. **`_governanceBypass` is a module-level mutable boolean** — `src/lib/action-governance.ts` line 36. In concurrent Vercel requests, this could cause one request to bypass governance for another. **Fix:** Use `AsyncLocalStorage` as the spec recommends with `executionContext`.

4. **`http_request` has static `risk: "write"` but spec says risk from method + policy** — The `METHOD_RISK` map (lines 7-15) is defined but never actually used for governance decisions. DELETEs go through as writes.

5. **No `job_id` column on `action_log`** — Spec requires `job_id UUID REFERENCES jobs(id)` so you can trace which job triggered an action.

---

## TypeScript
```
npx tsc --noEmit: PASS (0 errors)
```

---

## Overall Readiness

**NOT ready to merge.** 11 blockers.

The core architecture choice — adding `risk` directly to `defineTool()` — contradicts the fundamental design principle of the governance layer (runtime policy from `approval_policies`, not code-time annotations). The `http_request` tool has security gaps (no SSRF protection, no auth header rejection, credential override vulnerability via header spread order). The job suspension mechanism (`PendingApprovalError` + `approval_status` on jobs + heartbeat skip) is entirely missing.

## Recommendation

Close this PR (already done) and restart with a fresh implementation that:
1. Keeps `defineTool()` signature unchanged (no `risk` field)
2. Implements `lookupPolicy()` with `url_pattern` glob matching for `http_request`
3. Adds SSRF protection and auth header rejection to `http_request`
4. Adds the immutability trigger to the migration
5. Implements `PendingApprovalError` + job table columns + heartbeat filtering
6. Scopes `getSandboxEnvs()` to compute-only vars
7. Uses block metadata for approval message `action_log_id`
8. Adds `idempotency_key` to `action_log`

Recommended PR split (from spec):
- **PR A** (Phases 1 + 2 + 5): DB schema + migrations, approval.ts, http-request.ts — pure additions, no behavior change
- **PR B** (Phases 3 + 4 + 6): defineTool() interceptor, reaction handler, getSandboxEnvs() scoping — the wiring, needs careful review
