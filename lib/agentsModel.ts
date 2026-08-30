/**
 * Agents render model.
 *
 * The derivation layer behind AGENTS mode — the third visualization, alongside the
 * abstract swarm field and the timeline lanes. Where `swarmModel` answers "where does
 * every sender sit in its room's territory", this answers a more theatrical question:
 *
 *   1. which district does every observed sender stand in   (`buildAgentsLayout`)
 *   2. what is each agent doing at time T                   (`sampleAgentsState`)
 *   3. which observations get a short quote bubble at T      (`sampleAgentBubbles`)
 *
 * Same contract as the swarm model, deliberately: positions are normalized to the unit
 * square so a resize never re-lays out the stage, `at` is the only time input so live and
 * replay are one code path, and nothing here invents state. Presence, activity recency,
 * room membership, literal `did:key:` prefix presence and multi-room appearance are all
 * read from observation metadata the session already holds. No trust, no reputation, no
 * classification, no identity.
 *
 * Bubble text is the only place sender-authored content reaches this layer. It is treated
 * as untrusted plain text: sanitized here, truncated here, and drawn with `fillText` by
 * the canvas. It is never markup, never parsed, never followed.
 */

import type { ObservationSessionState } from './session';
import { gridFor, hash32 } from './swarmModel';

/** How long an agent stays visibly "popping" after an observation. */
export const AGENT_PULSE_MS = 900;
/** How long an agent stays warm after an observation before settling back to idle. */
export const AGENT_DECAY_MS = 14_000;
/** How long a newly observed agent plays its arrival animation. */
export const AGENT_SPAWN_MS = 1_100;
/** Quote-bubble lifetime. Long enough to read, short enough not to accumulate. */
export const BUBBLE_MS = 2_800;
/** Concurrent bubbles on stage. A hard ceiling, independent of traffic volume. */
export const BUBBLE_MAX = 6;
/**
 * Bubble sampling divisor. Roughly one observation in this many is eligible for a bubble,
 * chosen by a hash of the observation itself rather than at random, so scrubbing replay
 * back over the same instant reproduces exactly the same bubbles.
 */
export const BUBBLE_SAMPLE = 7;
/** Visible characters in a bubble before truncation. */
export const BUBBLE_TEXT_MAX = 42;

/** Depth rows per district. More rows reads as a crowd; fewer reads as a line-up. */
const DISTRICT_ROWS = 6;
/** Drawn agents per district. Beyond this a district reports overflow instead. */
const DISTRICT_CAPACITY = 132;

export interface AgentDistrict {
  room: string;
  /** District bounds in the unit square. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Senders anchored to this district, including any that did not fit on stage. */
  memberCount: number;
  /** Senders actually given a position. */
  drawnCount: number;
  /** `memberCount - drawnCount`. Reported rather than silently dropped. */
  overflow: number;
  messagesObserved: number;
}

export interface AgentsLayout {
  /** Sender count. All parallel arrays are valid for `0..count-1`. */
  count: number;
  ids: string[];
  /** Normalized positions in the unit square. `-1` means "not on stage". */
  x: Float32Array;
  y: Float32Array;
  /** Index into `districts` of the sender's anchor room, or -1. */
  district: Int32Array;
  /** Depth row, 0 at the back. Drives scale and dimming, so the stage reads as a scene. */
  depth: Float32Array;
  didPresent: Uint8Array;
  multiRoom: Uint8Array;
  firstObservedAt: Float64Array;
  /** Idle-bob phase, fixed per sender so no two agents breathe in lockstep. */
  phase: Float32Array;
  /** Slot index by sender id, for hit-test and focus lookups. */
  slotOf: Map<string, number>;
  districts: AgentDistrict[];
  districtOf: Map<string, number>;
  /** Total senders given a position. The honest "how full is the stage" number. */
  drawnCount: number;
}

export interface AgentsState {
  count: number;
  /** 1 when the sender's first observation is at or before the sampled time. */
  present: Uint8Array;
  /** 0..1 activity heat. 1 immediately after an observation, decaying to 0. */
  heat: Float32Array;
  /** 0..1 pop progress for a fresh observation. 0 when not popping. */
  pulse: Float32Array;
  /** 0..1 arrival progress for an agent whose first observation is very recent. */
  spawn: Float32Array;
  /** Most recent observation time at or before the sampled time. 0 when none in window. */
  lastAt: Float64Array;
  /** District index of the most recent observation, or -1 when none in window. */
  lastDistrict: Int32Array;
  activeCount: number;
  pulseCount: number;
  presentCount: number;
  spawnCount: number;
  /** Per-district heat, 0..1. */
  districtHeat: Float32Array;
}

/**
 * A short-lived quote bubble above an active agent.
 *
 * `text` is already sanitized and truncated. It is display-only plain text.
 */
export interface AgentBubble {
  slot: number;
  district: number;
  text: string;
  /** 0 when just observed, 1 at the end of the bubble's life. */
  age: number;
}

/* ────────────────────────────── layout ────────────────────────────── */

/**
 * Deterministic district + agent placement for a session.
 *
 * Districts tile a grid in room-observation order, so a room keeps its stage territory
 * for the life of the session. Inside a district, agents fill depth rows in arrival
 * order, and their column is chosen by a bit-reversal permutation: the first agents
 * spread across the whole district rather than piling up on the left, and — critically —
 * agent `k-1` never moves when agent `k` arrives.
 */
export function buildAgentsLayout(session: ObservationSessionState): AgentsLayout {
  const roomNames = [...session.rooms.keys()];
  const districtOf = new Map<string, number>();
  const grid = gridFor(roomNames.length);

  const districts: AgentDistrict[] = roomNames.map((room, i) => {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const cellW = 1 / grid.cols;
    const cellH = 1 / grid.rows;
    const pad = 0.008;
    districtOf.set(room, i);
    return {
      room,
      x: col * cellW + pad,
      y: row * cellH + pad,
      w: cellW - pad * 2,
      h: cellH - pad * 2,
      memberCount: 0,
      drawnCount: 0,
      overflow: 0,
      messagesObserved: session.rooms.get(room)?.messagesObserved ?? 0,
    };
  });

  // Lane order is the session's own arrival order: lanes are assigned on first
  // observation and never reused.
  const senders = [...session.senders.values()].sort((a, b) => a.lane - b.lane);
  const count = senders.length;
  const layout: AgentsLayout = {
    count,
    ids: new Array<string>(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    district: new Int32Array(count),
    depth: new Float32Array(count),
    didPresent: new Uint8Array(count),
    multiRoom: new Uint8Array(count),
    firstObservedAt: new Float64Array(count),
    phase: new Float32Array(count),
    slotOf: new Map<string, number>(),
    districts,
    districtOf,
    drawnCount: 0,
  };

  const ordinal = new Int32Array(Math.max(districts.length, 1));
  const cols = Math.max(1, Math.ceil(DISTRICT_CAPACITY / DISTRICT_ROWS));

  for (let slot = 0; slot < count; slot++) {
    const sender = senders[slot];
    // Anchored to the latest observed room: an agent stands where the session last saw
    // it, and multi-room activity is shown as a marking rather than as a duplicate agent.
    const anchor =
      districtOf.get(sender.latestRoom) ?? districtOf.get(sender.roomsObserved[0] ?? '') ?? -1;
    const h = hash32(sender.id);
    layout.ids[slot] = sender.id;
    layout.slotOf.set(sender.id, slot);
    layout.district[slot] = anchor;
    layout.didPresent[slot] = sender.didPresent ? 1 : 0;
    layout.multiRoom[slot] = sender.roomsObserved.length > 1 ? 1 : 0;
    layout.firstObservedAt[slot] = sender.firstObservedAt;
    layout.phase[slot] = ((h >>> 8) % 6283) / 1000;

    if (anchor < 0) {
      // No known room means no district to stand in. Park it off-stage rather than
      // inventing a position for it.
      layout.x[slot] = -1;
      layout.y[slot] = -1;
      layout.depth[slot] = 0;
      continue;
    }

    const district = districts[anchor];
    const k = ordinal[anchor]++;
    district.memberCount = ordinal[anchor];

    if (k >= DISTRICT_CAPACITY) {
      district.overflow = district.memberCount - district.drawnCount;
      layout.x[slot] = -1;
      layout.y[slot] = -1;
      layout.depth[slot] = 0;
      continue;
    }

    const row = k % DISTRICT_ROWS;
    const col = columnOrder(cols)[Math.floor(k / DISTRICT_ROWS)];
    const depth = row / Math.max(1, DISTRICT_ROWS - 1);

    // Jitter breaks the grid so the result reads as a crowd rather than as a spreadsheet,
    // while staying a pure function of the sender id.
    const jitterX = ((h & 0xffff) / 0xffff - 0.5) * 0.7;
    const jitterY = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 0.42;

    // Top band is reserved for the district label and for bubbles, which rise above the
    // agents and must not collide with the room name.
    const bandTop = district.y + district.h * 0.34;
    const bandH = district.h * 0.58;
    const rowH = bandH / DISTRICT_ROWS;
    const colW = (district.w * 0.94) / cols;

    layout.x[slot] = district.x + district.w * 0.03 + colW * (col + 0.5) + jitterX * colW;
    layout.y[slot] = bandTop + rowH * (row + 0.5) + jitterY * rowH;
    layout.depth[slot] = depth;
    district.drawnCount++;
    layout.drawnCount++;
  }

  return layout;
}

/** Bit-reversal column permutation, memoized. Even coverage at every prefix length. */
const columnOrderCache = new Map<number, Int32Array>();
function columnOrder(cols: number): Int32Array {
  const cached = columnOrderCache.get(cols);
  if (cached) return cached;
  let size = 1;
  let bits = 0;
  while (size < cols) {
    size <<= 1;
    bits++;
  }
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) {
      if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    }
    if (r < cols) out.push(r);
  }
  const order = Int32Array.from(out);
  columnOrderCache.set(cols, order);
  return order;
}

/* ────────────────────────────── state ────────────────────────────── */

export function createAgentsState(count: number): AgentsState {
  return {
    count,
    present: new Uint8Array(count),
    heat: new Float32Array(count),
    pulse: new Float32Array(count),
    spawn: new Float32Array(count),
    lastAt: new Float64Array(count),
    lastDistrict: new Int32Array(count).fill(-1),
    activeCount: 0,
    pulseCount: 0,
    presentCount: 0,
    spawnCount: 0,
    districtHeat: new Float32Array(0),
  };
}

export interface AgentsSampleOptions {
  /** `null` shows every district. A filter removes the rest from the sample. */
  roomFilter?: string | null;
  decayMs?: number;
  pulseMs?: number;
  spawnMs?: number;
  into?: AgentsState;
}

/**
 * The stage's visible state at an instant.
 *
 * `at` is the only time input, so replay is not a separate mode: moving the playhead
 * moves the agents, because the agents are a function of the playhead.
 *
 * Cost is O(senders + observations inside the decay window). The message log is
 * time-ordered, so the window is found by binary search rather than by scanning.
 */
export function sampleAgentsState(
  session: ObservationSessionState,
  layout: AgentsLayout,
  at: number,
  options: AgentsSampleOptions = {},
): AgentsState {
  const decayMs = options.decayMs ?? AGENT_DECAY_MS;
  const pulseMs = options.pulseMs ?? AGENT_PULSE_MS;
  const spawnMs = options.spawnMs ?? AGENT_SPAWN_MS;
  const filter = options.roomFilter ?? null;
  const districtCount = Math.max(layout.districts.length, 1);
  const state =
    options.into && options.into.count === layout.count
      ? resetState(options.into, districtCount)
      : withDistricts(createAgentsState(layout.count), districtCount);

  const filterDistrict = filter === null ? -2 : (layout.districtOf.get(filter) ?? -2);

  // Presence is the population: a sender observed earlier in the session is still on
  // stage at time `at`. This is what keeps a quiet live moment legible without
  // fabricating traffic.
  let presentCount = 0;
  let spawnCount = 0;
  for (let i = 0; i < layout.count; i++) {
    const first = layout.firstObservedAt[i];
    const present = first <= at && (filter === null || layout.district[i] === filterDistrict);
    state.present[i] = present ? 1 : 0;
    if (!present) continue;
    presentCount++;
    const sinceFirst = at - first;
    if (sinceFirst <= spawnMs) {
      state.spawn[i] = 1 - sinceFirst / spawnMs;
      spawnCount++;
    }
  }
  state.presentCount = presentCount;
  state.spawnCount = spawnCount;

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
      state.lastDistrict[slot] = layout.districtOf.get(m.room) ?? -1;
    }
    if (age <= pulseMs) {
      const progress = 1 - age / pulseMs;
      if (progress > state.pulse[slot]) {
        if (state.pulse[slot] === 0) pulseCount++;
        state.pulse[slot] = progress;
      }
    }
    const districtIndex = layout.districtOf.get(m.room);
    if (districtIndex !== undefined && heat > state.districtHeat[districtIndex]) {
      state.districtHeat[districtIndex] = heat;
    }
  }

  state.activeCount = activeCount;
  state.pulseCount = pulseCount;
  return state;
}

function withDistricts(state: AgentsState, districtCount: number): AgentsState {
  state.districtHeat = new Float32Array(districtCount);
  return state;
}

function resetState(state: AgentsState, districtCount: number): AgentsState {
  state.present.fill(0);
  state.heat.fill(0);
  state.pulse.fill(0);
  state.spawn.fill(0);
  state.lastAt.fill(0);
  state.lastDistrict.fill(-1);
  state.activeCount = 0;
  state.pulseCount = 0;
  state.presentCount = 0;
  state.spawnCount = 0;
  if (state.districtHeat.length < districtCount) {
    state.districtHeat = new Float32Array(districtCount);
  } else {
    state.districtHeat.fill(0);
  }
  return state;
}

/* ────────────────────────────── bubbles ────────────────────────────── */

export interface BubbleOptions {
  roomFilter?: string | null;
  windowMs?: number;
  max?: number;
  /** Sampling divisor. Larger means fewer bubbles. */
  sample?: number;
  textMax?: number;
}

/**
 * Quote bubbles for the instant `at`.
 *
 * Deliberately sampled, not exhaustive: a busy room would otherwise bury its own agents
 * under speech. Eligibility is decided by a hash of `(sender, room, seq)`, so the same
 * instant always produces the same bubbles — a replay scrub is reproducible, and a
 * bubble does not flicker in and out between frames.
 *
 * At most one bubble per agent, at most `max` on stage, newest first.
 */
export function sampleAgentBubbles(
  session: ObservationSessionState,
  layout: AgentsLayout,
  at: number,
  options: BubbleOptions = {},
): AgentBubble[] {
  const windowMs = options.windowMs ?? BUBBLE_MS;
  const max = options.max ?? BUBBLE_MAX;
  const sample = Math.max(1, options.sample ?? BUBBLE_SAMPLE);
  const textMax = options.textMax ?? BUBBLE_TEXT_MAX;
  const filter = options.roomFilter ?? null;

  const messages = session.messages;
  const from = lowerBound(messages, at - windowMs);
  // Upper bound inside the window, so scanning backwards starts at the newest visible
  // observation rather than at the end of the log.
  let to = messages.length - 1;
  while (to >= from && messages[to].observedAt > at) to--;

  const bubbles: AgentBubble[] = [];
  const taken = new Set<number>();
  for (let i = to; i >= from && bubbles.length < max; i--) {
    const m = messages[i];
    if (filter !== null && m.room !== filter) continue;
    if (hash32(`${m.sender}|${m.room}|${m.seq}`) % sample !== 0) continue;
    const slot = layout.slotOf.get(m.sender);
    if (slot === undefined || taken.has(slot)) continue;
    if (layout.x[slot] < 0) continue;
    const text = sanitizeBubbleText(m.excerpt, textMax);
    if (text.length === 0) continue;
    taken.add(slot);
    bubbles.push({
      slot,
      district: layout.districtOf.get(m.room) ?? layout.district[slot],
      text,
      age: Math.min(1, Math.max(0, (at - m.observedAt) / windowMs)),
    });
  }
  return bubbles;
}

/**
 * Make an untrusted excerpt safe and short enough to draw.
 *
 * Control characters and line breaks are removed (a newline in a canvas string is a
 * silent layout bug, and a control character is never legitimate display data), runs of
 * whitespace collapse, URL-shaped tokens are replaced with an inert `[link]` marker so
 * nothing on screen invites a click, and the result is hard-truncated.
 *
 * Scheme-only tokens (`javascript:`, `data:`, and friends) are neutralized as well as
 * `scheme://` URLs. Nothing here could execute them — the canvas has no link surface —
 * but a screenshot of this view should never display something that reads as clickable
 * hostile input, and a viewer should never be invited to retype it somewhere that does.
 *
 * The output is plain text. The canvas draws it with `fillText`; it is never markup and
 * it is never parsed.
 */
export function sanitizeBubbleText(raw: string, max = BUBBLE_TEXT_MAX): string {
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    // Bare dangerous schemes, which carry no `//` and so escape the rule above.
    .replace(/\b(?:javascript|data|vbscript|blob|file):\S*/gi, '[link]')
    .replace(/\bwww\.\S+/gi, '[link]')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, Math.max(1, max - 1)).trimEnd()}\u2026`;
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

/** Districts ranked by anchored population, for stage-level readouts. */
export function rankedDistricts(layout: AgentsLayout): AgentDistrict[] {
  return [...layout.districts]
    .filter((d) => d.memberCount > 0 || d.messagesObserved > 0)
    .sort((a, b) => b.memberCount - a.memberCount || a.room.localeCompare(b.room));
}
