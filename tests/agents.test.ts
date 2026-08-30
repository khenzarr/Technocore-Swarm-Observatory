/**
 * Agents render-model tests.
 *
 * AGENTS mode is a canvas, so the durable half of the guarantee is the derivation layer in
 * `lib/agentsModel`: shared-arena placement, presence, activity heat, bubble sampling and
 * excerpt sanitization. The canvas draws whatever these functions return, so these tests
 * cover determinism, time-only sampling (the property replay depends on), the arena
 * invariants that keep the population one crowd rather than a set of room panels, and the
 * security rules around sender-authored bubble text.
 */
import { describe, expect, it } from 'vitest';
import { ObservationSessionState } from '@/lib/session';
import { generateSyntheticSession } from '@/lib/synthetic';
import {
  AGENT_DECAY_MS,
  ARENA_CAPACITY,
  BUBBLE_MAX,
  BUBBLE_MS,
  BUBBLE_TEXT_MAX,
  buildAgentsLayout,
  createAgentsState,
  rankedRooms,
  sampleAgentBubbles,
  sampleAgentsState,
  sanitizeBubbleText,
} from '@/lib/agentsModel';

const T0 = 1_700_000_000_000;

/** A live session with hand-placed observations, so every assertion has an exact expectation. */
function liveFixture(): ObservationSessionState {
  const session = new ObservationSessionState('live', T0);

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

  // `alice` appears again in a second room, which makes her multi-room and recolours her.
  // It must not move her: there are no districts to move between.
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

describe('buildAgentsLayout', () => {
  it('gives every sender a slot in one shared arena', () => {
    const layout = buildAgentsLayout(liveFixture());

    expect(layout.count).toBe(3);
    expect(layout.rooms.map((r) => r.room)).toEqual(['lobby', 'technocore']);
    expect([...layout.slotOf.keys()].sort()).toEqual(['alice', 'carol', 'did:key:zBob']);
    // One arena, so the whole observed population stands in it.
    expect(layout.drawnCount).toBe(3);
    expect(layout.overflow).toBe(0);
  });

  it('places the entire population inside a single unit-square coordinate space', () => {
    const layout = buildAgentsLayout(generateSyntheticSession());

    expect(layout.drawnCount).toBeGreaterThan(0);
    for (let i = 0; i < layout.count; i++) {
      if (layout.x[i] < 0) continue;
      expect(layout.x[i]).toBeGreaterThan(0);
      expect(layout.x[i]).toBeLessThan(1);
      expect(layout.y[i]).toBeGreaterThan(0);
      expect(layout.y[i]).toBeLessThan(1);
      expect(layout.depth[i]).toBeGreaterThanOrEqual(0);
      expect(layout.depth[i]).toBeLessThanOrEqual(1);
    }
  });

  it('does not group positions by room: every room spreads across the whole arena', () => {
    const layout = buildAgentsLayout(generateSyntheticSession());

    // Positions come from a hash of sender identity, so each populated room's members are
    // scattered over the arena instead of occupying a territory. A per-room centroid near
    // the middle of the field is the observable consequence; a district layout would pull
    // each centroid into its own corner.
    const sums = layout.rooms.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < layout.count; i++) {
      const room = layout.room[i];
      if (room < 0 || layout.x[i] < 0) continue;
      sums[room].x += layout.x[i];
      sums[room].y += layout.y[i];
      sums[room].n++;
    }

    const populated = sums.filter((s) => s.n >= 20);
    expect(populated.length).toBeGreaterThan(1);
    for (const s of populated) {
      expect(Math.abs(s.x / s.n - 0.5)).toBeLessThan(0.2);
      expect(Math.abs(s.y / s.n - 0.5)).toBeLessThan(0.2);
    }
  });

  it('gives each standing agent its own cell, so the crowd is dense but not stacked', () => {
    const layout = buildAgentsLayout(generateSyntheticSession());
    const seen = new Set<string>();

    for (let i = 0; i < layout.count; i++) {
      if (layout.x[i] < 0) continue;
      const key = `${layout.x[i]}|${layout.y[i]}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(layout.drawnCount);
    expect(layout.drawnCount).toBeLessThanOrEqual(ARENA_CAPACITY);
  });

  it('keeps a sender in place when it is observed in another room, and only recolours it', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const alice = layout.slotOf.get('alice')!;
    const before = { x: layout.x[alice], y: layout.y[alice] };

    // Latest room is the colour, and alice has now been seen in two rooms.
    expect(layout.rooms[layout.room[alice]].room).toBe('technocore');
    expect(layout.multiRoom[alice]).toBe(1);
    expect(layout.didPresent[alice]).toBe(0);

    session.ingestRoomRead({
      room: 'kibble',
      firstSeq: 1,
      lastSeq: 1,
      seqs: [1],
      observedAt: T0 + 120_000,
      messages: [{ seq: 1, ts: 'x', from: 'alice', text: 'six' }],
      provenance: 'live',
    });

    const after = buildAgentsLayout(session);
    const slot = after.slotOf.get('alice')!;
    // A third room changes her colour, not her place in the arena.
    expect(after.rooms[after.room[slot]].room).toBe('kibble');
    expect(after.x[slot]).toBeCloseTo(before.x, 6);
    expect(after.y[slot]).toBeCloseTo(before.y, 6);
  });

  it('reports DID presence from the literal prefix only', () => {
    const layout = buildAgentsLayout(liveFixture());

    expect(layout.didPresent[layout.slotOf.get('did:key:zBob')!]).toBe(1);
    expect(layout.didPresent[layout.slotOf.get('carol')!]).toBe(0);
  });

  it('is deterministic: the same session lays out identically twice', () => {
    const session = generateSyntheticSession();
    const a = buildAgentsLayout(session);
    const b = buildAgentsLayout(session);

    expect(a.ids).toEqual(b.ids);
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect([...a.depth]).toEqual([...b.depth]);
  });

  it('does not move existing agents when a new sender arrives', () => {
    const session = liveFixture();
    const before = buildAgentsLayout(session);
    const aliceBefore = {
      x: before.x[before.slotOf.get('alice')!],
      y: before.y[before.slotOf.get('alice')!],
    };

    session.ingestRoomRead({
      room: 'lobby',
      firstSeq: 4,
      lastSeq: 4,
      seqs: [4],
      observedAt: T0 + 90_000,
      messages: [{ seq: 4, ts: 'x', from: 'dave', text: 'six' }],
      provenance: 'live',
    });

    const after = buildAgentsLayout(session);
    const slot = after.slotOf.get('alice')!;
    expect(after.x[slot]).toBeCloseTo(aliceBefore.x, 6);
    expect(after.y[slot]).toBeCloseTo(aliceBefore.y, 6);
    expect(after.slotOf.has('dave')).toBe(true);
  });

  it('handles an empty session without inventing a population', () => {
    const session = new ObservationSessionState('live', T0);
    const layout = buildAgentsLayout(session);
    expect(layout.count).toBe(0);
    expect(layout.drawnCount).toBe(0);
    expect(layout.rooms).toEqual([]);
  });
});

describe('sampleAgentsState', () => {
  it('treats presence as cumulative: a sender observed earlier is still in the arena', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);

    const early = sampleAgentsState(session, layout, T0 + 2_000);
    const late = sampleAgentsState(session, layout, T0 + 10 * 60_000);

    expect(early.presentCount).toBe(2); // alice + did:key:zBob
    expect(late.presentCount).toBe(3); // carol has arrived
    // Nobody is warm ten minutes after the last observation, but everybody is still shown.
    expect(late.activeCount).toBe(0);
  });

  it('changes the visible population as the replay instant moves', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const first = session.messages[0].observedAt;
    const last = session.messages[session.messages.length - 1].observedAt;

    const start = sampleAgentsState(session, layout, first);
    const middle = sampleAgentsState(session, layout, first + (last - first) / 2);
    const end = sampleAgentsState(session, layout, last);

    // The arena fills up over the session rather than showing the final population at
    // every playhead position.
    expect(start.presentCount).toBeLessThan(middle.presentCount);
    expect(middle.presentCount).toBeLessThan(end.presentCount);
    expect(end.presentCount).toBeLessThanOrEqual(layout.count);
  });

  it('is a pure function of the sampled instant', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const at = (session.endedAt ?? Date.now()) - 30_000;

    const a = sampleAgentsState(session, layout, at);
    const b = sampleAgentsState(session, layout, at);

    expect([...a.heat]).toEqual([...b.heat]);
    expect([...a.present]).toEqual([...b.present]);
    expect(a.activeCount).toBe(b.activeCount);
  });

  it('decays heat toward zero as the sampled instant moves away from the observation', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const carol = layout.slotOf.get('carol')!;

    const atObservation = sampleAgentsState(session, layout, T0 + 60_000);
    const halfway = sampleAgentsState(session, layout, T0 + 60_000 + AGENT_DECAY_MS / 2);
    const past = sampleAgentsState(session, layout, T0 + 60_000 + AGENT_DECAY_MS + 1);

    expect(atObservation.heat[carol]).toBeCloseTo(1, 3);
    expect(halfway.heat[carol]).toBeGreaterThan(0);
    expect(halfway.heat[carol]).toBeLessThan(atObservation.heat[carol]);
    expect(past.heat[carol]).toBe(0);
    // Still present: the agent settles to idle, it does not leave.
    expect(past.present[carol]).toBe(1);
  });

  it('pulses and spawns only inside their own short windows', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const carol = layout.slotOf.get('carol')!;

    const fresh = sampleAgentsState(session, layout, T0 + 60_000 + 10);
    expect(fresh.pulse[carol]).toBeGreaterThan(0);
    expect(fresh.spawn[carol]).toBeGreaterThan(0);
    expect(fresh.pulseCount).toBeGreaterThan(0);

    const later = sampleAgentsState(session, layout, T0 + 60_000 + 5_000);
    expect(later.pulse[carol]).toBe(0);
    expect(later.spawn[carol]).toBe(0);
  });

  it('never reads the future: observations after the sampled instant are invisible', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const carol = layout.slotOf.get('carol')!;

    const before = sampleAgentsState(session, layout, T0 + 30_000);
    expect(before.present[carol]).toBe(0);
    expect(before.heat[carol]).toBe(0);
    expect(before.lastAt[carol]).toBe(0);
  });

  it('tracks the room of the latest observation, which is what recolours an agent', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const alice = layout.slotOf.get('alice')!;
    const lobby = layout.roomOf.get('lobby')!;
    const technocore = layout.roomOf.get('technocore')!;

    const inLobby = sampleAgentsState(session, layout, T0 + 1_000);
    const inTechnocore = sampleAgentsState(session, layout, T0 + 60_000);

    expect(inLobby.lastRoom[alice]).toBe(lobby);
    expect(inTechnocore.lastRoom[alice]).toBe(technocore);
    // Recolouring never relocates: position belongs to the layout, not to the sample.
    expect(layout.x[alice]).toBeGreaterThan(0);
  });

  it('filters the arena by room without partitioning it', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const at = T0 + 61_000;

    const all = sampleAgentsState(session, layout, at);
    const filtered = sampleAgentsState(session, layout, at, { roomFilter: 'lobby' });

    expect(all.presentCount).toBe(3);
    // Only `did:key:zBob`'s latest room is lobby; alice's latest room is technocore.
    expect(filtered.presentCount).toBe(1);
    expect(filtered.present[layout.slotOf.get('did:key:zBob')!]).toBe(1);
    expect(filtered.present[layout.slotOf.get('carol')!]).toBe(0);
    // Filtering hides agents; it never moves the ones that remain.
    const bob = layout.slotOf.get('did:key:zBob')!;
    expect(layout.x[bob]).toBeGreaterThan(0);
    expect(layout.y[bob]).toBeGreaterThan(0);
  });

  it('records per-room heat', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const technocore = layout.roomOf.get('technocore')!;

    const state = sampleAgentsState(session, layout, T0 + 60_000);
    expect(state.roomHeat[technocore]).toBeCloseTo(1, 3);
  });

  it('reuses a caller-provided buffer without leaking the previous sample', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);
    const scratch = createAgentsState(layout.count);

    sampleAgentsState(session, layout, T0 + 60_000, { into: scratch });
    const reused = sampleAgentsState(session, layout, T0 + 20 * 60_000, { into: scratch });
    const fresh = sampleAgentsState(session, layout, T0 + 20 * 60_000);

    expect(reused).toBe(scratch);
    expect([...reused.heat]).toEqual([...fresh.heat]);
    expect([...reused.pulse]).toEqual([...fresh.pulse]);
    expect(reused.activeCount).toBe(fresh.activeCount);
  });
});

describe('sampleAgentBubbles', () => {
  it('is reproducible for the same instant, so a replay scrub does not flicker', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const at = (session.endedAt ?? Date.now()) - 5_000;

    const a = sampleAgentBubbles(session, layout, at);
    const b = sampleAgentBubbles(session, layout, at);

    expect(a).toEqual(b);
  });

  it('stays bounded by default, however busy the session is', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const last = session.messages[session.messages.length - 1].observedAt;

    // Sampled across the whole session, never above the ceiling, never twice per agent.
    for (let step = 0; step <= 10; step++) {
      const bubbles = sampleAgentBubbles(session, layout, last - step * 1_000);
      expect(bubbles.length).toBeLessThanOrEqual(BUBBLE_MAX);
      expect(new Set(bubbles.map((b) => b.slot)).size).toBe(bubbles.length);
    }
  });

  it('respects an explicit concurrency ceiling and one bubble per agent', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const at = session.endedAt ?? Date.now();

    const bubbles = sampleAgentBubbles(session, layout, at, { max: 4, sample: 1 });

    expect(bubbles.length).toBeLessThanOrEqual(4);
    expect(new Set(bubbles.map((b) => b.slot)).size).toBe(bubbles.length);
  });

  it('samples rather than quoting everything', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);
    const at = session.endedAt ?? Date.now();

    const sampled = sampleAgentBubbles(session, layout, at, { max: 64, sample: 11 });
    const everything = sampleAgentBubbles(session, layout, at, { max: 64, sample: 1 });

    expect(sampled.length).toBeLessThanOrEqual(everything.length);
  });

  it('never quotes an observation from the future or beyond the bubble window', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);

    expect(sampleAgentBubbles(session, layout, T0 - 1, { sample: 1 })).toEqual([]);
    expect(
      sampleAgentBubbles(session, layout, T0 + 60_000 + BUBBLE_MS + 1_000, { sample: 1 }),
    ).toEqual([]);
  });

  it('ages a bubble from 0 to 1 across its life', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);

    const fresh = sampleAgentBubbles(session, layout, T0 + 60_000, { sample: 1 });
    const old = sampleAgentBubbles(session, layout, T0 + 60_000 + BUBBLE_MS * 0.9, { sample: 1 });

    for (const b of fresh) expect(b.age).toBeLessThan(0.2);
    for (const b of old) expect(b.age).toBeGreaterThan(0.5);
  });

  it('scopes bubbles to the filtered room', () => {
    const session = liveFixture();
    const layout = buildAgentsLayout(session);

    const bubbles = sampleAgentBubbles(session, layout, T0 + 60_000, {
      sample: 1,
      roomFilter: 'lobby',
    });

    expect(bubbles).toEqual([]);
  });
});

describe('sanitizeBubbleText', () => {
  it('collapses whitespace and strips line breaks', () => {
    expect(sanitizeBubbleText('  hello\n\tthere   swarm  ')).toBe('hello there swarm');
  });

  it('strips control characters and zero-width tricks', () => {
    const out = sanitizeBubbleText('a\u0000b\u001fc\u200bd\u2028e');
    expect(out).toBe('a b c d e');
    // Checked by code point rather than by regex: a control-character class in a literal
    // regex is itself a lint error, and the property under test is "no code point below
    // 0x20 survives", which is clearer stated directly.
    for (const ch of out) expect(ch.codePointAt(0)!).toBeGreaterThan(0x1f);
  });

  it('renders URLs inert', () => {
    expect(sanitizeBubbleText('see https://evil.example/x now')).toBe('see [link] now');
    expect(sanitizeBubbleText('go www.evil.example')).toBe('go [link]');
    expect(sanitizeBubbleText('javascript:alert(1)')).toBe('[link]');
  });

  it('leaves markup as literal text, never as markup', () => {
    // The canvas draws with fillText, so the guarantee here is only that the characters
    // survive as characters — nothing downstream can interpret them.
    const out = sanitizeBubbleText('<img src=x onerror=alert(1)>');
    expect(out).toContain('<img');
    expect(out).not.toContain('\n');
  });

  it('truncates long text to the visible budget', () => {
    const out = sanitizeBubbleText('x'.repeat(400));
    expect(out.length).toBeLessThanOrEqual(BUBBLE_TEXT_MAX);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('returns an empty string for content with nothing to show', () => {
    expect(sanitizeBubbleText('   \n\t  ')).toBe('');
    expect(sanitizeBubbleText('')).toBe('');
  });
});

describe('rankedRooms', () => {
  it('ranks rooms by observed population, for the legend rather than for placement', () => {
    const layout = buildAgentsLayout(liveFixture());
    const ranked = rankedRooms(layout);

    expect(ranked.length).toBe(2);
    expect(ranked[0].memberCount).toBeGreaterThanOrEqual(ranked[1].memberCount);
    expect(ranked.map((r) => r.room).sort()).toEqual(['lobby', 'technocore']);
  });

  it('fills the shared arena densely from the synthetic session', () => {
    const session = generateSyntheticSession();
    const layout = buildAgentsLayout(session);

    // The demo must open on a crowd, with several room colours mixed through it.
    expect(layout.drawnCount).toBeGreaterThan(200);
    expect(layout.overflow).toBe(0);
    expect(rankedRooms(layout).length).toBeGreaterThan(1);
  });
});
