/**
 * `GET /api/tc/rooms` — public room discovery.
 *
 * Accepts exactly one input: a numeric `limit`, clamped to the upstream `MAX_LIMIT`.
 * There is no URL, host, path or query passthrough of any kind. This is not a proxy in
 * the general sense; it is a fixed read of one fixed upstream document.
 */

import { NextResponse } from 'next/server';
import { clampLimit } from '@/lib/protocol';
import { UpstreamError, fetchRoomsListing } from '@/lib/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = clampLimit(new URL(request.url).searchParams.get('limit'));
  try {
    return NextResponse.json(await fetchRoomsListing(limit), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    const message = error instanceof UpstreamError ? error.message : 'upstream read failed';
    return NextResponse.json({ error: message }, { status });
  }
}
