export interface BudgetCheckResult {
  ok: boolean;
  used: number;
  max: number;
  remaining: number;
  required: number;
  shortfall: number;
}

export function checkTurnBudget(used: number, max: number, required: number): BudgetCheckResult {
  const remaining = Math.max(0, max - used);
  const ok = remaining >= required;
  return {
    ok,
    used,
    max,
    remaining,
    required,
    shortfall: ok ? 0 : required - remaining,
  };
}
