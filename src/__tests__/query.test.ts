import { describe, test, expect } from 'bun:test';
import {
  buildUserInput,
  estimateTokenCount,
  estimateMessageTokens,
  shouldCompact,
} from '../query.ts';
import type { Message } from '../types/message.ts';

describe('buildUserInput', () => {
  test('concatenates user message strings', () => {
    const messages: Message[] = [
      { type: 'user', role: 'user', content: 'hello' },
      { type: 'user', role: 'user', content: 'world' },
    ];
    expect(buildUserInput(messages)).toBe('hello\nworld');
  });

  test('extracts text blocks from array content', () => {
    const messages: Message[] = [
      {
        type: 'user',
        role: 'user',
        content: [{ type: 'text', text: 'from block' }],
      },
    ];
    expect(buildUserInput(messages)).toBe('from block');
  });

  test('ignores non-user messages', () => {
    const messages: Message[] = [
      { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { type: 'user', role: 'user', content: 'user msg' },
    ];
    expect(buildUserInput(messages)).toBe('user msg');
  });

  test('returns empty string for no user messages', () => {
    expect(buildUserInput([])).toBe('');
  });
});

describe('estimateTokenCount', () => {
  test('estimates roughly 1 token per 4 chars', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  test('counts tokens across user and assistant messages', () => {
    const messages: Message[] = [
      { type: 'user', role: 'user', content: 'a'.repeat(400) },
      { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] },
    ];
    expect(estimateMessageTokens(messages)).toBe(200);
  });
});

describe('shouldCompact', () => {
  test('returns false when below threshold', () => {
    const msgs: Message[] = Array.from({ length: 10 }, () => ({
      type: 'user' as const,
      role: 'user' as const,
      content: 'x',
    }));
    expect(shouldCompact(msgs)).toBe(false);
  });

  test('returns true at or above threshold', () => {
    const msgs: Message[] = Array.from({ length: 400 }, () => ({
      type: 'user' as const,
      role: 'user' as const,
      content: 'x',
    }));
    expect(shouldCompact(msgs)).toBe(true);
  });
});
