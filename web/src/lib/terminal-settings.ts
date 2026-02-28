import type { TerminalSettings } from "./types";

const SETTINGS_KEY = "terminal-settings";

const defaults: TerminalSettings = {
  edgeThreshold: 10,
  sizingMode: "contracts",
  betAmount: 10,
};

export function loadTerminalSettings(): TerminalSettings {
  if (typeof window === "undefined") return defaults;

  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...defaults };

  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Compute the number of contracts to buy given the price per contract.
 * In "contracts" mode, returns betAmount directly (as whole contracts).
 * In "dollars" mode, computes floor(betAmount / price) to stay under budget.
 * Matches the Rust implementation: AppSettings::compute_contract_count()
 */
export function computeContractCount(
  settings: TerminalSettings,
  priceDollars: number
): number {
  if (settings.sizingMode === "contracts") {
    return Math.max(1, Math.floor(settings.betAmount));
  }

  if (priceDollars <= 0) return 1;
  return Math.max(1, Math.floor(settings.betAmount / priceDollars));
}
