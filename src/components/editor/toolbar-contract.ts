export type ResetDeckAction = {
  id: "active-deck";
  label: string;
};

export function getResetDeckActions(deviceLabel: string): ResetDeckAction[] {
  return [
    {
      id: "active-deck",
      label: `Reset active ${deviceLabel} deck`,
    },
  ];
}
