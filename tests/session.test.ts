import { describe, expect, it } from 'vitest';
import { ObservationSessionState } from '@/lib/session';
import { SessionImportError, parseSessionFile } from '@/lib/sessionSchema';
import { generateSyntheticSession } from '@/lib/synthetic';

const T0 = 1_700_000_000_000;

function liveSession(): ObservationSessionState {
  return new ObservationSessionState('live', T0);
}

describe('provenance isolation', () => {
  it('refuses synthetic data in a live session', () => {
    const session = liveSession();
    expect(() =>
      session.ingestRoomRead({
        room: 'lobby',
        firstSeq: 1,
        lastSeq: 1,
        seqs: [1],
        observedAt: T0,
        messages: [{ seq: 1, ts: 'x', from: 'a', text: 'hi' }],
        provenance: 'synthetic',
      }),
    ).toThrow(/refusing to mix/);
    expect(session.aggregates(T0).observations).toBe(0);
  });

  it('refuses live data in a synthetic session', () => {
    const session = new ObservationSessionState('synthetic', T0);
    expect(() =>
      session.ingestRoomRead({
        room: 'demo-lobby',
        firstSeq: 1,
        lastSeq: 1,
        seqs: [1],
        observedAt: T0,
        messages: [{ seq: 1, ts: 'x', from: 'a', text: 'hi' }],
        provenance: 'live',
      }),
    ).toThrow(/refusing to mix/);
  });

  it('keeps the provenance of an exported session', () => {
    expect(generateSyntheticSession({ observations: 50, senders: 5 }).toJSON().provenance).toBe(
      'synthetic',
    );
  });
});

describe('session accumulation', () => {
  it('deduplicates a repeated read without double counting', () => {
    const session = liveSession();
    const read = {
      room: 'lobby',
      firstSeq: 1,
      lastSeq: 2,
      seqs: [1, 2],
      observedAt: T0,
      messages: [
        { seq: 1, ts: 'x', from: 'a', text: 'one' },
        { seq: 2, ts: 'x', from: 'b', text: 'two' },
      ],
      provenance: 'live' as const,
    };
    session.ingestRoomRead(read);
    session.ingestRoomRead({ ...read, observedAt: T0 + 1_000 });

    const aggregates = session.aggregates(T0 + 1_000);
    expect(aggregates.observations).toBe(2);
    expect(aggregates.senders).toBe(2);
  });

  it('records an observation-started annotation but no gap on cold start', () => {
    const session = liveSession();
    session.ingestRoomRead({
      room: 'lobby',
      firstSeq: 900,
      lastSeq: 901,
      seqs: [900, 901],
      observedAt: T0,
      messages: [
        { seq: 900, ts: 'x', from: 'a', text: 'one' },
        { seq: 901, ts: 'x', from: 'a', text: 'two' },
      ],
      provenance: 'live',
    });

    expect(session.annotations.map((a) => a.kind)).toContain('observation-started');
    expect(session.aggregates(T0).knownGaps).toBe(0);
  });
});

describe('session import validation', () => {
  const valid = () => generateSyntheticSession({ observations: 200, senders: 12, gaps: 1 }).toJSON();

  it('round-trips an exported session', () => {
    const session = valid();
    const parsed = parseSessionFile(JSON.parse(JSON.stringify(session)));
    expect(parsed.messages.length).toBe(session.messages.length);
    expect(parsed.senders.length).toBe(session.senders.length);
    expect(parsed.provenance).toBe('synthetic');
  });

  it('rejects malformed input', () => {
    const bad: unknown[] = [
      null,
      42,
      'a string',
      [],
      {},
      { schemaVersion: 2, provenance: 'live', startedAt: T0, messages: [], senders: [] },
      { schemaVersion: 1, provenance: 'nope', startedAt: T0, messages: [], senders: [] },
      { schemaVersion: 1, provenance: 'live', startedAt: 0, messages: [], senders: [] },
      { schemaVersion: 1, provenance: 'live', startedAt: T0, messages: 'no', senders: [] },
      { schemaVersion: 1, provenance: 'live', startedAt: T0, messages: [] },
    ];
    for (const input of bad) {
      expect(() => parseSessionFile(input)).toThrow(SessionImportError);
    }
  });

  it('keeps HTML and script-like payloads as inert text', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const parsed = parseSessionFile({
      schemaVersion: 1,
      provenance: 'live',
      startedAt: T0,
      endedAt: T0 + 1000,
      upstreamMainSha: 'deadbeef',
      rooms: [],
      senders: [{ id: hostile, label: hostile, didPresent: true, messageCount: 1 }],
      messages: [{ room: 'lobby', seq: 1, observedAt: T0, sender: hostile, excerpt: hostile }],
      coverageEvents: [],
      annotations: [{ kind: 'activity-spike', at: T0, label: hostile }],
    });

    // Retained verbatim as data. It is never parsed as markup, and it reaches the DOM only
    // as a text child, so there is nothing to sanitise away here.
    expect(parsed.senders[0].id).toBe(hostile);
    expect(parsed.messages[0].excerpt).toBe(hostile);
    expect(typeof parsed.annotations[0].label).toBe('string');
  });

  it('drops entries with invalid room names and unknown senders', () => {
    const parsed = parseSessionFile({
      schemaVersion: 1,
      provenance: 'live',
      startedAt: T0,
      rooms: [{ room: 'Bad Room' }, { room: 'lobby' }],
      senders: [{ id: 'a' }],
      messages: [
        { room: 'lobby', seq: 1, observedAt: T0, sender: 'a' },
        { room: 'lobby', seq: 2, observedAt: T0, sender: 'ghost' },
        { room: '../etc', seq: 3, observedAt: T0, sender: 'a' },
      ],
      coverageEvents: [{ kind: 'nonsense', room: 'lobby' }],
      annotations: [],
    });

    expect(parsed.rooms.map((r) => r.room)).toEqual(['lobby']);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.coverageEvents).toHaveLength(0);
  });

  it('recomputes aggregates rather than trusting the file', () => {
    const parsed = parseSessionFile({
      schemaVersion: 1,
      provenance: 'live',
      startedAt: T0,
      rooms: [],
      senders: [{ id: 'a' }],
      messages: [{ room: 'lobby', seq: 1, observedAt: T0, sender: 'a' }],
      coverageEvents: [
        // A negative count must not be able to reduce the reported missing total.
        { kind: 'gap', room: 'lobby', observedAt: T0, missingSequencePositions: -500 },
        // A non-gap event must never carry a missing count.
        { kind: 'observation-start', room: 'lobby', observedAt: T0, missingSequencePositions: 999 },
      ],
      annotations: [],
      aggregates: { senders: 99_999, observations: 99_999, knownGaps: 0 },
    });

    expect(parsed.aggregates.senders).toBe(1);
    expect(parsed.aggregates.observations).toBe(1);
    expect(parsed.aggregates.knownGaps).toBe(1);
    expect(parsed.aggregates.knownMissingSequencePositions).toBe(0);
  });

  it('restores a session state from imported data', () => {
    const restored = ObservationSessionState.fromJSON(parseSessionFile(valid()));
    expect(restored.senders.size).toBeGreaterThan(0);
    expect(restored.messages.length).toBeGreaterThan(0);
  });
});

describe('synthetic generation', () => {
  it('is deterministic for a fixed seed', () => {
    const options = { seed: 7, observations: 500, senders: 20, endsAt: T0 };
    const a = generateSyntheticSession(options).aggregates(T0);
    const b = generateSyntheticSession(options).aggregates(T0);
    expect(a).toEqual(b);
  });

  it('produces observable gaps and labelled synthetic senders', () => {
    const session = generateSyntheticSession({ observations: 4_000, senders: 80, gaps: 3, endsAt: T0 });
    const aggregates = session.aggregates(T0);

    expect(aggregates.knownGaps).toBeGreaterThan(0);
    expect(aggregates.knownMissingSequencePositions).toBeGreaterThan(0);
    for (const room of session.rooms.keys()) expect(room.startsWith('demo-')).toBe(true);
    for (const id of session.senders.keys()) {
      expect(id.startsWith('synthetic-agent-') || id.includes('Synthetic')).toBe(true);
    }
  });

  it('handles the stress fixture: 1,000 senders and 50,000 observations', () => {
    const started = Date.now();
    const session = generateSyntheticSession({
      seed: 99,
      senders: 1_000,
      observations: 50_000,
      endsAt: T0,
    });
    const aggregates = session.aggregates(T0);

    expect(aggregates.senders).toBeGreaterThan(900);
    expect(aggregates.observations).toBeGreaterThan(40_000);
    // Generation is the expensive part; keep it inside a few seconds so the demo path
    // stays usable on a cold load.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
