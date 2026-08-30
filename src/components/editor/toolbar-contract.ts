export type ResetDeckAction = {
  id: "active-deck";
  label: string;
};

const DEFAULT_SELECTABLE_LOCALES = ["en", "de"] as const;

export function getSelectableLocales(locales: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const locale of [...locales, ...DEFAULT_SELECTABLE_LOCALES]) {
    const trimmed = locale.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function getResetDeckActions(deviceLabel: string): ResetDeckAction[] {
  return [
    {
      id: "active-deck",
      label: `Reset active ${deviceLabel} deck`,
    },
  ];
}
