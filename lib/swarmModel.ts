/**
 * Swarm render model.
 *
 * This is the handoff boundary between an observation session and the swarm canvas. It
 * answers three questions, all without a pixel:
 *
 *   1. where does every observed sender sit  (`buildSwarmLayout`)
 *   2. what is each sender doing at time T   (`sampleSwarmState`)
 *   3. what did the rooms do over time       (`roomActivityBuckets`)
 *
 * Keeping it here rather than inline in the draw loop means "did the session actually
 * reach the visualization, and does replay time actually change it?" is a testable
 * question. Positions are normalized to the unit square, so a resize never re-lays out
 * the field and a test never needs a canvas size.
 *
 * Nothing in here invents state. Every visual distinction below is derived from
 * observation metadata the session already holds: presence, recency, room membership and
 * literal `did:key:` prefix presence. There is no trust, reputation or classification.
 */

import type { GapEvent } from './types';
import type { ObservationSessionState } from './session';

/** How long a sender stays visibly "pulsing" after an observation. */
export const PULSE_MS = 1_100;
/** How long a sender stays visibly warm after an observation before returning to idle. */
export const DECAY_MS = 22_000;
/** Room-transition streak lifetime. Inside the 0.5–1.5s band the brief is written for. */
export const STREAK_MS = 1_300;
/**
 * Nominal senders per zone used to normalize the phyllotaxis radius. Fixed rather than
 * derived from the live count so that an arriving sender never moves an existing one.
 */
const ZONE_NOMINAL_CAPACITY = 170;
/** Golden angle. Successive indices land on opposite sides of the cluster. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface SwarmZone {
  room: string;
  /** Zone bounds in the unit square. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Senders anchored to this zone. */
  memberCount: number;
  /** Observations this session attributed to this room. */
  messagesObserved: number;
}

export interface SwarmLayout {
  /** Sender count. All parallel arrays are valid for `0..count-1`. */
  count: number;
  /** Sender ids, indexed by slot. */
  ids: string[];
  /** Normalized positions in the unit square. */
  x: Float32Array;
  y: Float32Array;
  /** Index into `zones` of the sender's anchor room. */
  zone: Int32Array;
  didPresent: Uint8Array;
  multiRoom: Uint8Array;
  firstObservedAt: Float64Array;
  /** Slot index by sender id, for hit-test and focus lookups. */
  slotOf: Map<string, number>;
  zones: SwarmZone[];
  zoneOf: Map<string, number>;
}

export interface SwarmState {
  count: number;
  /** 1 when the sender's first observation is at or before the sampled time. */
  present: Uint8Array;
  /** 0..1 activity heat. 1 immediately after an observation, decaying to 0. */
  heat: Float32Array;
  /** 0..1 pulse progress for the expanding ring. 0 when not pulsing. */
  pulse: Float32Array;
  /** Most recent observation time at or before the sampled time. 0 when none in window. */
  lastAt: Float64Array;
  /** Zone index of the most recent observation, or -1 when none in window. */
  lastZone: Int32Array;
  /** Senders with any heat at all. */
  activeCount: number;
  /** Senders currently pulsing. */
  pulseCount: number;
  /** Senders present at the sampled time. */
  presentCount: number;
  /** Per-zone heat, 0..1, for the zone's own reaction to activity. */
  zoneHeat: Float32Array;
  /** Short-lived room transitions: a sender observed away from its anchor zone. */
  streaks: SwarmStreak[];
}

/**
 * A sender identifier observed in a room other than the one it is anchored to.
 *
 * This represents "the same observed sender identifier appeared in another room", not a
 * claim that an agent physically moved.
 */
export interface SwarmStreak {
  slot: number;
  fromZone: number;
  toZone: number;
  /** 0..1 progress through the streak's lifetime. */
  progress: number;
}

/* ────────────────────────────── layout ────────────────────────────── */

/**
 * Deterministic zone + sender placement for a session.
 *
 * Zones are laid out on a fixed grid in room-observation order, so a room keeps its
 * territory for the life of the session. Within a zone, senders are placed on a
 * phyllotaxis spiral by arrival order: index `k` sits at radius proportional to
 * `sqrt(k)`, which fills the zone evenly and — critically — never moves index `k-1` when
 * index `k` arrives.
 *
 * The same session therefore always produces the same field, and a growing session grows
 * outward rather than reshuffling.
 */
export function buildSwarmLayout(session: ObservationSessionState): SwarmLayout {
  // Room order: observation order, which is the insertion order of the rooms map. Stable
  // for the session, and independent of message volume so a busy minute never re-tiles
  // the field.
  const roomNames = [...session.rooms.keys()];
  const zoneOf = new Map<string, number>();
  const grid = gridFor(roomNames.length);

  const zones: SwarmZone[] = roomNames.map((room, i) => {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const cellW = 1 / grid.cols;
    const cellH = 1 / grid.rows;
    const pad = 0.012;
    zoneOf.set(room, i);
    return {
      room,
      x: col * cellW + pad,
      y: row * cellH + pad,
      w: cellW - pad * 2,
      h: cellH - pad * 2,
      memberCount: 0,
      messagesObserved: session.rooms.get(room)?.messagesObserved ?? 0,
    };
  });

  // Senders in lane order: lanes are assigned on first observation and never reused, so
  // this is the session's own arrival order.
  const senders = [...session.senders.values()].sort((a, b) => a.lane - b.lane);
  const count = senders.length;
  const layout: SwarmLayout = {
    count,
    ids: new Array<string>(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    zone: new Int32Array(count),
    didPresent: new Uint8Array(count),
    multiRoom: new Uint8Array(count),
    firstObservedAt: new Float64Array(count),
    slotOf: new Map<string, number>(),
    zones,
    zoneOf,
  };

  // Ordinal within each zone, which is what the spiral consumes.
  const ordinal = new Int32Array(Math.max(zones.length, 1));

  for (let slot = 0; slot < count; slot++) {
    const sender = senders[slot];
    // Anchored to the latest observed room: the entity sits where the session last saw
    // it, and multi-room activity is shown as evidence rather than duplication.
    const anchor = zoneOf.get(sender.latestRoom) ?? zoneOf.get(sender.roomsObserved[0] ?? '') ?? -1;
    layout.ids[slot] = sender.id;
    layout.slotOf.set(sender.id, slot);
    layout.zone[slot] = anchor;
    layout.didPresent[slot] = sender.didPresent ? 1 : 0;
    layout.multiRoom[slot] = sender.roomsObserved.length > 1 ? 1 : 0;
    layout.firstObservedAt[slot] = sender.firstObservedAt;

    if (anchor < 0) {
      // A sender with no known room cannot be placed in a territory. Park it off-field
      // rather than inventing a position for it.
      layout.x[slot] = -1;
      layout.y[slot] = -1;
      continue;
    }

    const zone = zones[anchor];
    const k = ordinal[anchor]++;
    zone.memberCount = ordinal[anchor];
    const point = spiralPoint(k, sender.id);
    // Inset so glyphs never sit on the zone contour or the room label.
    const insetX = zone.w * 0.5 * 0.9;
    const insetY = zone.h * 0.5 * 0.86;
    layout.x[slot] = zone.x + zone.w / 2 + point.u * insetX;
    layout.y[slot] = zone.y + zone.h * 0.54 + point.v * insetY;
  }

  return layout;
}

/**
 * Position of the `k`-th member of a zone, in `-1..1` on both axes.
 *
 * A small id-derived jitter breaks the spiral's visible regularity so the result reads as
 * a swarm rather than as a sunflower, while staying a pure function of `(k, id)`.
 */
function spiralPoint(k: number, id: string): { u: number; v: number } {
  const h = hash32(id);
  const jitterA = ((h & 0xffff) / 0xffff - 0.5) * 0.055;
  const jitterB = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 0.055;
  const radius = Math.sqrt((k + 0.5) / ZONE_NOMINAL_CAPACITY);
  const angle = k * GOLDEN_ANGLE + (h % 360) * 0.0004;
  return {
    u: Math.max(-1, Math.min(1, Math.cos(angle) * radius + jitterA)),
    v: Math.max(-1, Math.min(1, Math.sin(angle) * radius + jitterB)),
  };
}

/** Grid shape for `n` zones, biased wide because the target viewport is landscape. */
export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  const cols = Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n * 1.9))));
  return { cols, rows: Math.ceil(n / cols) };
}

/** FNV-1a. Stable across runs, unlike anything derived from iteration order. */
export function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ────────────────────────────── state ────────────────────────────── */

export function createSwarmState(count: number): SwarmState {
  return {
    count,
    present: new Uint8Array(count),
    heat: new Float32Array(count),
    pulse: new Float32Array(count),
    lastAt: new Float64Array(count),
    lastZone: new Int32Array(count).fill(-1),
    activeCount: 0,
    pulseCount: 0,
    presentCount: 0,
    zoneHeat: new Float32Array(0),
    streaks: [],
  };
}

export interface SampleOptions {
  /** `null` shows every room. A filter dims nothing away; it removes it from the sample. */
  roomFilter?: string | null;
  decayMs?: number;
  pulseMs?: number;
  into?: SwarmState;
}

/**
 * The swarm's visible state at an instant.
 *
 * `at` is the only time input, so live and replay are the same code path: moving the
 * replay playhead moves the swarm, because the swarm is a function of the playhead.
 *
 * Cost is O(senders + observations inside the decay window), not O(session): the message
 * log is time-ordered, so the window is found by binary search. This is what keeps a
 * 50,000-observation session affordable every frame.
 */
export function sampleSwarmState(
  session: ObservationSessionState,
  layout: SwarmLayout,
  at: number,
  options: SampleOptions = {},
): SwarmState {
  const decayMs = options.decayMs ?? DECAY_MS;
  const pulseMs = options.pulseMs ?? PULSE_MS;
  const filter = options.roomFilter ?? null;
  const state =
    options.into && options.into.count === layout.count
      ? resetState(options.into, layout.zones.length)
      : withZones(createSwarmState(layout.count), layout.zones.length);

  // Presence: the dormant ecology. A sender observed earlier in the session is still part
  // of the field at time `at`, which is what lets a sparse live moment stay legible
  // without fabricating traffic.
  let presentCount = 0;
  for (let i = 0; i < layout.count; i++) {
    const present =
      layout.firstObservedAt[i] <= at &&
      (filter === null || layout.zone[i] === (layout.zoneOf.get(filter) ?? -2));
    state.present[i] = present ? 1 : 0;
    if (present) presentCount++;
  }
  state.presentCount = presentCount;

  const messages = session.messages;
  const from = lowerBound(messages, at - decayMs);
  let activeCount = 0;
  let pulseCount = 0;

  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    if (m.observedAt > at) break;
    if (filter !== null && m.room !== filter) continue;
    const slot = layout.slotOf.get(m.sender);
    if (slot === undefined) continue;
    if (state.present[slot] === 0) continue;

    const age = at - m.observedAt;
    // Cubic ease-out: a fresh observation reads as a hit, then cools gradually rather
    // than snapping off.
    const heat = Math.pow(1 - age / decayMs, 3);
    if (heat > state.heat[slot]) {
      if (state.heat[slot] === 0) activeCount++;
      state.heat[slot] = heat;
    }
    if (m.observedAt > state.lastAt[slot]) {
      state.lastAt[slot] = m.observedAt;
      state.lastZone[slot] = layout.zoneOf.get(m.room) ?? -1;
    }
    if (age <= pulseMs) {
      const progress = 1 - age / pulseMs;
      if (progress > state.pulse[slot]) {
        if (state.pulse[slot] === 0) pulseCount++;
        state.pulse[slot] = progress;
      }
    }
    const zoneIndex = layout.zoneOf.get(m.room);
    if (zoneIndex !== undefined && heat > state.zoneHeat[zoneIndex]) {
      state.zoneHeat[zoneIndex] = heat;
    }
  }

  state.activeCount = activeCount;
  state.pulseCount = pulseCount;

  // Room transitions: a sender whose newest observation is not in its anchor zone. Shown
  // briefly, and only while the observation is fresh.
  for (let i = 0; i < layout.count; i++) {
    const toZone = state.lastZone[i];
    const fromZone = layout.zone[i];
    if (toZone < 0 || toZone === fromZone) continue;
    const age = at - state.lastAt[i];
    if (age > STREAK_MS) continue;
    state.streaks.push({ slot: i, fromZone, toZone, progress: age / STREAK_MS });
  }

  return state;
}

function withZones(state: SwarmState, zoneCount: number): SwarmState {
  state.zoneHeat = new Float32Array(Math.max(zoneCount, 1));
  return state;
}

function resetState(state: SwarmState, zoneCount: number): SwarmState {
  state.present.fill(0);
  state.heat.fill(0);
  state.pulse.fill(0);
  state.lastAt.fill(0);
  state.lastZone.fill(-1);
  state.activeCount = 0;
  state.pulseCount = 0;
  state.presentCount = 0;
  state.streaks.length = 0;
  if (state.zoneHeat.length < Math.max(zoneCount, 1)) {
    state.zoneHeat = new Float32Array(Math.max(zoneCount, 1));
  } else {
    state.zoneHeat.fill(0);
  }
  return state;
}

/** First index whose `observedAt` is >= `t`, over the time-ordered message log. */
function lowerBound(messages: ObservationSessionState['messages'], t: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid].observedAt < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ──────────────────────── historical activity ──────────────────────── */

export interface RoomSeries {
  room: string;
  color: string;
  /** Observations per bucket, parallel to `bucketStarts`. */
  values: Float64Array;
  total: number;
}

export interface ActivityStack {
  bucketMs: number;
  bucketStarts: Float64Array;
  /** Stacked series, densest room first. Low-volume rooms collapse into `OTHER`. */
  series: RoomSeries[];
  /** Highest stacked total across buckets, for the y scale. */
  peak: number;
  t0: number;
  t1: number;
  /** Sum of all series totals. Equals the observation count inside the range. */
  total: number;
}

export const OTHER_SERIES = 'OTHER';

export interface StackOptions {
  /** Target bucket count across the session span. */
  buckets?: number;
  /** How many rooms keep their own series before the rest collapse. */
  topRooms?: number;
  colorOf?: (room: string) => string;
}

/**
 * Observations per time bucket, stacked by room.
 *
 * Answers "when did activity spike, and which rooms drove it". Only the busiest rooms get
 * their own band; the rest collapse into `OTHER`, because twenty unreadable series answer
 * neither question.
 */
export function roomActivityBuckets(
  session: ObservationSessionState,
  options: StackOptions = {},
): ActivityStack {
  const targetBuckets = Math.max(options.buckets ?? 180, 8);
  const topRooms = Math.max(options.topRooms ?? 6, 1);
  const colorOf = options.colorOf ?? (() => '#35e6ff');

  const t0 = session.startedAt;
  const t1 = Math.max(session.endedAt ?? Date.now(), t0 + 1);
  const bucketMs = Math.max(Math.ceil((t1 - t0) / targetBuckets), 250);
  const bucketCount = Math.max(Math.ceil((t1 - t0) / bucketMs), 1);

  // Rank rooms by what this session actually observed, so the visible bands are the ones
  // that carry the activity.
  const volume = new Map<string, number>();
  for (const m of session.messages) {
    volume.set(m.room, (volume.get(m.room) ?? 0) + 1);
  }
  const ranked = [...volume.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = ranked.slice(0, topRooms).map(([room]) => room);
  const hasOther = ranked.length > named.length;

  const index = new Map<string, number>();
  named.forEach((room, i) => index.set(room, i));
  const otherIndex = hasOther ? named.length : -1;

  const seriesCount = named.length + (hasOther ? 1 : 0);
  const values = Array.from({ length: Math.max(seriesCount, 1) }, () => new Float64Array(bucketCount));

  let total = 0;
  for (const m of session.messages) {
    if (m.observedAt < t0 || m.observedAt > t1) continue;
    const bucket = Math.min(Math.floor((m.observedAt - t0) / bucketMs), bucketCount - 1);
    const s = index.get(m.room) ?? otherIndex;
    if (s < 0) continue;
    values[s][bucket]++;
    total++;
  }

  const series: RoomSeries[] = [];
  named.forEach((room, i) => {
    series.push({
      room,
      color: colorOf(room),
      values: values[i],
      total: values[i].reduce((sum, v) => sum + v, 0),
    });
  });
  if (hasOther) {
    const v = values[otherIndex];
    series.push({
      room: OTHER_SERIES,
      color: '#4a5a68',
      values: v,
      total: v.reduce((sum, x) => sum + x, 0),
    });
  }

  let peak = 0;
  for (let b = 0; b < bucketCount; b++) {
    let sum = 0;
    for (const s of series) sum += s.values[b];
    if (sum > peak) peak = sum;
  }

  const bucketStarts = new Float64Array(bucketCount);
  for (let b = 0; b < bucketCount; b++) bucketStarts[b] = t0 + b * bucketMs;

  return { bucketMs, bucketStarts, series, peak, t0, t1, total };
}

/* ──────────────────────────── markers ──────────────────────────── */

export type MarkerKind = 'gap' | 'epoch-reset' | 'observation-start';

export interface TimelineMarker {
  kind: MarkerKind;
  at: number;
  event: GapEvent;
}

/**
 * Coverage markers for the historical chart.
 *
 * The three kinds stay distinct all the way to the screen. A gap is a hole in this
 * observer's coverage; an epoch reset means the room name now carries a different
 * conversation; observation start is the boundary of the session's coverage claim.
 * Neither of the latter two is missing coverage, and neither is drawn as if it were.
 */
export function timelineMarkers(
  session: ObservationSessionState,
  options: { roomFilter?: string | null; limit?: number } = {},
): TimelineMarker[] {
  const filter = options.roomFilter ?? null;
  const limit = options.limit ?? 400;
  const markers: TimelineMarker[] = [];
  for (const event of session.coverageEvents) {
    if (filter !== null && event.room !== filter) continue;
    markers.push({ kind: event.kind, at: event.observedAt, event });
    if (markers.length >= limit) break;
  }
  return markers;
}

/** Rooms ranked by observed volume, for the legend and the room filter row. */
export function rankedRooms(session: ObservationSessionState): string[] {
  return [...session.rooms.values()]
    .filter((r) => r.messagesObserved > 0)
    .sort((a, b) => b.messagesObserved - a.messagesObserved || a.room.localeCompare(b.room))
    .map((r) => r.room);
}
