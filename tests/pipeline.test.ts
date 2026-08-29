/**
 * End-to-end pipeline tests.
 *
 * The previous suite passed while the rendered application was empty, because it only ever
 * checked the observer in isolation and the API routes in isolation. These tests instead
 * walk the handoffs that the screen actually depends on:
 *
 *   fixture → initial state → session → aggregates → render model
 *   mocked upstream read → collector → session → aggregates → render model
 *
 * They are deliberately about data reaching the next stage, not about pixels.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, isDemoRequested } from '@/lib/bootstrap';
import { LiveCollector } from '@/lib/collector';
import {
  collectVisibleCoverageEvents,
  collectVisibleMarks,
  collectVisibleTrails,
  laneCount,
} from '@/lib/renderModel';
import { ObservationSessionState } from '@/lib/session';
import { generateSyntheticSession } from '@/lib/synthetic';

/** A window that certainly contains a whole session, so nothing is clipped by time. */
function wholeSession(session: ObservationSessionState) {
  const end = session.endedAt ?? Date.now();
  return { now: end, windowMs: Math.max(end - session.startedAt, 1) + 60_000 };
}

describe('demo bootstrap', () => {
  it('recognizes the demo flag in the forms a URL can produce', () => {
    expect(isDemoRequested({ demo: '1' })).toBe(true);
    expect(isDemoRequested({ demo: 'true' })).toBe(true);
    expect(isDemoRequested({ demo: ['1'] })).toBe(true);
    expect(isDemoRequested({})).toBe(false);
    expect(isDemoRequested({ demo: '0' })).toBe(false);
  });

  it('installs a populated synthetic session as the initial state for ?demo=1', () => {
    // This is the assertion the old suite was missing: not "can a fixture be generated"
    // but "is the session the application opens with actually populated".
    const { session, mode } = createInitialState(true, Date.now());
    expect(mode).toBe('synthetic');
    expect(session.provenance).toBe('synthetic');
    expect(session.senders.size).toBeGreaterThan(0);
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.rooms.size).toBeGreaterThan(0);
  });

  it('builds an identical demo session for a given bootstrap instant', () => {
    // The server render and the hydrating client render both call this. If the same instant
    // did not yield the same session, their rendered metrics would disagree and React would
    // discard the server tree as a hydration mismatch — which is what left `?demo=1`
    // showing a live-like empty scene.
    const at = 1_764_000_000_000;
    const a = createInitialState(true, at).session;
    const b = createInitialState(true, at).session;
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.endedAt).toBe(b.endedAt);
    expect(a.messages.length).toBe(b.messages.length);
    expect(a.senders.size).toBe(b.senders.size);
    expect(a.aggregates(at)).toEqual(b.aggregates(at));
  });

  it('installs an empty live session when demo is not requested', () => {
    const { session, mode } = createInitialState(false, Date.now());

    expect(mode).toBe('live');
    expect(session.provenance).toBe('live');
    expect(session.messages.length).toBe(0);
  });
});

describe('synthetic fixture → session aggregates', () => {
  const session = generateSyntheticSession();
  const aggregates = session.aggregates(session.endedAt ?? Date.now());

  it('produces non-zero aggregates', () => {
    expect(aggregates.senders).toBeGreaterThan(0);
    expect(aggregates.observations).toBeGreaterThan(0);
    expect(aggregates.rooms).toBeGreaterThan(0);
    expect(aggregates.messagesPerMinute).toBeGreaterThan(0);
  });

  it('is dense enough to read as a swarm rather than a handful of dots', () => {
    expect(aggregates.senders).toBeGreaterThanOrEqual(100);
    expect(aggregates.observations).toBeGreaterThanOrEqual(1_000);
    expect(aggregates.rooms).toBeGreaterThanOrEqual(3);
  });

  it('contains known gaps, so the demo shows coverage honestly', () => {
    expect(aggregates.knownGaps).toBeGreaterThan(0);
    expect(aggregates.knownMissingSequencePositions).toBeGreaterThan(0);
    expect(session.coverageEvents.some((e) => e.kind === 'gap')).toBe(true);
  });

  it('indexes every observation against a real sender and room', () => {
    for (const message of session.messages) {
      expect(session.senders.has(message.sender)).toBe(true);
      expect(session.rooms.has(message.room)).toBe(true);
    }
  });

  it('gives every observed sender a lane and a coherent observed span', () => {
    for (const sender of session.senders.values()) {
      expect(sender.lane).toBeGreaterThanOrEqual(0);
      expect(sender.messageCount).toBeGreaterThan(0);
      expect(sender.roomsObserved.length).toBeGreaterThan(0);
      expect(sender.lastObservedAt).toBeGreaterThanOrEqual(sender.firstObservedAt);
    }
  });

  it('produces a non-empty activity series', () => {
    const series = session.activitySeries();
    expect(series.length).toBeGreaterThan(0);
    expect(series.some(([, count]) => count > 0)).toBe(true);
  });
});

describe('session → render model', () => {
  const session = generateSyntheticSession();
  const view = wholeSession(session);

  it('hands non-empty activity marks to the canvas', () => {
    const marks = collectVisibleMarks(session, view);
    expect(marks.count).toBeGreaterThan(0);
    // Every mark must carry a lane and a room, or it has nowhere to be drawn.
    for (let i = 0; i < marks.count; i++) {
      expect(marks.lane[i]).toBeGreaterThanOrEqual(0);
      expect(typeof marks.room[i]).toBe('string');
    }
  });

  it('keeps every mark inside the lane geometry it will be drawn against', () => {
    const lanes = laneCount(session);
    const marks = collectVisibleMarks(session, view);
    for (let i = 0; i < marks.count; i++) {
      expect(marks.lane[i]).toBeLessThan(lanes);
    }
  });

  it('hands trails and coverage bands to the canvas', () => {
    expect(collectVisibleTrails(session, view).length).toBeGreaterThan(0);
    expect(collectVisibleCoverageEvents(session, view).some((e) => e.kind === 'gap')).toBe(true);
  });

  it('clips to the visible window instead of drawing the whole session', () => {
    const empty = collectVisibleMarks(session, {
      now: session.startedAt - 60_000,
      windowMs: 1_000,
    });
    expect(empty.count).toBe(0);
  });

  it('honours the room filter on marks, trails and coverage alike', () => {
    const room = [...session.rooms.keys()][0];
    const filtered = { ...view, roomFilter: room };
    const marks = collectVisibleMarks(session, filtered);
    expect(marks.count).toBeGreaterThan(0);
    for (let i = 0; i < marks.count; i++) expect(marks.room[i]).toBe(room);
    for (const event of collectVisibleCoverageEvents(session, filtered)) {
      expect(event.room).toBe(room);
    }
  });

  it('survives a mark set larger than the initial buffer', () => {
    // The buffer grows in place; a demo session is already well past one page of marks.
    const marks = collectVisibleMarks(session, view);
    expect(marks.capacity).toBeGreaterThanOrEqual(marks.count);
    expect(marks.count).toBeGreaterThan(1_000);
  });
});

describe('live poll → session → render model', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A stub of this app's own read-only routes, in their normalized response shape. */
  function stubUpstream(messages: Array<{ seq: number; from: string; text: string }>) {
    const observedAt = new Date().toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/api/tc/rooms')) {
          return new Response(
            JSON.stringify({
              rooms: [{ room: 'swarm-a', lastSeq: 400, bytes: 90_000, idleSeconds: 2, topic: '' }],
              total: 1,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            room: 'swarm-a',
            count: messages.length,
            firstSeq: messages.length > 0 ? messages[0].seq : null,
            lastSeq: messages.length > 0 ? messages[messages.length - 1].seq : 0,
            generation: 1,
            messages: messages.map((m) => ({ ...m, ts: observedAt })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
  }

  it('turns a successful room read into observed senders, rooms and messages', async () => {
    stubUpstream([
      { seq: 398, from: 'did:key:zAlpha', text: 'first' },
      { seq: 399, from: '~beta', text: 'second' },
      { seq: 400, from: 'did:key:zAlpha', text: 'third' },
    ]);

    const session = new ObservationSessionState('live');
    expect(session.aggregates(Date.now()).observations).toBe(0);

    const collector = new LiveCollector(session);
    await collector.start();
    // One round is enough: the assertion is that data arrives at all, not how fast.
    await vi.waitFor(() => expect(session.messages.length).toBeGreaterThan(0), { timeout: 5_000 });
    collector.stop();

    const aggregates = session.aggregates(Date.now());
    expect(aggregates.observations).toBe(3);
    expect(aggregates.senders).toBe(2);
    expect(aggregates.rooms).toBe(1);
    expect(collector.watchedRooms).toContain('swarm-a');
  });

  it('leaves the awaiting-first-observation state as soon as one message lands', async () => {
    stubUpstream([{ seq: 12, from: '~solo', text: 'hello' }]);

    const session = new ObservationSessionState('live');
    // This is exactly the predicate the field uses to show its empty overlay.
    expect(session.senders.size).toBe(0);

    const collector = new LiveCollector(session);
    await collector.start();
    await vi.waitFor(() => expect(session.senders.size).toBeGreaterThan(0), { timeout: 5_000 });
    collector.stop();

    const marks = collectVisibleMarks(session, { now: Date.now() + 1_000, windowMs: 600_000 });
    expect(marks.count).toBeGreaterThan(0);
  });

  it('reports status transitions and never fails silently', async () => {
    stubUpstream([{ seq: 5, from: '~solo', text: 'hello' }]);
    const seen: string[] = [];

    const session = new ObservationSessionState('live');
    const collector = new LiveCollector(session, { onStatus: (s) => seen.push(s) });
    await collector.start();
    await vi.waitFor(() => expect(seen).toContain('observing'), { timeout: 5_000 });
    collector.stop();

    expect(seen[0]).toBe('discovering');
    expect(seen).toContain('connecting');
  });

  it('surfaces a discovery failure instead of sitting idle forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const errors: string[] = [];
    const statuses: string[] = [];

    const session = new ObservationSessionState('live');
    const collector = new LiveCollector(session, {
      onError: (m) => errors.push(m),
      onStatus: (s) => statuses.push(s),
    });
    void collector.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5_000 });
    collector.stop();

    expect(errors[0]).toContain('room discovery failed');
    expect(statuses).toContain('retrying');
  });

  it('refuses to attach a live collector to a synthetic session', () => {
    // Synthetic and live observations must never share a session.
    expect(() => new LiveCollector(generateSyntheticSession())).toThrow(/live provenance/i);
  });
});
