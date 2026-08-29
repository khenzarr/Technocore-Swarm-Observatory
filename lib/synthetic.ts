/**
 * Synthetic activity generator, for development, demos and stress testing.
 *
 * Synthetic data is deliberately recognisable: room names are prefixed `demo-`, nicknames
 * are prefixed `synthetic-`, and the session provenance is `synthetic`, which the session
 * state enforces on every ingest. There is no code path that folds this into a live session.
 *
 * Deterministic: a fixed seed produces a fixed session, so a stress run is reproducible.
 */

import { ObservationSessionState } from './session';
import type { RawMessage } from './protocol';

/** Small deterministic PRNG (mulberry32). Reproducibility matters more than quality here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_ROOMS = [
  'demo-lobby',
  'demo-technocore',
  'demo-kibble',
  'demo-meta',
  'demo-swarm',
  'demo-inference',
  'demo-relay',
  'demo-quiet',
] as const;

const DEMO_TEXT = [
  'job claimed, running inference batch',
  'attesting result for prior claim',
  'coordination ping across the swarm',
  'heartbeat, queue depth nominal',
  'posting result digest',
  'requesting peer review of output',
  'observed rank change, recomputing',
  'idle, waiting for work',
] as const;

export interface SyntheticOptions {
  seed?: number;
  senders?: number;
  /** Total observations to generate. */
  observations?: number;
  /** Wall-clock span the generated activity is spread across, in ms. */
  spanMs?: number;
  /** How many known coverage gaps to inject. */
  gaps?: number;
  endsAt?: number;
}

/**
 * Build a complete synthetic session.
 *
 * Activity is shaped rather than uniform: senders have differing base rates, rooms have
 * differing weights, and a few spike windows lift the overall rate, so the rate chart and
 * the swarm field both have visible structure.
 */
export function generateSyntheticSession(options: SyntheticOptions = {}): ObservationSessionState {
  const {
    seed = 20260829,
    senders: senderCount = 520,
    observations = 26_000,
    spanMs = 18 * 60_000,
    gaps = 5,
    endsAt = Date.now(),
  } = options;

  const rand = mulberry32(seed);
  const startedAt = endsAt - spanMs;
  const state = new ObservationSessionState('synthetic', startedAt);

  // Sender pool. Roughly two thirds carry a DID-shaped identifier, matching the mix seen
  // in the live listing, where DID senders dominate the busier rooms.
  const senders = Array.from({ length: senderCount }, (_, i) => {
    const didPresent = rand() < 0.66;
    const id = didPresent
      ? `did:key:zSynthetic${(i * 7919).toString(36).padStart(8, '0')}${Math.floor(rand() * 1e6).toString(36)}`
      : `synthetic-agent-${String(i).padStart(4, '0')}`;
    // A third of the pool is present from the start, so the field is populated immediately
    // and the rest arrive over the session, which is what makes the swarm grow on screen.
    const early = i % 3 === 0;
    return {
      id,
      // Long-tailed rate: a few very chatty senders, many occasional ones.
      weight: Math.pow(rand(), 2.2) + 0.02,
      // Home room, so senders cluster rather than smear evenly across rooms.
      home: Math.floor(rand() * DEMO_ROOMS.length),
      joinAt: early ? startedAt : startedAt + rand() * spanMs * 0.75,
    };
  });
  const totalWeight = senders.reduce((s, x) => s + x.weight, 0);

  // Spike windows lift the rate for a short period.
  const spikes = [0.28, 0.55, 0.82].map((frac) => ({
    at: startedAt + spanMs * frac,
    width: spanMs * 0.035,
  }));

  function rateMultiplier(t: number): number {
    let m = 1;
    for (const s of spikes) {
      const d = Math.abs(t - s.at) / s.width;
      if (d < 1) m += 3.2 * (1 - d * d);
    }
    return m;
  }

  // Distribute observations over the span, weighted by the spike envelope.
  const events: Array<{ at: number; senderIndex: number }> = [];
  for (let i = 0; i < observations; i++) {
    let t = startedAt + rand() * spanMs;
    // Rejection-sample against the envelope so spikes actually concentrate events.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (rand() * 4.2 < rateMultiplier(t)) break;
      t = startedAt + rand() * spanMs;
    }
    // Pick a sender by weight. A sender that has not joined by `t` is re-drawn rather than
    // dropped, so the requested observation count is actually produced.
    let senderIndex = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      let target = rand() * totalWeight;
      senderIndex = 0;
      for (let s = 0; s < senders.length; s++) {
        target -= senders[s].weight;
        if (target <= 0) {
          senderIndex = s;
          break;
        }
      }
      if (senders[senderIndex].joinAt <= t) break;
      // Last resort: fall back to a sender that is present for the whole span.
      if (attempt === 5) senderIndex = 0;
    }
    events.push({ at: t, senderIndex });
  }
  events.sort((a, b) => a.at - b.at);

  // Group into per-room batches so each ingest looks like one real room read.
  const perRoomSeq = new Map<string, number>();
  for (const room of DEMO_ROOMS) {
    perRoomSeq.set(room, 100_000 + Math.floor(rand() * 900_000));
  }

  const BATCH = 24;

  // Gap injection points, spread across the middle of the timeline so each gap has
  // observed activity on both sides of it. These must land on batch boundaries, since the
  // ingest loop below advances in whole batches.
  const gapAt = new Set<number>();
  for (let i = 0; i < gaps; i++) {
    const target = Math.floor(((i + 1) / (gaps + 1)) * events.length);
    gapAt.add(Math.floor(target / BATCH) * BATCH);
  }
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const observedAt = batch[batch.length - 1].at;

    // Split the batch by room.
    const byRoom = new Map<string, RawMessage[]>();
    for (const ev of batch) {
      const sender = senders[ev.senderIndex];
      // Mostly the home room, sometimes elsewhere, which gives multi-room senders.
      const roomIndex = rand() < 0.85 ? sender.home : Math.floor(rand() * DEMO_ROOMS.length);
      const room = DEMO_ROOMS[roomIndex];
      const seq = (perRoomSeq.get(room) ?? 0) + 1;
      perRoomSeq.set(room, seq);
      const list = byRoom.get(room) ?? [];
      list.push({
        seq,
        ts: new Date(ev.at).toISOString(),
        from: sender.id,
        text: DEMO_TEXT[Math.floor(rand() * DEMO_TEXT.length)],
      });
      byRoom.set(room, list);
    }

    const injectGap = gapAt.has(i);
    for (const [room, messages] of byRoom) {
      messages.sort((a, b) => a.seq - b.seq);
      let firstSeq: number | null = messages[0].seq;

      if (injectGap) {
        // Advance the room's sequence beyond what this read returns, so `first_seq` lands
        // above the observer's cursor + 1 — the same shape a real eviction produces.
        const skipped = 40 + Math.floor(rand() * 400);
        const bumped = messages.map((m, idx) => ({ ...m, seq: m.seq + skipped + idx }));
        perRoomSeq.set(room, bumped[bumped.length - 1].seq);
        messages.length = 0;
        messages.push(...bumped);
        firstSeq = messages[0].seq;
      }

      state.ingestRoomRead({
        room,
        firstSeq,
        lastSeq: messages[messages.length - 1].seq,
        seqs: messages.map((m) => m.seq),
        generation: 1,
        observedAt,
        messages,
        provenance: 'synthetic',
      });
    }
  }

  state.endedAt = endsAt;
  return state;
}
