import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ModelAutocompleteOption {
  value: string
  label: string
  provider?: string
}

interface ModelAutocompleteGroup {
  providerKey: string
  providerLabel: string
  options: ModelAutocompleteOption[]
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  azure: "Azure",
  deepseek: "DeepSeek",
  github: "GitHub",
  "github-copilot": "GitHub Copilot",
  "github-models": "GitHub Models",
  google: "Google",
  mistral: "Mistral",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  xai: "xAI",
}

function inferProvider(option: ModelAutocompleteOption): string {
  return option.provider || option.value.split("/")[0] || "other"
}

function formatProviderLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ||
    provider
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ")
  )
}

function groupOptions(
  options: ModelAutocompleteOption[],
): ModelAutocompleteGroup[] {
  const deduped = new Map<string, ModelAutocompleteOption>()
  for (const option of options) {
    deduped.set(option.value, option)
  }

  const groups = new Map<string, ModelAutocompleteGroup>()

  for (const option of deduped.values()) {
    const providerKey = inferProvider(option)
    const existing = groups.get(providerKey)

    if (existing) {
      existing.options.push(option)
      continue
    }

    groups.set(providerKey, {
      providerKey,
      providerLabel: formatProviderLabel(providerKey),
      options: [option],
    })
  }

  return Array.from(groups.values())
}

function getSelectedLabel(
  value: string,
  options: ModelAutocompleteOption[],
  pinnedOptions: ModelAutocompleteOption[],
) {
  return [...pinnedOptions, ...options].find((option) => option.value === value)
    ?.label
}

export interface ModelAutocompleteProps {
  value: string
  onValueChange: (value: string) => void
  options: ModelAutocompleteOption[]
  pinnedOptions?: ModelAutocompleteOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  fullWidth?: boolean
  triggerVariant?: React.ComponentProps<typeof Button>["variant"]
  triggerClassName?: string
  contentClassName?: string
  align?: React.ComponentProps<typeof PopoverContent>["align"]
  side?: React.ComponentProps<typeof PopoverContent>["side"]
}

export function ModelAutocomplete({
  value,
  onValueChange,
  options,
  pinnedOptions = [],
  placeholder = "Select model...",
  searchPlaceholder = "Search models...",
  emptyMessage = "No models found.",
  disabled = false,
  fullWidth = true,
  triggerVariant = "outline",
  triggerClassName,
  contentClassName,
  align = "start",
  side,
}: ModelAutocompleteProps) {
  const [open, setOpen] = useState(false)

  const groupedOptions = useMemo(() => groupOptions(options), [options])
  const selectedLabel = useMemo(
    () => getSelectedLabel(value, options, pinnedOptions),
    [value, options, pinnedOptions],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            fullWidth ? "w-full justify-between" : "justify-between",
            "cursor-pointer font-normal",
            !selectedLabel && "text-muted-foreground",
            triggerClassName,
          )}
        >
          <span className="truncate">{selectedLabel || placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        className={cn("w-[--radix-popover-trigger-width] p-0", contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>

            {pinnedOptions.length > 0 && (
              <>
                <CommandGroup>
                  {pinnedOptions.map((option) => (
                    <CommandItem
                      key={option.value}
                      className="cursor-pointer"
                      value={`${option.label} ${option.value}`}
                      onSelect={() => {
                        onValueChange(option.value)
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          value === option.value ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{option.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {groupedOptions.length > 0 && <CommandSeparator />}
              </>
            )}

            {groupedOptions.map((group) => (
              <CommandGroup key={group.providerKey} heading={group.providerLabel}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    className="cursor-pointer"
                    value={`${option.label} ${option.value} ${group.providerLabel} ${group.providerKey}`}
                    onSelect={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        "size-4",
                        value === option.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
