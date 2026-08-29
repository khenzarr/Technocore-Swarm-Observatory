/**
 * `GET /api/tc/room/<room>` — one bounded room read.
 *
 * The room segment is validated against the upstream room grammar and refused if it names
 * an unlisted room, because an unlisted room name is a bearer capability rather than a
 * public address. `since`, `limit` and `wait` are numeric and clamped. Nothing a caller
 * sends can influence the origin, the scheme, the path shape, or any other query key.
 */

import { NextResponse } from 'next/server';
import { clampLimit, clampSince, clampWait, isObservableRoomName } from '@/lib/protocol';
import { UpstreamError, fetchRoomView } from '@/lib/upstream';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ room: string }> },
) {
  const { room } = await context.params;
  if (!isObservableRoomName(room)) {
    return NextResponse.json({ error: 'not an observable public room name' }, { status: 400 });
  }

  const params = new URL(request.url).searchParams;
  try {
    const view = await fetchRoomView(room, {
      since: clampSince(params.get('since')),
      limit: clampLimit(params.get('limit')),
      wait: clampWait(params.get('wait')),
    });
    return NextResponse.json(view, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    const message = error instanceof UpstreamError ? error.message : 'upstream read failed';
    return NextResponse.json({ error: message }, { status });
  }
}
