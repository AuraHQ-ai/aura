import type { MDXComponents } from "mdx/types";

function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  if (!className) {
    return (
      <code
        className="rounded bg-neutral-800 px-1.5 py-0.5 text-sm text-neutral-200"
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
        <p className="mb-2 text-sm font-semibold text-white">{title}</p>
      )}
      <div className="text-sm text-neutral-200">{children}</div>
    </div>
  );
}

export const mdxComponents: MDXComponents = {
  code: CodeBlock,
  Callout,
  h1: (props) => (
    <h1 className="mt-12 mb-4 text-3xl font-bold tracking-tight" {...props} />
  ),
  h2: (props) => (
    <h2
      className="mt-10 mb-4 text-2xl font-semibold tracking-tight"
      {...props}
    />
  ),
  h3: (props) => (
    <h3 className="mt-8 mb-3 text-xl font-semibold" {...props} />
  ),
  a: (props) => (
    <a
      className="text-blue-400 underline decoration-blue-400/30 underline-offset-4 transition hover:decoration-blue-400"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote
      className="my-6 border-l-2 border-neutral-700 pl-6 italic text-neutral-400"
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full text-left text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="border-b border-neutral-700 px-4 py-2 font-semibold text-neutral-200"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="border-b border-neutral-800 px-4 py-2 text-neutral-400"
      {...props}
    />
  ),
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="my-6 rounded-lg" alt="" {...props} />
  ),
};
