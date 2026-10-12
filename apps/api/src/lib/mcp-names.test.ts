import { describe, expect, it } from "vitest";
import {
  isMcpServerAllowlisted,
  isMcpToolName,
  isWriteLikeMcpTool,
  mcpEnvAllowlistName,
  namespaceMcpTool,
  parseNamespacedMcpTool,
  slugifyMcpName,
} from "./mcp-names.js";

describe("MCP tool namespacing", () => {
  it("builds mcp__<slug>__<tool> names", () => {
    expect(namespaceMcpTool("stripe", "list_customers")).toBe(
      "mcp__stripe__list_customers",
    );
    expect(namespaceMcpTool("linear", "create-issue")).toBe("mcp__linear__create-issue");
  });

  it("sanitizes unsafe characters in the tool name", () => {
    expect(namespaceMcpTool("notion", "db.query/v2")).toBe("mcp__notion__db_query_v2");
  });

  it("parses a namespaced name back into slug + tool", () => {
    expect(parseNamespacedMcpTool("mcp__stripe__list_customers")).toEqual({
      slug: "stripe",
      tool: "list_customers",
    });
    expect(parseNamespacedMcpTool("mcp__my_server__foo__bar")).toEqual({
      slug: "my_server",
      tool: "foo__bar",
    });
    expect(parseNamespacedMcpTool("list_customers")).toBeNull();
  });

  it("slugifies hostnames and display names", () => {
    expect(slugifyMcpName("https://mcp.stripe.com/mcp")).toBe("mcp_stripe_com_mcp");
    expect(slugifyMcpName("Stripe Billing")).toBe("stripe_billing");
    expect(slugifyMcpName("123-start")).toBe("s_123_start");
  });

  it("identifies MCP tool names and job allowlist entries", () => {
    expect(isMcpToolName("mcp__stripe__list_customers")).toBe(true);
    expect(isMcpToolName("mcp_list_servers")).toBe(false);
    expect(mcpEnvAllowlistName("stripe")).toBe("mcp:stripe");
    expect(isMcpServerAllowlisted("stripe", ["mcp:stripe"])).toBe(true);
    expect(isMcpServerAllowlisted("stripe", ["GITHUB_TOKEN"])).toBe(false);
    expect(isMcpServerAllowlisted("stripe", undefined)).toBe(false);
  });

  it("treats write-like tools as needing approval unless readOnlyHint", () => {
    expect(isWriteLikeMcpTool("create_customer")).toBe(true);
    expect(isWriteLikeMcpTool("list_customers")).toBe(false);
    expect(isWriteLikeMcpTool("create_customer", { readOnlyHint: true })).toBe(false);
    expect(isWriteLikeMcpTool("list_customers", { readOnlyHint: false })).toBe(true);
  });
});
