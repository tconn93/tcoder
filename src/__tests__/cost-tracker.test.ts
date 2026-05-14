import { describe, test, expect, beforeEach } from 'bun:test';
import { CostTracker, getModelPricing } from '../cost-tracker.ts';

describe('getModelPricing', () => {
  test('returns known model pricing', () => {
    const p = getModelPricing('grok-4.3');
    expect(p.inputPerM).toBe(5.0);
    expect(p.outputPerM).toBe(15.0);
  });

  test('falls back to prefix match', () => {
    const p = getModelPricing('grok-4.3-turbo');
    expect(p.inputPerM).toBe(5.0);
  });

  test('falls back to defaults for unknown model', () => {
    const p = getModelPricing('unknown-model-xyz');
    expect(p.inputPerM).toBeGreaterThan(0);
    expect(p.outputPerM).toBeGreaterThan(0);
  });
});

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  test('starts with empty session', () => {
    const cost = tracker.getSessionCost();
    expect(cost.turnCount).toBe(0);
    expect(cost.totalTokens).toBe(0);
    expect(cost.totalCostCents).toBe(0);
  });

  test('recordTurn accumulates tokens', () => {
    tracker.recordTurn('grok-4.3', { inputTokens: 1000, outputTokens: 500 });
    const cost = tracker.getSessionCost();
    expect(cost.turnCount).toBe(1);
    expect(cost.totalInputTokens).toBe(1000);
    expect(cost.totalOutputTokens).toBe(500);
    expect(cost.totalTokens).toBe(1500);
  });

  test('multiple turns accumulate correctly', () => {
    tracker.recordTurn('grok-4.3', { inputTokens: 100, outputTokens: 50 });
    tracker.recordTurn('grok-4.3', { inputTokens: 200, outputTokens: 100 });
    const cost = tracker.getSessionCost();
    expect(cost.turnCount).toBe(2);
    expect(cost.totalInputTokens).toBe(300);
    expect(cost.totalOutputTokens).toBe(150);
  });

  test('reset clears all data', () => {
    tracker.recordTurn('grok-4.3', { inputTokens: 1000, outputTokens: 500 });
    tracker.reset();
    const cost = tracker.getSessionCost();
    expect(cost.turnCount).toBe(0);
    expect(cost.totalTokens).toBe(0);
  });

  test('getSessionSummary returns non-empty string', () => {
    tracker.recordTurn('grok-4.3', { inputTokens: 1000, outputTokens: 500 });
    const summary = tracker.getSessionSummary();
    expect(summary).toContain('Turns: 1');
    expect(summary).toContain('Total tokens');
  });

  test('getTotalCostFormatted formats cents correctly', () => {
    // 1M input tokens at $5/M = 500 cents
    tracker.recordTurn('grok-4.3', { inputTokens: 1_000_000, outputTokens: 0 });
    const formatted = tracker.getTotalCostFormatted();
    expect(formatted).toMatch(/\$|\d+c/);
  });
});
