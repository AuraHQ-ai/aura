/**
 * Standalone test for circuit breaker logic.
 * Run: npx tsx src/pipeline/__tests__/circuit-breaker.test.ts
 */
import {
  normalizeCommand,
  extractEndpoints,
  detectCircuitBreaker,
  type CommandFailureRecord,
} from "../circuit-breaker.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ── normalizeCommand ─────────────────────────────────────────────────────────

console.log("\nnormalizeCommand:");

assert(
  normalizeCommand("curl https://api.example.com # retry 1") ===
    normalizeCommand("curl https://api.example.com # retry 2"),
  "strips trailing comments",
);

assert(
  normalizeCommand("curl   https://api.example.com") ===
    normalizeCommand("curl https://api.example.com"),
  "collapses whitespace",
);

assert(
  normalizeCommand("echo 'hello # world'") === "echo 'hello # world'",
  "preserves # inside single quotes",
);

assert(
  normalizeCommand('echo "hello # world"') === 'echo "hello # world"',
  "preserves # inside double quotes",
);

assert(
  normalizeCommand("# full comment line\ncurl https://example.com") ===
    "curl https://example.com",
  "strips full comment lines",
);

assert(
  normalizeCommand("curl \\\n  https://api.example.com \\\n  -H 'Auth: x' # attempt 1") ===
    normalizeCommand("curl \\\n  https://api.example.com \\\n  -H 'Auth: x' # attempt 5"),
  "multiline commands with different comments normalize equally",
);

// ── extractEndpoints ─────────────────────────────────────────────────────────

console.log("\nextractEndpoints:");

assert(
  extractEndpoints("curl https://api.elevenlabs.io/v1/text-to-speech")[0] ===
    "https://api.elevenlabs.io/v1/text-to-speech",
  "extracts simple URL",
);

assert(
  extractEndpoints("curl 'https://api.example.com/v1/users?page=1&limit=10'")[0] ===
    "https://api.example.com/v1/users",
  "strips query parameters from endpoint",
);

assert(
  extractEndpoints("echo no urls here").length === 0,
  "returns empty array when no URLs",
);

assert(
  extractEndpoints(
    "curl https://api.a.com/v1 && curl https://api.b.com/v2",
  ).length === 2,
  "extracts multiple URLs",
);

// ── detectCircuitBreaker ─────────────────────────────────────────────────────

console.log("\ndetectCircuitBreaker:");

assert(
  !detectCircuitBreaker([]).triggered,
  "no trigger on empty failures",
);

assert(
  !detectCircuitBreaker([
    { normalizedCommand: "curl https://x.com", endpoints: ["https://x.com"] },
    { normalizedCommand: "curl https://x.com", endpoints: ["https://x.com"] },
  ]).triggered,
  "no trigger below threshold (2 failures)",
);

// Test case from the issue: 4 consecutive failures with same URL, different comments
const elevenLabsFailures: CommandFailureRecord[] = [
  {
    normalizedCommand: normalizeCommand(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx' # attempt 1",
    ),
    endpoints: extractEndpoints(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx'",
    ),
  },
  {
    normalizedCommand: normalizeCommand(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx' # retry attempt 2",
    ),
    endpoints: extractEndpoints(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx'",
    ),
  },
  {
    normalizedCommand: normalizeCommand(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx' # third try",
    ),
    endpoints: extractEndpoints(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx'",
    ),
  },
  {
    normalizedCommand: normalizeCommand(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx' # last attempt",
    ),
    endpoints: extractEndpoints(
      "curl -X POST https://api.elevenlabs.io/v1/text-to-speech -H 'xi-api-key: xxx'",
    ),
  },
];

const result3 = detectCircuitBreaker(elevenLabsFailures.slice(0, 3));
assert(
  result3.triggered,
  "triggers after 3rd failure with same endpoint (ElevenLabs scenario)",
);
assert(
  result3.message!.includes("CIRCUIT BREAKER"),
  "message contains CIRCUIT BREAKER label",
);

const result4 = detectCircuitBreaker(elevenLabsFailures);
assert(
  result4.triggered,
  "triggers after 4th failure with same endpoint",
);

// Similar commands (same normalized, different comments)
assert(
  detectCircuitBreaker(elevenLabsFailures).message!.includes(
    "semantically identical",
  ),
  "identifies semantically identical commands (same normalized form)",
);

// Different commands but same endpoint
const sameEndpointDiffCommands: CommandFailureRecord[] = [
  {
    normalizedCommand: "curl -X GET https://api.elevenlabs.io/v1/voices",
    endpoints: ["https://api.elevenlabs.io/v1/voices"],
  },
  {
    normalizedCommand: "curl -X POST https://api.elevenlabs.io/v1/voices -d '{}'",
    endpoints: ["https://api.elevenlabs.io/v1/voices"],
  },
  {
    normalizedCommand: "wget https://api.elevenlabs.io/v1/voices",
    endpoints: ["https://api.elevenlabs.io/v1/voices"],
  },
];

const endpointResult = detectCircuitBreaker(sameEndpointDiffCommands);
assert(
  endpointResult.triggered,
  "triggers on same endpoint with different commands",
);
assert(
  endpointResult.message!.includes("api.elevenlabs.io"),
  "message mentions the failing endpoint",
);

// General consecutive failures (different commands, different endpoints)
const generalFailures: CommandFailureRecord[] = [
  {
    normalizedCommand: "apt-get install foo",
    endpoints: [],
  },
  {
    normalizedCommand: "pip install bar",
    endpoints: [],
  },
  {
    normalizedCommand: "npm install baz",
    endpoints: [],
  },
];

const generalResult = detectCircuitBreaker(generalFailures);
assert(
  generalResult.triggered,
  "triggers on 3 consecutive failures even with different commands",
);
assert(
  generalResult.message!.includes("consecutive run_command"),
  "uses general failure message for diverse commands",
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
