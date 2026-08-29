import { describe, expect, it } from 'vitest';
import {
  MAX_LIMIT,
  TECHNOCORE_ORIGIN,
  buildRoomUrl,
  buildRoomsUrl,
  clampLimit,
  clampSince,
  clampWait,
  isObservableRoomName,
  isValidRoomName,
  parseMessage,
  parseRoomView,
  parseRoomsView,
  senderLabel,
} from '@/lib/protocol';

describe('room identifier validation', () => {
  it('accepts the upstream room grammar', () => {
    for (const room of ['lobby', 'technocore', 'kibble', 'a', 'r0om-name_1']) {
      expect(isValidRoomName(room)).toBe(true);
    }
  });

  it('rejects names outside the grammar', () => {
    const rejected = [
      '',
      'Lobby',
      '-leading',
      '_leading',
      'has space',
      'has/slash',
      'has.dot',
      '../etc/passwd',
      'a'.repeat(49),
      'ünicode',
      null,
      undefined,
      42,
      {},
    ];
    for (const room of rejected) {
      expect(isValidRoomName(room)).toBe(false);
    }
  });

  it('refuses unlisted room names even when they are grammatical', () => {
    // An unlisted name is a bearer capability; an observer must not probe one.
    expect(isValidRoomName('p-secret')).toBe(true);
    expect(isObservableRoomName('p-secret')).toBe(false);
    expect(isObservableRoomName('mb-p-secret')).toBe(false);
    expect(isObservableRoomName('lobby')).toBe(true);
  });
});

describe('arbitrary URL injection', () => {
  it('cannot be steered to another origin through the room name', () => {
    const attempts = [
      'https://evil.example.com/x',
      '//evil.example.com',
      'lobby?x=1',
      'lobby#frag',
      '..%2f..%2fadmin',
      'lobby/../../admin',
      'lobby\\..\\admin',
      'p-private',
    ];
    for (const attempt of attempts) {
      expect(() => buildRoomUrl(attempt)).toThrow();
    }
  });

  it('always produces a URL on the pinned origin under /r/', () => {
    const url = new URL(buildRoomUrl('lobby', { since: 5, limit: 10, wait: 3 }));
    expect(url.origin).toBe(TECHNOCORE_ORIGIN);
    expect(url.pathname).toBe('/r/lobby');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()].sort()).toEqual(['format', 'limit', 'since', 'wait']);
  });

  it('pins the listing URL too', () => {
    const url = new URL(buildRoomsUrl(10));
    expect(url.origin).toBe(TECHNOCORE_ORIGIN);
    expect(url.pathname).toBe('/rooms');
  });
});

describe('bounded request parameters', () => {
  it('clamps limit into 1..MAX_LIMIT', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
    expect(clampLimit('50')).toBe(50);
    expect(clampLimit('abc')).toBe(50);
    expect(clampLimit(null)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(Infinity)).toBe(50);
  });

  it('clamps wait into 0..10', () => {
    expect(clampWait(-1)).toBe(0);
    expect(clampWait(999)).toBe(10);
    expect(clampWait('4')).toBe(4);
    expect(clampWait('nope')).toBe(0);
  });

  it('distinguishes a missing cursor from zero', () => {
    // Null means "no coverage claim yet"; 0 would be a claim about the whole room.
    expect(clampSince(null)).toBeNull();
    expect(clampSince('')).toBeNull();
    expect(clampSince(undefined)).toBeNull();
    expect(clampSince('abc')).toBeNull();
    expect(clampSince(-4)).toBeNull();
    expect(clampSince(0)).toBe(0);
    expect(clampSince('17')).toBe(17);
  });

  it('omits since from the URL when there is no cursor', () => {
    const url = new URL(buildRoomUrl('lobby', { since: null }));
    expect(url.searchParams.has('since')).toBe(false);
  });

  it('never emits a limit above the upstream maximum', () => {
    const url = new URL(buildRoomUrl('lobby', { limit: 99_999 }));
    expect(url.searchParams.get('limit')).toBe(String(MAX_LIMIT));
  });
});

describe('response validation', () => {
  it('drops message records with wrong types', () => {
    expect(parseMessage({ seq: 1, ts: '2026-01-01T00:00:00Z', from: 'a', text: 'x' })).not.toBeNull();
    expect(parseMessage({ seq: '1', ts: 'x', from: 'a', text: 'x' })).toBeNull();
    expect(parseMessage({ seq: 1.5, ts: 'x', from: 'a', text: 'x' })).toBeNull();
    expect(parseMessage({ seq: 1, ts: 'x', from: '', text: 'x' })).toBeNull();
    expect(parseMessage({ seq: 1, ts: 'x', from: 'a', text: 'x'.repeat(5000) })).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage([1, 2])).toBeNull();
  });

  it('rejects a room view whose room does not match the request', () => {
    const payload = { room: 'other', count: 0, first_seq: null, last_seq: 0, messages: [] };
    expect(parseRoomView(payload, 'lobby')).toBeNull();
  });

  it('preserves the empty-tail contract', () => {
    const view = parseRoomView(
      { room: 'lobby', count: 0, first_seq: null, last_seq: 42, messages: [] },
      'lobby',
    )!;
    expect(view.firstSeq).toBeNull();
    expect(view.lastSeq).toBe(42);
  });

  it('sorts messages and skips invalid entries', () => {
    const view = parseRoomView(
      {
        room: 'lobby',
        count: 3,
        first_seq: 1,
        last_seq: 3,
        messages: [
          { seq: 3, ts: 'x', from: 'a', text: 'c' },
          { seq: 1, ts: 'x', from: 'a', text: 'a' },
          { seq: 'bad', ts: 'x', from: 'a', text: 'b' },
        ],
      },
      'lobby',
    )!;
    expect(view.messages.map((m) => m.seq)).toEqual([1, 3]);
  });

  it('filters unlisted rooms out of a listing', () => {
    const listing = parseRoomsView({
      rooms: [
        { room: 'lobby', last_seq: 5, bytes: 10, idle_seconds: 0, topic: 'hi' },
        { room: 'p-private', last_seq: 5, bytes: 10, idle_seconds: 0, topic: 'no' },
        { room: 'Bad Name', last_seq: 5, bytes: 10, idle_seconds: 0, topic: 'no' },
      ],
      total: 3,
      capacity: 100,
    })!;
    expect(listing.rooms.map((r) => r.room)).toEqual(['lobby']);
  });

  it('treats a room topic as length-bounded untrusted text', () => {
    const listing = parseRoomsView({
      rooms: [{ room: 'lobby', last_seq: 1, bytes: 1, idle_seconds: 0, topic: 'x'.repeat(1000) }],
      total: 1,
      capacity: 1,
    })!;
    expect(listing.rooms[0].topic.length).toBe(160);
  });
});

describe('sender labelling', () => {
  it('abbreviates a DID without asserting anything about it', () => {
    const label = senderLabel('did:key:z6MkabcdefghijklmnopQRSTU');
    expect(label).not.toContain('did:key:');
    expect(label).toContain('…');
  });

  it('marks a nickname as a nickname', () => {
    expect(senderLabel('alice')).toBe('~alice');
  });
});
