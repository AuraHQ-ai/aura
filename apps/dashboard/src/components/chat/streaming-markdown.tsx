"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

interface StreamingMarkdownProps {
  children: string;
}

export function StreamingMarkdown({ children }: StreamingMarkdownProps) {
  return (
    <Streamdown
      plugins={{ code }}
      shikiTheme={["github-light", "github-dark"]}
      controls={false}
    >
      {children}
    </Streamdown>
  );
}
