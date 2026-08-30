/**
 * Agents render model.
 *
 * The derivation layer behind AGENTS mode — the third visualization, alongside the
 * abstract swarm field and the timeline lanes. Where `swarmModel` answers "where does
 * every sender sit in its room's territory", this answers a more theatrical question:
 *
 *   1. where does every observed sender stand in the shared arena  (`buildAgentsLayout`)
 *   2. what is each agent doing at time T                          (`sampleAgentsState`)
 *   3. which observations get a short quote bubble at T             (`sampleAgentBubbles`)
 *
 * The arena is deliberately one continuous space. Every observed sender stands in the
 * same field, and room membership is carried by the agent itself — its stable room colour,
 * the legend, hover metadata and the filters — rather than by physically segregating the
 * population into per-room districts. A sender's position is a pure function of its
 * identity, so an agent observed in a second room changes colour without ever teleporting.
 *
 * Same contract as the swarm model, deliberately: positions are normalized to the unit
 * square so a resize never re-lays out the arena, `at` is the only time input so live and
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
import { hash32 } from './swarmModel';

/** How long an agent stays visibly "popping" after an observation. */
export const AGENT_PULSE_MS = 900;
/** How long an agent stays warm after an observation before settling back to idle. */
export const AGENT_DECAY_MS = 14_000;
/** How long a newly observed agent plays its arrival animation. */
export const AGENT_SPAWN_MS = 1_100;
/** Quote-bubble lifetime. Long enough to read, short enough not to accumulate. */
export const BUBBLE_MS = 2_800;
/** Concurrent bubbles in the arena. A hard ceiling, independent of traffic volume. */
export const BUBBLE_MAX = 6;
/**
 * Bubble sampling divisor. Roughly one observation in this many is eligible for a bubble,
 * chosen by a hash of the observation itself rather than at random, so scrubbing replay
 * back over the same instant reproduces exactly the same bubbles.
 */
export const BUBBLE_SAMPLE = 7;
/** Visible characters in a bubble before truncation. */
export const BUBBLE_TEXT_MAX = 42;

/**
 * The arena's virtual cell grid.
 *
 * Fixed, never derived from the population: a grid that grew with the sender count would
 * re-place every existing agent the moment a new one arrived. 64 × 32 = 2,048 standing
 * positions, which covers the thousand-agent target with room to spare, and the wide
 * aspect matches the field the canvas actually gets.
 */
const ARENA_COLS = 64;
const ARENA_ROWS = 32;
export const ARENA_CAPACITY = ARENA_COLS * ARENA_ROWS;
/** Inset so a jittered glyph on the outer ring is never clipped by the field edge. */
const ARENA_PAD = 0.012;
/** Jitter as a fraction of a cell. Enough to break the grid, not enough to collide. */
const JITTER = 0.34;

/**
 * A room, as an attribute of the population rather than as a place.
 *
 * Deliberately carries no bounds: there is one arena, and rooms are read from agent
 * colour, the legend and the filters.
 */
export interface ArenaRoom {
  room: string;
  /** Senders whose latest observed room is this one. */
  memberCount: number;
  messagesObserved: number;
}

export interface AgentsLayout {
  /** Sender count. All parallel arrays are valid for `0..count-1`. */
  count: number;
  ids: string[];
  /** Normalized positions in the shared arena's unit square. `-1` means "not placed". */
  x: Float32Array;
  y: Float32Array;
  /** Index into `rooms` of the sender's latest observed room, or -1. Colour, not place. */
  room: Int32Array;
  /** Depth row, 0 at the back. Drives scale and dimming, so the arena reads as a scene. */
  depth: Float32Array;
  didPresent: Uint8Array;
  multiRoom: Uint8Array;
  firstObservedAt: Float64Array;
  /** Idle-bob phase, fixed per sender so no two agents breathe in lockstep. */
  phase: Float32Array;
  /** Slot index by sender id, for hit-test and focus lookups. */
  slotOf: Map<string, number>;
  rooms: ArenaRoom[];
  roomOf: Map<string, number>;
  /** Total senders given a position in the arena. */
  drawnCount: number;
  /** Senders beyond the arena's standing capacity. Reported rather than silently dropped. */
  overflow: number;
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
  /** Room index of the most recent observation, or -1 when none in window. */
  lastRoom: Int32Array;
  activeCount: number;
  pulseCount: number;
  presentCount: number;
  spawnCount: number;
  /** Per-room heat, 0..1. */
  roomHeat: Float32Array;
}

/**
 * A short-lived quote bubble above an active agent.
 *
 * `text` is already sanitized and truncated. It is display-only plain text.
 */
export interface AgentBubble {
  slot: number;
  room: number;
  text: string;
  /** 0 when just observed, 1 at the end of the bubble's life. */
  age: number;
}

/* ────────────────────────────── layout ────────────────────────────── */

/**
 * Deterministic placement of the whole observed population into one shared arena.
 *
 * A sender's standing position is chosen by a hash of its own id, not by its room: there
 * are no districts to belong to, so a sender observed in a second room keeps its place and
 * only changes colour. Hash collisions are resolved by probing forward through the cell
 * grid in lane order — lanes are assigned on first observation and never reused, so an
 * arriving agent can only ever take a still-free cell and never displaces one already
 * standing.
 *
 * Sub-cell jitter, also derived from the id, breaks the underlying grid so the result
 * reads as an organised crowd rather than as a spreadsheet, while staying a pure function
 * of identity: the same session always produces the same arena, in live, in replay and
 * after an import.
 */
export function buildAgentsLayout(session: ObservationSessionState): AgentsLayout {
  const roomNames = [...session.rooms.keys()];
  const roomOf = new Map<string, number>();
  const rooms: ArenaRoom[] = roomNames.map((room, i) => {
    roomOf.set(room, i);
    return {
      room,
      memberCount: 0,
      messagesObserved: session.rooms.get(room)?.messagesObserved ?? 0,
    };
  });

  // Lane order is the session's own arrival order: lanes are assigned on first
  // observation and never reused, which is what makes cell probing append-only.
  const senders = [...session.senders.values()].sort((a, b) => a.lane - b.lane);
  const count = senders.length;
  const layout: AgentsLayout = {
    count,
    ids: new Array<string>(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    room: new Int32Array(count),
    depth: new Float32Array(count),
    didPresent: new Uint8Array(count),
    multiRoom: new Uint8Array(count),
    firstObservedAt: new Float64Array(count),
    phase: new Float32Array(count),
    slotOf: new Map<string, number>(),
    rooms,
    roomOf,
    drawnCount: 0,
    overflow: 0,
  };

  const occupied = new Uint8Array(ARENA_CAPACITY);
  const span = 1 - ARENA_PAD * 2;

  for (let slot = 0; slot < count; slot++) {
    const sender = senders[slot];
    const h = hash32(sender.id);
    // Room membership is the latest observed room: an attribute of the agent, used for
    // colour and filtering. It deliberately has no influence on position below.
    const roomIndex =
      roomOf.get(sender.latestRoom) ?? roomOf.get(sender.roomsObserved[0] ?? '') ?? -1;

    layout.ids[slot] = sender.id;
    layout.slotOf.set(sender.id, slot);
    layout.room[slot] = roomIndex;
    layout.didPresent[slot] = sender.didPresent ? 1 : 0;
    layout.multiRoom[slot] = sender.roomsObserved.length > 1 ? 1 : 0;
    layout.firstObservedAt[slot] = sender.firstObservedAt;
    layout.phase[slot] = ((h >>> 8) % 6283) / 1000;
    if (roomIndex >= 0) rooms[roomIndex].memberCount++;

    const cell = claimCell(occupied, h);
    if (cell < 0) {
      // The arena is full. Park the agent rather than stack it on top of another, and
      // report the overflow instead of pretending the population is smaller.
      layout.x[slot] = -1;
      layout.y[slot] = -1;
      layout.depth[slot] = 0;
      layout.overflow++;
      continue;
    }

    const col = cell % ARENA_COLS;
    const row = (cell - col) / ARENA_COLS;
    const jitterX = ((h & 0xffff) / 0xffff - 0.5) * 2 * JITTER;
    const jitterY = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 2 * JITTER;

    layout.x[slot] = ARENA_PAD + ((col + 0.5 + jitterX) / ARENA_COLS) * span;
    layout.y[slot] = ARENA_PAD + ((row + 0.5 + jitterY) / ARENA_ROWS) * span;
    layout.depth[slot] = row / (ARENA_ROWS - 1);
    layout.drawnCount++;
  }

  return layout;
}

/**
 * The first free cell at or after `hash % capacity`.
 *
 * Linear probing, so placement stays O(1) amortized while the arena has room, and the
 * fallback scan guarantees termination when it is nearly full. Returns -1 only when every
 * standing position is taken.
 */
function claimCell(occupied: Uint8Array, hash: number): number {
  const start = hash % ARENA_CAPACITY;
  for (let step = 0; step < ARENA_CAPACITY; step++) {
    const cell = (start + step) % ARENA_CAPACITY;
    if (occupied[cell] === 0) {
      occupied[cell] = 1;
      return cell;
    }
  }
  return -1;
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
    lastRoom: new Int32Array(count).fill(-1),
    activeCount: 0,
    pulseCount: 0,
    presentCount: 0,
    spawnCount: 0,
    roomHeat: new Float32Array(0),
  };
}

export interface AgentsSampleOptions {
  /** `null` shows the whole arena. A filter removes non-matching agents from the sample. */
  roomFilter?: string | null;
  decayMs?: number;
  pulseMs?: number;
  spawnMs?: number;
  into?: AgentsState;
}

/**
 * The arena's visible state at an instant.
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
  const roomCount = Math.max(layout.rooms.length, 1);
  const state =
    options.into && options.into.count === layout.count
      ? resetState(options.into, roomCount)
      : withRooms(createAgentsState(layout.count), roomCount);

  const filterRoom = filter === null ? -2 : (layout.roomOf.get(filter) ?? -2);

  // Presence is the population: a sender observed earlier in the session is still in the
  // arena at time `at`. This is what keeps a quiet live moment legible without
  // fabricating traffic.
  let presentCount = 0;
  let spawnCount = 0;
  for (let i = 0; i < layout.count; i++) {
    const first = layout.firstObservedAt[i];
    const present = first <= at && (filter === null || layout.room[i] === filterRoom);
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
      state.lastRoom[slot] = layout.roomOf.get(m.room) ?? -1;
    }
    if (age <= pulseMs) {
      const progress = 1 - age / pulseMs;
      if (progress > state.pulse[slot]) {
        if (state.pulse[slot] === 0) pulseCount++;
        state.pulse[slot] = progress;
      }
    }
    const roomIndex = layout.roomOf.get(m.room);
    if (roomIndex !== undefined && heat > state.roomHeat[roomIndex]) {
      state.roomHeat[roomIndex] = heat;
    }
  }

  state.activeCount = activeCount;
  state.pulseCount = pulseCount;
  return state;
}

function withRooms(state: AgentsState, roomCount: number): AgentsState {
  state.roomHeat = new Float32Array(roomCount);
  return state;
}

function resetState(state: AgentsState, roomCount: number): AgentsState {
  state.present.fill(0);
  state.heat.fill(0);
  state.pulse.fill(0);
  state.spawn.fill(0);
  state.lastAt.fill(0);
  state.lastRoom.fill(-1);
  state.activeCount = 0;
  state.pulseCount = 0;
  state.presentCount = 0;
  state.spawnCount = 0;
  if (state.roomHeat.length < roomCount) {
    state.roomHeat = new Float32Array(roomCount);
  } else {
    state.roomHeat.fill(0);
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

/** Screen regions used to spread bubbles out. Coarse on purpose. */
const BUBBLE_REGION_COLS = 3;
const BUBBLE_REGION_ROWS = 2;

/**
 * Quote bubbles for the instant `at`.
 *
 * Deliberately sampled, not exhaustive: one shared arena carrying a busy session would
 * otherwise bury its own population under speech. Eligibility is decided by a hash of
 * `(sender, room, seq)`, so the same instant always produces the same bubbles — a replay
 * scrub is reproducible, and a bubble does not flicker in and out between frames.
 *
 * Two passes, newest first: the first takes at most one bubble per coarse screen region so
 * the selection is spread across the arena rather than clustered in one corner, and the
 * second fills any remaining slots without that restriction. At most one bubble per agent,
 * at most `max` on screen.
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
  const regions = new Set<number>();

  for (let pass = 0; pass < 2 && bubbles.length < max; pass++) {
    for (let i = to; i >= from && bubbles.length < max; i--) {
      const m = messages[i];
      if (filter !== null && m.room !== filter) continue;
      if (hash32(`${m.sender}|${m.room}|${m.seq}`) % sample !== 0) continue;
      const slot = layout.slotOf.get(m.sender);
      if (slot === undefined || taken.has(slot)) continue;
      if (layout.x[slot] < 0) continue;
      const region = regionOf(layout.x[slot], layout.y[slot]);
      // First pass spreads across the arena; second pass fills what is left.
      if (pass === 0 && regions.has(region)) continue;
      const text = sanitizeBubbleText(m.excerpt, textMax);
      if (text.length === 0) continue;
      taken.add(slot);
      regions.add(region);
      bubbles.push({
        slot,
        room: layout.roomOf.get(m.room) ?? layout.room[slot],
        text,
        age: Math.min(1, Math.max(0, (at - m.observedAt) / windowMs)),
      });
    }
  }
  return bubbles;
}

function regionOf(x: number, y: number): number {
  const col = Math.min(BUBBLE_REGION_COLS - 1, Math.max(0, Math.floor(x * BUBBLE_REGION_COLS)));
  const row = Math.min(BUBBLE_REGION_ROWS - 1, Math.max(0, Math.floor(y * BUBBLE_REGION_ROWS)));
  return row * BUBBLE_REGION_COLS + col;
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

/** Rooms ranked by observed population, for arena-level readouts and the legend. */
export function rankedRooms(layout: AgentsLayout): ArenaRoom[] {
  return [...layout.rooms]
    .filter((r) => r.memberCount > 0 || r.messagesObserved > 0)
    .sort((a, b) => b.memberCount - a.memberCount || a.room.localeCompare(b.room));
}
