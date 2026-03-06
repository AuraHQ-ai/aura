"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

const themes = [
  { value: "light",  label: "Light",  Icon: Sun },
  { value: "dark",   label: "Dark",   Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // Avoid hydration mismatch — render nothing until client
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ width: 28, height: 28 }} />;

  const current = themes.find((t) => t.value === theme) ?? themes[2];
  const CurrentIcon = current.Icon;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          aria-label="Toggle theme"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: 6,
            border: "1px solid var(--col-border)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--text-secondary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--col-border)";
          }}
        >
          <CurrentIcon size={13} strokeWidth={1.75} />
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          style={{
            minWidth: 120,
            background: "var(--bg)",
            border: "1px solid var(--col-border)",
            borderRadius: 8,
            padding: "4px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 100,
          }}
        >
          {themes.map(({ value, label, Icon }) => (
            <DropdownMenuPrimitive.Item
              key={value}
              onSelect={() => setTheme(value)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                borderRadius: 5,
                fontSize: 13,
                cursor: "pointer",
                outline: "none",
                color: theme === value ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: theme === value ? 500 : 400,
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--bg-subtle)";
                (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color =
                  theme === value ? "var(--text-primary)" : "var(--text-secondary)";
              }}
            >
              <Icon size={13} strokeWidth={1.75} style={{ opacity: theme === value ? 1 : 0.6 }} />
              {label}
              {theme === value && (
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>✓</span>
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
