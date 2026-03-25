# Aura Sandbox Template

Pre-baked E2B sandbox with all tools Aura needs — no install latency on first use.

## Tools included

| Tool | Purpose |
|------|---------|
| `psql` | PostgreSQL queries against Aura's own DB |
| `gh` | GitHub CLI for PR/issue work |
| `gcloud` / `bq` | BigQuery + GCS operations |
| `jq` | JSON parsing in shell scripts |
| `rg` (ripgrep) | Fast codebase search |
| `python3` + `psycopg2` | Direct DB access via Python |
| `vercel` | CLI for deployment logs |
| `pnpm` | Monorepo package manager |
| `claude` | Claude Code agent dispatch |
| `gcsfuse` | Mount GCS bucket at `/mnt/aura-files` |
| `pdftotext` | PDF text extraction |

## Building

The image is defined in `e2b.Dockerfile` (single source of truth). The build
script reads it via E2B's `fromDockerfile()` API.

### Local

```bash
# Dev build
pnpm --filter aura-sandbox build

# Production build
pnpm --filter aura-sandbox build:prod
```

Requires `E2B_API_KEY` in the root `.env` file or as an environment variable.

After the build, copy the `Template ID` from the output and set:
```
E2B_TEMPLATE_ID=<id>  # in Vercel env vars
```

### CI (automatic)

The GitHub Actions workflow `.github/workflows/sandbox-build.yml` automatically
rebuilds the template when `sandbox/` files change on `main`. It updates
`E2B_TEMPLATE_ID` in Vercel and triggers a production redeploy.

You can also trigger a rebuild manually from the Actions tab (`workflow_dispatch`).

## Architecture

```
sandbox/
  e2b.Dockerfile   ← single source of truth (standard Dockerfile)
  build.ts         ← reads Dockerfile, calls E2B SDK to build
  package.json     ← isolated deps (e2b, dotenv, tsx)
  README.md        ← you are here
```

The sandbox code itself (`apps/api/src/lib/sandbox.ts`) picks up the template
via the `E2B_TEMPLATE_ID` env var. No code changes needed — just rebuild +
update the env var (CI does this automatically).
