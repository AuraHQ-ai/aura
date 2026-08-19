import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System default" },
] as const;

export function ThemeSelect({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const value = theme ?? "system";

  return (
    <Select value={value} onValueChange={(nextTheme) => setTheme(nextTheme)}>
      <SelectTrigger
        className={cn("w-full", className)}
        aria-label="Theme preference"
      >
        <SelectValue placeholder="Select theme" />
      </SelectTrigger>
      <SelectContent align="end">
        {themeOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ThemeToggle() {
  return (
    <ThemeSelect
      className="w-[180px]"
    />
  );
}
