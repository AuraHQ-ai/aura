import type { MDXComponents } from "mdx/types";

type CalloutProps = {
  type?: "note" | "warning" | "success";
  title?: string;
  children: React.ReactNode;
};

function Callout({ type = "note", title, children }: CalloutProps) {
  const classes: Record<NonNullable<CalloutProps["type"]>, string> = {
    note: "border-blue-500/40 bg-blue-500/10",
    warning: "border-yellow-500/40 bg-yellow-500/10",
    success: "border-green-500/40 bg-green-500/10",
  };

  return (
    <div className={`my-6 rounded-xl border p-4 ${classes[type]}`}>
      {title ? <p className="mb-2 text-sm font-semibold text-white">{title}</p> : null}
      <div className="text-sm text-neutral-200">{children}</div>
    </div>
  );
}

export const mdxComponents: MDXComponents = {
  Callout,
};
