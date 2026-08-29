/**
 * The only place in this codebase that performs a network request.
 *
 * Server-side because the upstream origin does not publish a CORS allowlist, so a
 * browser-direct read is not dependable. The route handlers that call this never accept a
 * URL from a caller: they accept a room name and numeric bounds, and this module builds
 * the URL from a pinned origin.
 */

import {
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  TECHNOCORE_ORIGIN,
  buildRoomUrl,
  buildRoomsUrl,
  parseRoomView,
  parseRoomsView,
  type RoomView,
  type RoomsView,
} from './protocol';

const USER_AGENT = 'technocore-swarm-observatory/0.1 (read-only public observer)';

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Fetch one pinned upstream URL under a bounded timeout and a bounded response size.
 *
 * Redirects are refused rather than followed: a followed redirect is exactly how an
 * origin-pinned client stops being origin-pinned.
 */
async function fetchPinned(url: string): Promise<unknown> {
  if (!url.startsWith(`${TECHNOCORE_ORIGIN}/`)) {
    throw new UpstreamError('refusing to fetch a URL outside the pinned origin', 500);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately not surfacing the underlying error text: it can contain network
    // details that are noise to a client and are not this app's to report.
    throw new UpstreamError('upstream unreachable or timed out', 504);
  }

  if (response.status === 429) throw new UpstreamError('upstream rate limit reached', 429);
  if (!response.ok) throw new UpstreamError(`upstream returned ${response.status}`, 502);

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new UpstreamError('upstream response exceeds the size bound', 502);
  }

  // Stream with a hard byte ceiling so an unbounded body cannot be read into memory even
  // when content-length is absent or untrue.
  const body = response.body;
  if (!body) throw new UpstreamError('upstream response had no body', 502);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UpstreamError('upstream response exceeds the size bound', 502);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new UpstreamError('upstream response was not valid JSON', 502);
  }
}

export async function fetchRoomsListing(limit: number): Promise<RoomsView> {
  const parsed = parseRoomsView(await fetchPinned(buildRoomsUrl(limit)));
  if (!parsed) throw new UpstreamError('upstream listing did not match the expected shape', 502);
  return parsed;
}

export async function fetchRoomView(
  room: string,
  options: { since: number | null; limit: number; wait: number },
): Promise<RoomView> {
  const parsed = parseRoomView(await fetchPinned(buildRoomUrl(room, options)), room);
  if (!parsed) throw new UpstreamError('upstream room view did not match the expected shape', 502);
  return parsed;
}
