-- Backfill NULL cost_usd on conversation_traces (issue #1325).
--
-- The runtime pricing path only computed cost when resolved_model_id could be
-- derived from the provider response; on 5-20% of turns it was NULL while
-- model_id was populated, leaving cost_usd NULL and understating every spend
-- metric. The pricing lookup now falls back to model_id; this migration
-- recomputes cost_usd for existing NULL rows where a price can be derived,
-- mirroring computeStepCost() in apps/api/src/lib/cost-calculator.ts against
-- the trace-level cumulative token_usage.
--
-- Rows are only updated when the computed cost is > 0 (a genuine price was
-- derived); traces with no matching model_pricing rows stay NULL.
WITH pricing AS (
  SELECT
    workspace_id,
    model_id,
    MAX(CASE WHEN token_type = 'input' THEN price_per_million::numeric END) AS input_price,
    MAX(CASE WHEN token_type = 'cache_read' THEN price_per_million::numeric END) AS cache_read_price,
    MAX(CASE WHEN token_type = 'cache_write' THEN price_per_million::numeric END) AS cache_write_price,
    MAX(CASE WHEN token_type = 'output' THEN price_per_million::numeric END) AS output_price,
    MAX(CASE WHEN token_type = 'reasoning' THEN price_per_million::numeric END) AS reasoning_price
  FROM "model_pricing"
  WHERE effective_from <= now()
    AND (effective_until IS NULL OR effective_until >= now())
  GROUP BY workspace_id, model_id
),
computed AS (
  SELECT
    ct.id,
    (
      CASE
        WHEN jsonb_typeof(ct.token_usage -> 'inputTokenDetails') = 'object' THEN
          COALESCE(
            (ct.token_usage -> 'inputTokenDetails' ->> 'noCacheTokens')::numeric,
            GREATEST(
              0,
              COALESCE((ct.token_usage ->> 'inputTokens')::numeric, 0)
                - COALESCE((ct.token_usage -> 'inputTokenDetails' ->> 'cacheReadTokens')::numeric, 0)
                - COALESCE((ct.token_usage -> 'inputTokenDetails' ->> 'cacheWriteTokens')::numeric, 0)
            )
          ) * COALESCE(p.input_price, 0)
          + COALESCE((ct.token_usage -> 'inputTokenDetails' ->> 'cacheReadTokens')::numeric, 0) * COALESCE(p.cache_read_price, 0)
          + COALESCE((ct.token_usage -> 'inputTokenDetails' ->> 'cacheWriteTokens')::numeric, 0) * COALESCE(p.cache_write_price, 0)
        ELSE COALESCE((ct.token_usage ->> 'inputTokens')::numeric, 0) * COALESCE(p.input_price, 0)
      END
      +
      CASE
        WHEN jsonb_typeof(ct.token_usage -> 'outputTokenDetails') = 'object' THEN
          COALESCE((ct.token_usage -> 'outputTokenDetails' ->> 'textTokens')::numeric, 0) * COALESCE(p.output_price, 0)
          + COALESCE((ct.token_usage -> 'outputTokenDetails' ->> 'reasoningTokens')::numeric, 0) * COALESCE(p.reasoning_price, 0)
        ELSE COALESCE((ct.token_usage ->> 'outputTokens')::numeric, 0) * COALESCE(p.output_price, 0)
      END
    ) / 1000000.0 AS cost
  FROM "conversation_traces" ct
  JOIN pricing p
    ON p.model_id = COALESCE(ct.model_id, ct.resolved_model_id)
   AND COALESCE(p.workspace_id, 'default') = COALESCE(ct.workspace_id, 'default')
  WHERE ct.cost_usd IS NULL
    AND ct.token_usage IS NOT NULL
)
UPDATE "conversation_traces" ct
SET cost_usd = round(c.cost, 6),
    cost_priced_at = now()
FROM computed c
WHERE ct.id = c.id
  AND c.cost > 0;
