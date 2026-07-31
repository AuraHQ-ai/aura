import { renderMdx } from "@/lib/mdx";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const metadata = {
  title: "Data Handling — Aura",
  description: "How Aura stores, secures, and isolates your workspace data.",
};

export default async function DataHandlingPage() {
  const filePath = path.resolve(process.cwd(), "..", "..", "content", "legal", "data-handling.mdx");
  const source = await readFile(filePath, "utf-8");
  const content = await renderMdx(source);

  return (
    <div className="site-inner">
      <div style={{ padding: "64px 0 48px", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "12px" }}>
          Legal
        </p>
        <h1 style={{ fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text-primary)", margin: 0 }}>
          Data Handling
        </h1>
      </div>
      <div style={{ padding: "48px 0", maxWidth: "720px" }} className="prose">
        {content}
      </div>
    </div>
  );
}
