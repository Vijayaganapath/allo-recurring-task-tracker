/**
 * Recurrence logic utilities for calculating next cycle due dates
 */
export function calculateNextDueDate(previousDue: Date, frequencyDays: number, completedAt: Date = new Date()): Date {
  const next = new Date(previousDue);
  next.setDate(next.getDate() + frequencyDays);

  // If the task was missed by more than one cycle, roll forward in whole periods until it is after completedAt
  while (next <= completedAt) {
    next.setDate(next.getDate() + frequencyDays);
  }

  return next;
}
