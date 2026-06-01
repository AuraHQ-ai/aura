# Toy Memory Benchmark Failure Analysis

Run analyzed: `2026-06-01T12-15-22-741Z-dghw6f7o`  
Command: `pnpm --filter aura-api bench:memory --dataset=toy --subset=toy --concurrency=2 --score-concurrency=4 --json=/tmp/bench/toy-result.json --no-progress`  
Runtime/cost: 34.6s, $0.0654  
Replay/as-of: `exchange`, bi-temporal as-of enabled  
Artifacts: `apps/api/bench/runs/2026-06-01T12-15-22-741Z-dghw6f7o/`

Environment check before running:

- `DATABASE_URL`: set
- `AI_GATEWAY_API_KEY`: set

Note: `.env.local` was absent, so the root `scripts/env.sh` wrapper could not be used. The bench was invoked through the package script directly so it used the provisioned process environment.

## Aggregate scores

Overall:

- QA accuracy: 1/5 = 20%
- Non-abstention QA accuracy: 0/4 = 0%
- Retrieval recall@15 mean coverage: (1.0 + 0.5 + 0 + 0) / 4 = 37.5%
- Retrieval recall@15 full-coverage rate: 1/4 = 25%
- Abstention accuracy: 1/1 = 100%

Per category:

| Category | QA n | QA correct | QA % | Recall n | Recall full | Recall mean coverage |
|---|---:|---:|---:|---:|---:|---:|
| single_hop | 1 | 0 | 0% | 1 | 1 | 100% |
| multi_hop | 1 | 0 | 0% | 1 | 0 | 50% |
| temporal | 1 | 0 | 0% | 1 | 0 | 0% |
| knowledge_update | 1 | 0 | 0% | 1 | 0 | 0% |
| abstention | 1 | 1 | 100% | - | - | - |

## Recall-miss vs QA-miss split

From `failures.jsonl`:

| Category | QA misses | Recall misses | Notes |
|---|---:|---:|---|
| temporal | 1 | 1 | No memories retrieved. |
| single_hop | 1 | 0 | Recall credited the evidence session, but QA still abstained. |
| knowledge_update | 1 | 1 | Retrieved memories did not cover the updated evidence session. |
| multi_hop | 1 | 1 | Retrieved one of two evidence sessions, coverage 50%. |
| abstention | 0 | 0 | Correctly answered `I don't know.` |
| **Total failure records** | **4** | **3** | 7 JSONL failure lines total. |

Distinct failed cases:

- 3 cases were both QA misses and recall misses: `toy-temporal-1`, `toy-knowledge-update-1`, `toy-multi-hop-1`.
- 1 case was a QA-only miss: `toy-single-hop-1`.
- 0 cases were recall-only misses.

## Failure clusters

### 1. Final user-turn evidence is not being extracted under exchange replay

**Failure mode:** The toy conversations place the answer-bearing fact in the final user turn (`S*:3`), but exchange replay runs extraction on assistant replies and the stored memories from the diagnostic persistent run only covered the preceding turns (`S*:1`, `S*:2`).

Examples from `failures.jsonl`:

1. `toy-temporal-1` / recall miss
   - Question: `When did Alex start the new job at Stripe?`
   - Gold: `["March 2024","Mar 2024","03/2024","2024-03"]`
   - Predicted: `I don't know.`
   - Judge rationale: `coverage 0% - The model answered 'I don't know' which does not match the gold answer of March 2024. This is not an abstention case.`
2. `toy-knowledge-update-1` / recall miss
   - Question: `Which database does the team use in production?`
   - Gold: `["Postgres","PostgreSQL"]`
   - Predicted: `I don't know.`
   - Judge rationale: `coverage 0% - The model answered 'I don't know' instead of providing the correct answer 'Postgres/PostgreSQL', which is incorrect for a non-abstention question.`
3. `toy-multi-hop-1` / recall miss
   - Question: `Where does Alex's new colleague live?`
   - Gold: `["Berlin"]`
   - Predicted: `I don't know.`
   - Judge rationale: `coverage 50% - The model answered 'I don't know' which does not match the gold answer of 'Berlin'. This is not an abstention case.`

Diagnostic evidence:

- `toy.json` puts the temporal, knowledge-update, and multi-hop answer facts in `S1:3` or `S2:3`.
- The persistent diagnostic toy run left only these answer-lacking memories in `bench-local-diagnostic-toy`:
  - `Alex wants to fly to Lisbon next month.` with provenance `diaIds: ["S1:1","S1:2"]`
  - `The team is prototyping a new service on MongoDB.` with provenance `diaIds: ["S1:1","S1:2"]`
  - `Alex is joining a new project at work.` with provenance `diaIds: ["S1:1","S1:2"]`

Hypothesis: This is primarily an extraction/timeline mismatch between the toy corpus shape and exchange replay. In production, extraction is triggered after Aura responds, but these toy facts appear after the final user message with no subsequent assistant turn to trigger a window that includes them.

Suggested direction: Retrieval-side/extraction-side investigation: decide whether the benchmark should add a final extraction tick for trailing user turns, or whether the toy corpus should include an assistant reply after answer-bearing user turns.

### 2. Session-level recall can over-credit retrieval when the retrieved memory is not answer-bearing

**Failure mode:** Recall can pass because a retrieved memory has the right `sourceThreadTs`/session provenance, even when the memory content was extracted from earlier turns in that session and lacks the answer.

Examples from `failures.jsonl`:

1. `toy-single-hop-1` / QA miss with recall hit
   - Question: `What is Alex's dog's name?`
   - Gold: `["Pepper"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' which does not match the gold answer 'Pepper', and this is not an abstention case.`
   - Retrieved memories: 2 IDs; retrieval coverage was 100%.
2. `toy-multi-hop-1` / QA miss with partial recall
   - Question: `Where does Alex's new colleague live?`
   - Gold: `["Berlin"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' which does not match the gold answer of 'Berlin'. This is not an abstention case.`
   - Retrieved memories: 3 IDs; retrieval coverage was 50%.

Hypothesis: The recall scorer is session-coverage based. For toy cases where the evidence pointer is turn-level (`S1:3`) but the memory provenance covers only `S1:1,S1:2`, the session-level fallback can say "retrieval worked" even though the answerer never saw the answer. This makes the `single_hop` failure look answerer-side in the aggregate, but the concrete records point back to extraction/provenance granularity.

Suggested direction: Retrieval-side/eval-side investigation: prefer turn-level provenance for toy/LoCoMo-style evidence when available, or separately flag "session hit but evidence dia_id not covered."

### 3. The answerer is faithfully abstaining when the memory block lacks the needed fact

**Failure mode:** In every non-abstention QA miss, the model answered `I don't know.` rather than hallucinating; that is wrong for the gold question but consistent with the constrained answerer prompt when retrieved memories lack the answer.

Examples from `failures.jsonl`:

1. `toy-single-hop-1` / QA miss
   - Gold: `["Pepper"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' which does not match the gold answer 'Pepper', and this is not an abstention case.`
2. `toy-knowledge-update-1` / QA miss
   - Gold: `["Postgres","PostgreSQL"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' instead of providing the correct answer 'Postgres/PostgreSQL', which is incorrect for a non-abstention question.`
3. `toy-multi-hop-1` / QA miss
   - Gold: `["Berlin"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' which does not match the gold answer of 'Berlin'. This is not an abstention case.`

Hypothesis: These are not obvious answerer hallucination or reasoning failures. The answerer appears to obey `Answer ONLY from the provided memories` and abstains when the retrieved memory text is insufficient. The upstream extraction/retrieval path is likely starving the answerer of answer-bearing evidence.

Suggested direction: Retrieval-side/extraction-side first; answerer-side changes should wait until a run confirms the answer-bearing memory text is actually injected and still not used.

### 4. Knowledge-update scoring fails before the "use the later fact" behavior is tested

**Failure mode:** The knowledge-update case never retrieved/created the updated Postgres fact, so the run did not meaningfully test whether the answerer can prefer the later value over the obsolete MongoDB value.

Examples from `failures.jsonl`:

1. `toy-knowledge-update-1` / recall miss
   - Question: `Which database does the team use in production?`
   - Gold: `["Postgres","PostgreSQL"]`
   - Predicted: `I don't know.`
   - Judge rationale: `coverage 0% - The model answered 'I don't know' instead of providing the correct answer 'Postgres/PostgreSQL', which is incorrect for a non-abstention question.`
2. `toy-knowledge-update-1` / QA miss
   - Question: `Which database does the team use in production?`
   - Gold: `["Postgres","PostgreSQL"]`
   - Predicted: `I don't know.`
   - Judge rationale: `The model answered 'I don't know' instead of providing the correct answer 'Postgres/PostgreSQL', which is incorrect for a non-abstention question.`

Diagnostic evidence:

- The persistent diagnostic run stored `The team is prototyping a new service on MongoDB.` with provenance `S1:1,S1:2`.
- It did not store the later corpus fact from `S2:3`: `Production runs on Postgres now...`

Hypothesis: The failure is upstream of stale-vs-fresh reasoning. Because no extraction call saw the later final user turn, the answerer did not face a MongoDB-vs-Postgres conflict; it simply lacked the updated fact.

Suggested direction: Retrieval-side/extraction-side: get the later evidence into memory before evaluating answerer-side knowledge-update handling.

## Judge/eval artifacts vs real model failures

- The judge decisions look correct for the inputs it saw. It consistently marked non-abstention `I don't know.` answers as incorrect and the abstention case as `abstain_ok`.
- The biggest eval artifact is recall scoring, not judge grading: `single_hop` reports 100% recall even though the retrieved memory set did not let the answerer answer `Pepper`. That makes the QA lane look answerer-side unless failures are read with provenance/content in mind.
- `multi_hop` recall at 50% is informative: it shows one evidence session was represented, but the missing `Berlin` hop was not.
- The toy run is therefore currently diagnosing the producer/extraction timing more than the downstream answerer. Any answerer-side conclusion from this run should be treated as weak until answer-bearing memories are actually retrieved.
