import { calculateNextDueDate } from '../../src/utils/recurrence';

describe('Recurrence Logic Unit Tests', () => {
  test('anchors due date without drift on normal completion', () => {
    const prevDue = new Date('2026-11-01T10:00:00Z');
    const completedAt = new Date('2026-11-02T12:00:00Z'); // 1 day late on a 7-day task
    const nextDue = calculateNextDueDate(prevDue, 7, completedAt);

    expect(nextDue.toISOString()).toBe(new Date('2026-11-08T10:00:00Z').toISOString());
  });

  test('uses default parameter if completedAt is omitted', () => {
    const prevDue = new Date();
    prevDue.setDate(prevDue.getDate() - 2); // 2 days ago
    const nextDue = calculateNextDueDate(prevDue, 7);
    expect(nextDue.getTime()).toBeGreaterThan(Date.now());
  });

  test('rolls forward by whole periods if missed by multiple cycles', () => {
    const prevDue = new Date('2026-10-01T10:00:00Z');
    const completedAt = new Date('2026-11-10T10:00:00Z'); // Missed multiple 7-day cycles
    const nextDue = calculateNextDueDate(prevDue, 7, completedAt);

    expect(nextDue.getTime()).toBeGreaterThan(completedAt.getTime());
    const diffDays = (nextDue.getTime() - prevDue.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays % 7).toBe(0);
  });
});
