import type { WebClient } from "@slack/web-api";
import { listCursorAgents } from "./cursor-agent.js";
import { getBigQueryClient } from "./bigquery.js";
import {
  fetchGatewayModels,
  getModelCatalogResponse,
} from "./model-catalog.js";
import { logger } from "./logger.js";
import { recordError } from "./metrics.js";
import { safePostMessage } from "./slack-messaging.js";
import { resolveSlackDestination } from "../tools/slack.js";

export interface SmokeProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface SmokeProbe {
  name: string;
  run: () => Promise<Omit<SmokeProbeResult, "name">>;
}

export interface SmokeCheckResult {
  deploy?: string;
  results: SmokeProbeResult[];
  failures: number;
}

export interface RunSmokeCheckOptions {
  slackClient: WebClient;
  deploy?: string;
  probes?: SmokeProbe[];
  notifyUser?: string | null;
  successChannel?: string | null;
}

const REQUIRED_ENV_VARS = [
  "SANDBOX_WEBHOOK_SECRET",
  "CURSOR_WEBHOOK_SECRET",
  "AURA_PUBLIC_URL",
  "DATABASE_URL",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstConfiguredAdmin(): string | null {
  return (
    (process.env.AURA_ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .find(Boolean) ?? null
  );
}

function resolveDeploySha(deploy?: string): string | undefined {
  return (
    deploy?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    undefined
  );
}

function formatProbeLine(result: SmokeProbeResult): string {
  const icon = result.ok ? (result.skipped ? ":large_yellow_circle:" : ":white_check_mark:") : ":x:";
  const status = result.ok ? (result.skipped ? "skipped" : "ok") : "failed";
  return `- ${result.name}: ${status} (${result.detail})`;
}

function formatSummary(result: SmokeCheckResult): string {
  const deployLabel = result.deploy ? `Deploy ${result.deploy}` : "Deploy";
  const header =
    result.failures > 0
      ? `:warning: :x: ${deployLabel} smoke check FAILED`
      : `:white_check_mark: ${deployLabel} smoke check`;

  return [header, ...result.results.map(formatProbeLine)].join("\n");
}

function defaultNotifyUser(): string | null {
  return (
    process.env.SMOKE_CHECK_NOTIFY_USER?.trim() ||
    process.env.FOUNDER_USER_ID?.trim() ||
    firstConfiguredAdmin()
  );
}

async function notifySmokeCheckResult(
  slackClient: WebClient,
  result: SmokeCheckResult,
  options: Pick<RunSmokeCheckOptions, "notifyUser" | "successChannel">,
): Promise<void> {
  const text = formatSummary(result);

  if (result.failures > 0) {
    const target = options.notifyUser ?? defaultNotifyUser();
    const failingProbes = result.results
      .filter((probe) => !probe.ok)
      .map((probe) => probe.name);

    recordError("smoke_check", new Error(`${result.failures} smoke probe(s) failed`), {
      deploy: result.deploy,
      failingProbes,
    });

    if (!target) {
      logger.warn("Smoke check failure notification skipped: no target configured", {
        deploy: result.deploy,
        failingProbes,
      });
      return;
    }

    const dmChannelId = await resolveSlackDestination(slackClient, target);
    if (!dmChannelId) {
      logger.warn("Smoke check failure notification skipped: target did not resolve", {
        deploy: result.deploy,
        target,
        failingProbes,
      });
      return;
    }

    await safePostMessage(slackClient, {
      channel: dmChannelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  const successChannel = options.successChannel ?? process.env.SMOKE_CHECK_SUCCESS_CHANNEL?.trim();
  if (!successChannel) return;

  await safePostMessage(slackClient, {
    channel: successChannel,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
}

export function createDefaultSmokeProbes(slackClient: WebClient): SmokeProbe[] {
  return [
    {
      name: "Vercel env vars",
      run: async () => {
        const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
        const present = REQUIRED_ENV_VARS.length - missing.length;
        const base = `${present}/${REQUIRED_ENV_VARS.length} present`;

        return {
          ok: missing.length === 0,
          detail: missing.length > 0 ? `${base}; missing ${missing.join(", ")}` : base,
        };
      },
    },
    {
      name: "Cursor API",
      run: async () => {
        await listCursorAgents();
        return { ok: true, detail: "list agents 200" };
      },
    },
    {
      name: "Slack auth",
      run: async () => {
        const auth = await slackClient.auth.test();
        return {
          ok: Boolean(auth.ok),
          detail: auth.ok ? `auth.test ok${auth.team ? ` for ${auth.team}` : ""}` : "auth.test failed",
        };
      },
    },
    {
      name: "AI Gateway catalog",
      run: async () => {
        const [liveModels, storedCatalog] = await Promise.all([
          fetchGatewayModels(),
          getModelCatalogResponse(),
        ]);
        const liveIds = new Set(liveModels.map((model) => model.id));
        const storedIds = storedCatalog.catalog.map((model) => model.value);
        const overlap = storedIds.filter((modelId) => liveIds.has(modelId));

        return {
          ok: liveModels.length > 0 && overlap.length > 0,
          detail: `${liveModels.length} live, ${storedIds.length} stored, ${overlap.length} overlap`,
        };
      },
    },
    {
      name: "BigQuery",
      run: async () => {
        const client = await getBigQueryClient();
        if (!client) {
          return {
            ok: true,
            skipped: true,
            detail: "skipped: google_bq_credentials not configured",
          };
        }

        const [datasets] = await client.getDatasets();
        return { ok: true, detail: `listed ${datasets.length} dataset(s)` };
      },
    },
  ];
}

export async function runSmokeCheck(
  options: RunSmokeCheckOptions,
): Promise<SmokeCheckResult> {
  const deploy = resolveDeploySha(options.deploy);
  const probes = options.probes ?? createDefaultSmokeProbes(options.slackClient);
  const results: SmokeProbeResult[] = [];

  for (const probe of probes) {
    try {
      const result = await probe.run();
      results.push({
        name: probe.name,
        ok: result.ok,
        detail: result.detail,
        ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
      });
    } catch (error) {
      results.push({
        name: probe.name,
        ok: false,
        detail: errorMessage(error),
      });
    }
  }

  const smokeResult: SmokeCheckResult = {
    ...(deploy ? { deploy } : {}),
    results,
    failures: results.filter((result) => !result.ok).length,
  };

  try {
    await notifySmokeCheckResult(options.slackClient, smokeResult, options);
  } catch (error) {
    recordError("smoke_check_notify", error, {
      deploy: smokeResult.deploy,
      failures: smokeResult.failures,
    });
    logger.warn("Smoke check notification failed", {
      deploy: smokeResult.deploy,
      error: errorMessage(error),
    });
  }

  return smokeResult;
}
