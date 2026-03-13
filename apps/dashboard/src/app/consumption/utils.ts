export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  return cost < 0.01 ? "< $0.01" : `$${cost.toFixed(2)}`;
}
