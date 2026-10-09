// Producer-specific budget profiles are never accepted by this distribution.
// Ordinary generation remains governed by the application's per-task authorization.
export function openBudget(task, profilePath = process.env.MANJU_BATCH_BUDGET_PROFILE) {
  if (profilePath) throw new Error('This distribution does not accept producer-only budget profiles');
  return undefined;
}
