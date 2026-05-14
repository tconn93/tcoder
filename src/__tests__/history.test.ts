import { describe, test, expect } from 'bun:test';
import {
  generateSessionTitle,
  shouldCompact,
  shouldCompactAggressively,
  compactMessages,
} from '../history.ts';
import type { Message } from '../types/message.ts';

const makeUser = (content: string): Message => ({
  type: 'user',
  role: 'user',
  content,
});

describe('generateSessionTitle', () => {
  test('uses first user message as title', () => {
    const msgs: Message[] = [makeUser('Fix the login bug')];
    expect(generateSessionTitle(msgs)).toBe('Fix the login bug');
  });

  test('truncates long messages', () => {
    const long = 'a'.repeat(100);
    const title = generateSessionTitle([makeUser(long)]);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('...')).toBe(true);
  });

  test('returns fallback for empty messages', () => {
    expect(generateSessionTitle([])).toBe('Untitled Session');
  });

  test('collapses newlines', () => {
    const title = generateSessionTitle([makeUser('line1\nline2')]);
    expect(title).toBe('line1 line2');
  });
});

describe('shouldCompact', () => {
  test('false when below threshold', () => {
    const msgs = Array.from({ length: 50 }, () => makeUser('x'));
    expect(shouldCompact(msgs)).toBe(false);
  });

  test('true at COMPACT_THRESHOLD (400)', () => {
    const msgs = Array.from({ length: 400 }, () => makeUser('x'));
    expect(shouldCompact(msgs)).toBe(true);
  });
});

describe('shouldCompactAggressively', () => {
  test('false at 400', () => {
    const msgs = Array.from({ length: 400 }, () => makeUser('x'));
    expect(shouldCompactAggressively(msgs)).toBe(false);
  });

  test('true at MAX_CONVERSATION_MESSAGES (500)', () => {
    const msgs = Array.from({ length: 500 }, () => makeUser('x'));
    expect(shouldCompactAggressively(msgs)).toBe(true);
  });
});

describe('compactMessages', () => {
  test('returns unchanged array below threshold', () => {
    const msgs = Array.from({ length: 10 }, () => makeUser('x'));
    expect(compactMessages(msgs)).toEqual(msgs);
  });

  test('compacts messages above threshold', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => makeUser(`msg ${i}`));
    const result = compactMessages(msgs);
    expect(result.length).toBeLessThan(msgs.length);
  });

  test('includes a compact system notice', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => makeUser(`msg ${i}`));
    const result = compactMessages(msgs);
    const notice = result.find(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact');
    expect(notice).toBeDefined();
  });

  test('preserves first user message', () => {
    const msgs = Array.from({ length: 450 }, (_, i) => makeUser(`msg ${i}`));
    const result = compactMessages(msgs);
    const firstUser = result.find(m => m.type === 'user');
    expect((firstUser as { content: string })?.content).toBe('msg 0');
  });
});
