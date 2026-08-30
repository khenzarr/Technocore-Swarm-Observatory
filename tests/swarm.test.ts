/**
 * Swarm render-model tests.
 *
 * These cover the derivation layer only — the pure functions in `lib/swarmModel` that turn a
 * normalized session into positions, activity heat, room stacks and timeline markers. No
 * canvas, no pixels, no snapshots: the canvas draws whatever these functions return, so
 * proving the model is the durable half of the guarantee.
 */
import { describe, expect, it } from 'vitest';
import { ObservationSessionState } from '@/lib/session';
import { generateSyntheticSession } from '@/lib/synthetic';
import {
  DECAY_MS,
  OTHER_SERIES,
  buildSwarmLayout,
  createSwarmState,
  gridFor,
  hash32,
  rankedRooms,
  roomActivityBuckets,
  sampleSwarmState,
  timelineMarkers,
} from '@/lib/swarmModel';

const T0 = 1_700_000_000_000;

/** A live session with hand-placed observations, so every assertion has an exact expectation. */
function liveFixture(): ObservationSessionState {
  const session = new ObservationSessionState('live', T0);

  // lobby: two senders, one of them DID-prefixed.
  session.ingestRoomRead({
    room: 'lobby',
    firstSeq: 1,
    lastSeq: 3,
    seqs: [1, 2, 3],
    observedAt: T0 + 1_000,
    messages: [
      { seq: 1, ts: 'x', from: 'alice', text: 'one' },
      { seq: 2, ts: 'x', from: 'did:key:zBob', text: 'two' },
      { seq: 3, ts: 'x', from: 'alice', text: 'three' },
    ],
    provenance: 'live',
  });

  // technocore: a fresh sender plus `alice` again, which makes her multi-room.
  session.ingestRoomRead({
    room: 'technocore',
    firstSeq: 1,
    lastSeq: 2,
    seqs: [1, 2],
    observedAt: T0 + 60_000,
    messages: [
      { seq: 1, ts: 'x', from: 'carol', text: 'four' },
      { seq: 2, ts: 'x', from: 'alice', text: 'five' },
    ],
    provenance: 'live',
  });

  return session;
}

describe('swarm layout', () => {
  it('gives every session sender a slot', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);

    expect(layout.count).toBe(session.senders.size);
    expect(layout.count).toBe(3);
    expect(new Set(layout.ids)).toEqual(new Set(['alice', 'did:key:zBob', 'carol']));
    expect(layout.slotOf.size).toBe(layout.count);
    for (const [id, slot] of layout.slotOf) expect(layout.ids[slot]).toBe(id);
  });

  it('keeps positions inside the unit square', () => {
    const layout = buildSwarmLayout(generateSyntheticSession({ observations: 4_000, senders: 240 }));

    for (let i = 0; i < layout.count; i += 1) {
      expect(layout.x[i]).toBeGreaterThanOrEqual(0);
      expect(layout.x[i]).toBeLessThanOrEqual(1);
      expect(layout.y[i]).toBeGreaterThanOrEqual(0);
      expect(layout.y[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic: the same session yields identical positions', () => {
    const session = generateSyntheticSession({ seed: 7, observations: 3_000, senders: 180 });
    const a = buildSwarmLayout(session);
    const b = buildSwarmLayout(session);

    expect(a.ids).toEqual(b.ids);
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect([...a.zone]).toEqual([...b.zone]);
  });

  it('assigns each sender to a zone that exists', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);

    expect(layout.zones.length).toBe(session.rooms.size);
    for (let i = 0; i < layout.count; i += 1) {
      expect(layout.zone[i]).toBeGreaterThanOrEqual(0);
      expect(layout.zone[i]).toBeLessThan(layout.zones.length);
    }
    // Member counts partition the sender population across zones.
    const members = layout.zones.reduce((sum, z) => sum + z.memberCount, 0);
    expect(members).toBe(layout.count);
  });

  it('anchors a sender inside its own zone bounds', () => {
    const layout = buildSwarmLayout(liveFixture());

    for (let i = 0; i < layout.count; i += 1) {
      const zone = layout.zones[layout.zone[i]];
      expect(layout.x[i]).toBeGreaterThanOrEqual(zone.x);
      expect(layout.x[i]).toBeLessThanOrEqual(zone.x + zone.w);
      expect(layout.y[i]).toBeGreaterThanOrEqual(zone.y);
      expect(layout.y[i]).toBeLessThanOrEqual(zone.y + zone.h);
    }
  });

  it('marks DID presence and multi-room activity from real metadata only', () => {
    const layout = buildSwarmLayout(liveFixture());
    const slot = (id: string) => layout.slotOf.get(id)!;

    expect(layout.didPresent[slot('did:key:zBob')]).toBe(1);
    expect(layout.didPresent[slot('alice')]).toBe(0);
    // `alice` is the only sender observed in two rooms.
    expect(layout.multiRoom[slot('alice')]).toBe(1);
    expect(layout.multiRoom[slot('carol')]).toBe(0);
    expect(layout.multiRoom[slot('did:key:zBob')]).toBe(0);
  });

  it('produces a landscape-biased zone grid', () => {
    for (const n of [1, 2, 3, 5, 8, 12, 20]) {
      const { cols, rows } = gridFor(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(cols).toBeGreaterThanOrEqual(rows);
    }
  });

  it('hashes stably and without collapsing to a constant', () => {
    expect(hash32('alice')).toBe(hash32('alice'));
    expect(hash32('alice')).not.toBe(hash32('carol'));
  });
});

describe('activity sampling', () => {
  it('shows only senders whose first observation has happened yet', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);

    const early = sampleSwarmState(session, layout, T0 + 1_000);
    expect(early.presentCount).toBe(2); // alice + did:key:zBob

    const late = sampleSwarmState(session, layout, T0 + 60_000);
    expect(late.presentCount).toBe(3); // carol has now been observed
  });

  it('changes visible state as replay time advances', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const slot = layout.slotOf.get('carol')!;

    const before = sampleSwarmState(session, layout, T0 + 30_000);
    const during = sampleSwarmState(session, layout, T0 + 60_000);

    expect(before.heat[slot]).toBe(0);
    expect(during.heat[slot]).toBeGreaterThan(0);
    expect(during.activeCount).toBeGreaterThan(before.activeCount);
  });

  it('cools a sender down to idle after the decay window', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const slot = layout.slotOf.get('carol')!;
    const observedAt = T0 + 60_000;

    const hot = sampleSwarmState(session, layout, observedAt);
    const warm = sampleSwarmState(session, layout, observedAt + DECAY_MS / 2);
    const cold = sampleSwarmState(session, layout, observedAt + DECAY_MS + 1);

    expect(hot.heat[slot]).toBeCloseTo(1, 5);
    expect(warm.heat[slot]).toBeLessThan(hot.heat[slot]);
    expect(warm.heat[slot]).toBeGreaterThan(0);
    expect(cold.heat[slot]).toBe(0);
    // Cooling down is not disappearing: the sender stays part of the ecology.
    expect(cold.present[slot]).toBe(1);
  });

  it('pulses briefly on a fresh observation and then stops pulsing', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const slot = layout.slotOf.get('carol')!;
    const observedAt = T0 + 60_000;

    expect(sampleSwarmState(session, layout, observedAt).pulse[slot]).toBeGreaterThan(0);
    expect(sampleSwarmState(session, layout, observedAt).pulseCount).toBeGreaterThan(0);
    expect(sampleSwarmState(session, layout, observedAt + DECAY_MS).pulse[slot]).toBe(0);
  });

  it('reacts per zone, not globally', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const state = sampleSwarmState(session, layout, T0 + 60_000);

    expect(state.zoneHeat.length).toBe(layout.zones.length);
    const technocore = layout.zoneOf.get('technocore')!;
    expect(state.zoneHeat[technocore]).toBeGreaterThan(0);
  });

  it('emits a room-transition streak when a sender is observed away from its anchor', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const alice = layout.slotOf.get('alice')!;

    // At T0+1_000 alice's latest observation is in lobby; her anchor is her latest room, so a
    // streak only exists while a sampled observation sits in some other zone.
    const state = sampleSwarmState(session, layout, T0 + 1_000);
    for (const streak of state.streaks) {
      expect(streak.fromZone).not.toBe(streak.toZone);
      expect(streak.progress).toBeGreaterThanOrEqual(0);
      expect(streak.progress).toBeLessThanOrEqual(1);
    }
    expect(state.lastZone[alice]).toBe(layout.zoneOf.get('lobby')!);
  });

  it('restricts the sample to a room filter without mutating the layout', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const carol = layout.slotOf.get('carol')!;

    const lobbyOnly = sampleSwarmState(session, layout, T0 + 60_000, { roomFilter: 'lobby' });
    expect(lobbyOnly.heat[carol]).toBe(0);

    const all = sampleSwarmState(session, layout, T0 + 60_000, { roomFilter: null });
    expect(all.heat[carol]).toBeGreaterThan(0);
  });

  it('reuses a provided state buffer instead of allocating per frame', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);
    const buffer = createSwarmState(layout.count);

    const out = sampleSwarmState(session, layout, T0 + 60_000, { into: buffer });
    expect(out).toBe(buffer);
    expect(out.heat).toBe(buffer.heat);

    // A second sample at a quiet time must clear the previous frame's heat, not accumulate it.
    sampleSwarmState(session, layout, T0 + 60_000 + DECAY_MS + 1, { into: buffer });
    expect(buffer.activeCount).toBe(0);
  });
});

describe('room activity stack', () => {
  it('accounts for every observation inside the session range', () => {
    const session = generateSyntheticSession({ observations: 5_000, senders: 200 });
    const stack = roomActivityBuckets(session);

    const summed = stack.series.reduce(
      (sum, s) => sum + s.values.reduce((a, b) => a + b, 0),
      0,
    );
    expect(summed).toBe(stack.total);
    expect(stack.total).toBe(session.messages.length);
    expect(stack.bucketStarts.length).toBeGreaterThan(1);
    for (const s of stack.series) expect(s.values.length).toBe(stack.bucketStarts.length);
  });

  it('matches per-room observation counts', () => {
    const session = liveFixture();
    const stack = roomActivityBuckets(session, { topRooms: 8 });
    const totalFor = (room: string) => stack.series.find((s) => s.room === room)?.total ?? 0;

    expect(totalFor('lobby')).toBe(3);
    expect(totalFor('technocore')).toBe(2);
  });

  it('collapses low-volume rooms into OTHER rather than drawing 20 series', () => {
    const session = generateSyntheticSession({ observations: 6_000, senders: 200 });
    const stack = roomActivityBuckets(session, { topRooms: 3 });

    expect(stack.series.length).toBeLessThanOrEqual(4);
    if (session.rooms.size > 3) {
      expect(stack.series.some((s) => s.room === OTHER_SERIES)).toBe(true);
    }
    // Collapsing must not lose observations.
    expect(stack.series.reduce((sum, s) => sum + s.total, 0)).toBe(stack.total);
  });

  it('exposes a peak that bounds every stacked bucket', () => {
    const stack = roomActivityBuckets(generateSyntheticSession({ observations: 4_000 }));

    for (let b = 0; b < stack.bucketStarts.length; b += 1) {
      const column = stack.series.reduce((sum, s) => sum + s.values[b], 0);
      expect(column).toBeLessThanOrEqual(stack.peak);
    }
  });

  it('ranks rooms by observed volume', () => {
    const ranked = rankedRooms(liveFixture());
    expect(ranked[0]).toBe('lobby');
    expect(ranked).toContain('technocore');
  });
});

describe('timeline markers', () => {
  it('places markers inside the chart time range', () => {
    const session = generateSyntheticSession({ observations: 6_000, gaps: 4 });
    const stack = roomActivityBuckets(session);
    const markers = timelineMarkers(session);

    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.at).toBe(marker.event.observedAt);
      expect(marker.at).toBeGreaterThanOrEqual(stack.t0);
      expect(marker.at).toBeLessThanOrEqual(stack.t1);
    }
  });

  it('carries an observation-start marker distinct from a gap', () => {
    const session = generateSyntheticSession({ observations: 3_000, gaps: 3 });
    const kinds = new Set(timelineMarkers(session).map((m) => m.kind));

    expect(kinds.has('observation-start')).toBe(true);
    expect(kinds.has('gap')).toBe(true);
  });

  it('keeps an epoch reset distinct from a gap and free of missing-coverage claims', () => {
    const session = new ObservationSessionState('live', T0);
    session.ingestRoomRead({
      room: 'lobby',
      firstSeq: 40,
      lastSeq: 42,
      seqs: [40, 41, 42],
      observedAt: T0 + 1_000,
      messages: [{ seq: 42, ts: 'x', from: 'alice', text: 'hi' }],
      provenance: 'live',
    });
    // The room name now carries a lower sequence space: a generation reset, not a gap.
    session.ingestRoomRead({
      room: 'lobby',
      firstSeq: 1,
      lastSeq: 2,
      seqs: [1, 2],
      observedAt: T0 + 2_000,
      messages: [{ seq: 2, ts: 'x', from: 'alice', text: 'again' }],
      provenance: 'live',
    });

    const markers = timelineMarkers(session);
    const reset = markers.find((m) => m.kind === 'epoch-reset');

    expect(reset).toBeDefined();
    expect(markers.some((m) => m.kind === 'gap')).toBe(false);
    expect(reset!.event.missingSequencePositions).toBe(0);
    expect(session.aggregates(T0 + 2_000).knownGaps).toBe(0);
  });

  it('filters markers to the selected room', () => {
    const session = generateSyntheticSession({ observations: 5_000, gaps: 4 });
    const room = rankedRooms(session)[0];
    const markers = timelineMarkers(session, { roomFilter: room });

    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(marker.event.room).toBe(room);
  });

  it('caps marker count so the chart cannot be overwhelmed', () => {
    const session = generateSyntheticSession({ observations: 8_000, gaps: 30 });
    expect(timelineMarkers(session, { limit: 12 }).length).toBeLessThanOrEqual(12);
  });
});

describe('acceptance targets', () => {
  it('synthetic demo builds a densely populated swarm', () => {
    const session = generateSyntheticSession();
    const layout = buildSwarmLayout(session);
    const at = session.endedAt ?? Date.now();

    expect(layout.count).toBeGreaterThanOrEqual(500);
    expect(layout.zones.length).toBeGreaterThanOrEqual(4);

    const state = sampleSwarmState(session, layout, at);
    // Not a mostly-empty black rectangle: the whole population is present and a meaningful
    // slice of it is warm at the end of the generated span.
    expect(state.presentCount).toBe(layout.count);
    expect(state.activeCount).toBeGreaterThan(20);

    const stack = roomActivityBuckets(session);
    expect(stack.total).toBeGreaterThan(20_000);
    expect(stack.peak).toBeGreaterThan(0);
    expect(timelineMarkers(session).length).toBeGreaterThan(0);
  });

  it('renders a sparse live session as non-empty without fabricating activity', () => {
    const session = liveFixture();
    const layout = buildSwarmLayout(session);

    // Long after the last observation: dormant entities remain, nothing pretends to be active.
    const quiet = sampleSwarmState(session, layout, T0 + 60_000 + DECAY_MS * 4);
    expect(quiet.presentCount).toBe(3);
    expect(quiet.activeCount).toBe(0);
    expect(quiet.pulseCount).toBe(0);
    expect(quiet.streaks.length).toBe(0);
  });

  it('stays responsive at 1,000 senders and 50,000 observations', () => {
    const session = generateSyntheticSession({ senders: 1_000, observations: 50_000, gaps: 8 });
    const layout = buildSwarmLayout(session);
    expect(layout.count).toBeGreaterThanOrEqual(900);

    const at = session.endedAt ?? Date.now();
    const buffer = createSwarmState(layout.count);

    // 60 sampled frames stands in for a second of animation at the target frame rate.
    const startedAt = performance.now();
    for (let f = 0; f < 60; f += 1) {
      sampleSwarmState(session, layout, at - f * 100, { into: buffer });
    }
    const perFrame = (performance.now() - startedAt) / 60;

    // Generous bound: this asserts the sampler is windowed rather than scanning the full
    // message log per frame, without becoming flaky on a loaded CI machine.
    expect(perFrame).toBeLessThan(16);
  });
});
