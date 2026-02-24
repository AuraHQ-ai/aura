import { describe, it, expect } from "vitest";
import { stripHtml, isPrivateUrl } from "../tools/web.js";

describe("stripHtml", () => {
  it("strips <script> tags and their content", () => {
    expect(stripHtml('<script>alert("xss")</script>hello')).toBe("hello");
  });

  it("strips <style> tags and their content", () => {
    expect(stripHtml("<style>body{color:red}</style>hello")).toBe("hello");
  });

  it("replaces HTML tags with spaces", () => {
    expect(stripHtml("<p>hello</p><p>world</p>")).toBe("hello world");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;")).toBe("& < > \" '");
  });

  it("collapses multiple whitespace into single spaces", () => {
    expect(stripHtml("hello    world")).toBe("hello world");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripHtml("  <p>  hello  </p>  ")).toBe("hello");
  });

  it("empty string returns empty string", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("isPrivateUrl", () => {
  it("returns true for localhost", async () => {
    expect(await isPrivateUrl("http://localhost/test")).toBe(true);
  });

  it("returns true for 127.0.0.1", async () => {
    expect(await isPrivateUrl("http://127.0.0.1/path")).toBe(true);
  });

  it("returns true for 10.x.x.x", async () => {
    expect(await isPrivateUrl("http://10.0.0.1/path")).toBe(true);
  });

  it("returns true for 192.168.x.x", async () => {
    expect(await isPrivateUrl("http://192.168.1.1/path")).toBe(true);
  });

  it("returns true for 172.16.x.x", async () => {
    expect(await isPrivateUrl("http://172.16.0.1/path")).toBe(true);
  });

  it("returns true for [::1]", async () => {
    expect(await isPrivateUrl("http://[::1]/path")).toBe(true);
  });

  it("returns true for .local domains", async () => {
    expect(await isPrivateUrl("http://foo.local/test")).toBe(true);
  });

  it("returns true for .internal domains", async () => {
    expect(await isPrivateUrl("http://foo.internal/test")).toBe(true);
  });

  it("returns true for 0.0.0.0", async () => {
    expect(await isPrivateUrl("http://0.0.0.0/test")).toBe(true);
  });

  it("returns false for google.com", async () => {
    expect(await isPrivateUrl("http://google.com")).toBe(false);
  });

  it("returns true for unparseable URLs", async () => {
    expect(await isPrivateUrl("not a url")).toBe(true);
  });
});
