// Wizard step order. Pure, so it can be tested without a DOM.
export const STEP_LABELS = ['Install', 'Providers & keys', 'Models', 'GitHub', 'Repos to watch', 'Review'] as const;
export const STEP = { install: 0, providers: 1, models: 2, github: 3, repos: 4, review: 5 } as const;
export type SetupPath = 'minimal' | 'custom';

/** Minimal install skips Models, GitHub and Repos (all reachable from Review and Settings). */
export function nextStep(step: number, path: SetupPath): number {
  if (path === 'minimal' && step === STEP.providers) return STEP.review;
  return Math.min(step + 1, STEP.review);
}

export function previousStep(step: number, path: SetupPath): number {
  if (path === 'minimal' && (step === STEP.review || step === STEP.models)) return STEP.providers;
  // Optional steps opened from the minimal Review card go back to Review.
  if (path === 'minimal' && step === STEP.github) return STEP.review;
  return Math.max(step - 1, 0);
}
