import type { MDXComponents } from "mdx/types";

function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  if (!className) {
    return (
      <code
        style={{
          background: "var(--code-bg)",
          color: "var(--code-color)",
          border: "1px solid var(--code-border)",
          borderRadius: "4px",
          padding: "2px 6px",
          fontSize: "0.875em",
        }}
        {...props}
      >
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function Callout({
  children,
  title,
  type = "note",
}: {
  children: React.ReactNode;
  title?: string;
  type?: "note" | "warning" | "success";
}) {
  const styles: Record<NonNullable<typeof type>, string> = {
    note: "border-blue-500/30 bg-blue-500/5",
    warning: "border-yellow-500/30 bg-yellow-500/5",
    success: "border-green-500/30 bg-green-500/5",
  };

  return (
    <div className={`my-6 rounded-xl border-l-4 px-6 py-4 ${styles[type]}`}>
      {title && (
        <p className="mb-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</p>
      )}
      <div className="text-sm" style={{ color: "var(--text-secondary)" }}>{children}</div>
    </div>
  );
}

function TableWrapper(props: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="my-6 overflow-x-auto">
      <table {...props} />
    </div>
  );
}

export const mdxComponents: MDXComponents = {
  code: CodeBlock,
  Callout,
  table: TableWrapper,
};
