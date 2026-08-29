/**
 * The Technocore protocol surface this client is allowed to touch.
 *
 * Verified against flop-labs/technocore-chat @ UPSTREAM_MAIN_SHA:
 *   - `src/store.py::read_messages` — the room view shape and `first_seq` semantics
 *   - `src/store.py::room_stats`    — the `/rooms` listing shape
 *   - `src/store.py::NAME_RE`       — the room-name grammar
 *   - `src/store.py::MAX_LIMIT`     — 200
 *   - `src/interop.md`              — cursor loop, epoch detection, cursor-free tail read
 *
 * Semantics adapted from our own prior read-only Technocore transport work: a single
 * pinned origin, no redirects, a bounded response, a bounded timeout, a validated room
 * name, and field-by-field validation of every value before it reaches the application.
 */

/** The one origin this application will ever contact. Not configurable, by design. */
export const TECHNOCORE_ORIGIN = 'https://technocore.chat';

/** Upstream commit this client's protocol assumptions were verified against. */
export const UPSTREAM_MAIN_SHA = '1b678cc968dabe05a2300dfe0a9e21cf942d8498';

/** `src/store.py::NAME_RE`. */
const ROOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** `src/store.py::MAX_LIMIT`. */
export const MAX_LIMIT = 200;

/** Applied when a caller supplies no limit at all. */
export const DEFAULT_LIMIT = 50;

/** `max_wait` as published by `GET /config`. */
export const MAX_WAIT_SECONDS = 10;

/** Bounded response body. A room read is capped upstream; this is the hard stop. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Bounded request timeout, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** How many rooms this observer will ever watch at once. */
export const MAX_WATCHED_ROOMS = 12;

/**
 * Concurrent long-polls. `GET /config` publishes `max_waiters_per_ip: 4`; staying below
 * it keeps this observer a well-behaved client rather than a load source.
 */
export const MAX_CONCURRENT_POLLS = 3;

/** An unlisted room name is a capability. This observer must never enumerate or probe one. */
export function isUnlistedRoomName(room: string): boolean {
  return room.startsWith('p-') || room.startsWith('mb-p-');
}

export function isValidRoomName(room: unknown): room is string {
  return typeof room === 'string' && ROOM_NAME_RE.test(room);
}

/**
 * A room name this observer is permitted to read: valid grammar, and publicly listable.
 * Unlisted rooms are refused even when explicitly requested.
 */
export function isObservableRoomName(room: unknown): room is string {
  return isValidRoomName(room) && !isUnlistedRoomName(room);
}

/** True for a value that carries no number at all, as opposed to one that carries a bad number. */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export function clampLimit(value: unknown): number {
  // An absent or unparseable limit falls back to the default rather than to the minimum:
  // clamping a missing parameter to 1 would silently starve every read.
  if (isAbsent(value)) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
}

export function clampWait(value: unknown): number {
  if (isAbsent(value)) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.trunc(n), MAX_WAIT_SECONDS));
}

export function clampSince(value: unknown): number | null {
  if (isAbsent(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/**
 * Build an upstream URL from a fixed path and validated query values.
 *
 * There is deliberately no way to express an arbitrary URL here: the origin is a
 * constant, the path is chosen from a closed set by the caller, and the room segment is
 * validated and percent-encoded. This is not a generic proxy primitive.
 */
export function buildRoomUrl(
  room: string,
  options: { since?: number | null; limit?: number; wait?: number } = {},
): string {
  if (!isObservableRoomName(room)) {
    throw new Error('refusing to build a URL for a non-observable room name');
  }
  const params = new URLSearchParams({ format: 'json', limit: String(clampLimit(options.limit)) });
  const since = clampSince(options.since);
  if (since !== null) params.set('since', String(since));
  const wait = clampWait(options.wait);
  if (wait > 0) params.set('wait', String(wait));
  return `${TECHNOCORE_ORIGIN}/r/${encodeURIComponent(room)}?${params.toString()}`;
}

export function buildRoomsUrl(limit?: number): string {
  const params = new URLSearchParams({ format: 'json', limit: String(clampLimit(limit)) });
  return `${TECHNOCORE_ORIGIN}/rooms?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Response validation. All upstream content is untrusted remote data.
 * ------------------------------------------------------------------ */

export interface RawMessage {
  seq: number;
  ts: string;
  from: string;
  text: string;
}

/** The shape of `GET /r/<room>?format=json`, after validation. */
export interface RoomView {
  room: string;
  count: number;
  /** Lowest sequence the read could return. Null when the tail was empty. */
  firstSeq: number | null;
  /** Highest sequence the read could return. `since or 0` when the tail was empty. */
  lastSeq: number;
  /** Room lifetime epoch, when the deployment exposes it. */
  generation: number | null;
  messages: RawMessage[];
}

export interface RoomListingEntry {
  room: string;
  lastSeq: number;
  bytes: number;
  idleSeconds: number;
  /** Room-authored, untrusted. Rendered as plain text only. */
  topic: string;
}

export interface RoomsView {
  rooms: RoomListingEntry[];
  total: number;
  capacity: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a single message record. A record that fails any check is dropped rather than
 * repaired: a partially trusted record is worse than a missing one.
 */
export function parseMessage(value: unknown): RawMessage | null {
  if (!isRecord(value)) return null;
  const { seq, ts, from, text } = value;
  if (!isPositiveInt(seq) || seq < 1) return null;
  if (typeof ts !== 'string' || ts.length < 1 || ts.length > 64) return null;
  if (typeof from !== 'string' || from.length < 1 || from.length > 256) return null;
  if (typeof text !== 'string' || text.length > 4096) return null;
  return { seq, ts, from, text };
}

export function parseRoomView(value: unknown, expectedRoom: string): RoomView | null {
  if (!isRecord(value)) return null;
  if (value.room !== expectedRoom) return null;
  if (!Array.isArray(value.messages)) return null;

  const messages: RawMessage[] = [];
  for (const item of value.messages) {
    const parsed = parseMessage(item);
    if (parsed !== null) messages.push(parsed);
  }
  messages.sort((a, b) => a.seq - b.seq);

  // `read_messages` returns `first_seq: null` and `last_seq: since or 0` on an empty tail.
  const firstSeq = isPositiveInt(value.first_seq) ? value.first_seq : null;
  const lastSeq = isPositiveInt(value.last_seq) ? value.last_seq : 0;
  const generation = isPositiveInt(value.generation) ? value.generation : null;

  return {
    room: expectedRoom,
    count: isPositiveInt(value.count) ? value.count : messages.length,
    firstSeq,
    lastSeq,
    generation,
    messages,
  };
}

export function parseRoomsView(value: unknown): RoomsView | null {
  if (!isRecord(value) || !Array.isArray(value.rooms)) return null;
  const rooms: RoomListingEntry[] = [];
  for (const item of value.rooms) {
    if (!isRecord(item)) continue;
    // An unlisted room should never appear in this listing; refuse it if one ever does.
    if (!isObservableRoomName(item.room)) continue;
    rooms.push({
      room: item.room,
      lastSeq: isPositiveInt(item.last_seq) ? item.last_seq : 0,
      bytes: isPositiveInt(item.bytes) ? item.bytes : 0,
      idleSeconds: isPositiveInt(item.idle_seconds) ? item.idle_seconds : 0,
      topic: typeof item.topic === 'string' ? item.topic.slice(0, 160) : '',
    });
  }
  return {
    rooms,
    total: isPositiveInt(value.total) ? value.total : rooms.length,
    capacity: isPositiveInt(value.capacity) ? value.capacity : 0,
  };
}

/** `did:key:` presence is a fact about a string. It is not identity, reputation or trust. */
export function hasDidPrefix(from: string): boolean {
  return from.startsWith('did:key:');
}

/** A compact, inert display label. Never treated as a name a caller can rely on. */
export function senderLabel(from: string): string {
  if (hasDidPrefix(from)) {
    const key = from.slice('did:key:'.length);
    return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
  }
  return `~${from.slice(0, 24)}`;
}

/** Parse the server-assigned `ts`. An unparseable stamp yields null, never a guess. */
export function parseServerTimestamp(ts: string): number | null {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}
