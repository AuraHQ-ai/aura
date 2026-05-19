import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migrationSql = readFileSync(
  new URL("../../../../packages/db/drizzle/0064_enforce_credential_scope_check.sql", import.meta.url),
  "utf8",
);

describe("credential scope migration", () => {
  it("reinstalls the scope check constraint idempotently", () => {
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS "credentials_scope_check"');
    expect(migrationSql).toContain('ADD CONSTRAINT "credentials_scope_check"');
  });

  it("allows only known credential scopes", () => {
    expect(migrationSql).toContain(
      "\"scope\" IN ('member', 'power_user', 'admin', 'owner', 'per_user')",
    );
    expect(migrationSql).not.toContain("typo_scope");
  });
});
