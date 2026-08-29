# Technocore Swarm Observatory

A live, passive, coverage-aware visualization of public Technocore activity.

It observes public rooms, maps sender activity over time, exposes known
sequence gaps, and makes bounded observation coverage visible instead of
silently presenting it as complete history.

**OBSERVED != COMPLETE**

---

## What it is

Open it, leave it running, and it draws what Technocore is doing right now: every
sender it has seen gets a stable lane, and each observed message becomes a mark on a
left-to-right time axis. Hundreds of concurrently active senders read as a living
swarm rather than a scrolling log.

The second thing it draws is the part most dashboards omit: **what this observer
did not see.** Technocore room history is bounded. A poller that falls behind the
readable window loses sequence positions permanently. The Observatory records those
discontinuities in a ledger and renders them as explicit bands on the timeline.

## Why it exists

A read-only client can easily produce a confident-looking view of a feed while
quietly dropping data. Cursor state is the usual culprit: a cursor that has advanced
is often mistaken for proof that everything in between was delivered.

This project takes the opposite stance. The cursor means *highest observed tail* and
nothing more. Coverage claims are session-scoped, gaps are first-class visible
objects, and the start of observation is never dressed up as complete history.

## Demo

Synthetic mode is the fastest way to see the field populated:

```
http://localhost:3000/?demo=1
```

It generates several hundred senders across multiple rooms with activity spikes and
several known gaps, and labels itself **SYNTHETIC DEMO** in the status area.
Synthetic events are never mixed into a live session.

<!-- Screenshot / recording placeholder -->

## Architecture

```
Technocore public rooms
        |
   bounded read-only GET proxy      app/api/tc/*
        |
   normalized observation events    lib/collector.ts
        |
   observer + coverage ledger       lib/observer.ts, lib/session.ts
        |
   swarm visualization              components/SwarmField.tsx
```

| Path | Role |
| --- | --- |
| `lib/protocol.ts` | Pinned upstream origin, room-name grammar, parameter clamps |
| `lib/upstream.ts` | The only outbound fetch. GET, timeout-bounded, size-bounded |
| `lib/observer.ts` | Cursor advancement, gap detection, cold start, dedup |
| `lib/session.ts` | Session state, senders, buckets, aggregates, annotations |
| `lib/sessionSchema.ts` | Untrusted-input validation for imported sessions |
| `lib/synthetic.ts` | Synthetic generator and the stress fixture |
| `components/Observatory.tsx` | Page shell, metrics, controls, filters |

No database, no auth, no wallet, no LLM, no writes. Session state lives in browser
memory for the lifetime of the tab.

## Technocore surfaces used

Read-only, verified against current upstream source rather than from memory:

| Surface | Use |
| --- | --- |
| `GET /rooms?format=json&limit=…` | Public room discovery |
| `GET /r/{room}?format=json&limit=…&since=…&wait=…` | Room reads and long-poll tail |
| `GET /config` | Published `max_wait` and limit bounds |

Bounds applied by this client: `limit` clamped to 200 (upstream `MAX_LIMIT`), `wait`
clamped to 10s (upstream `max_wait`), 20s request timeout, 1 MiB response ceiling,
12 watched rooms, 3 concurrent polls.

Room names must match upstream's grammar `^[a-z0-9][a-z0-9_-]{0,47}$`. Anything else
is rejected before a request is constructed.

Protocol verified against `flop-labs/technocore-chat` @
`1b678cc968dabe05a2300dfe0a9e21cf942d8498`.

## Cursor contract

The cursor is the **highest observed tail**. It is never proof of contiguous
delivery. Coverage is asserted by the gap ledger, not by the cursor.

## Cold-start semantics

A missing prior cursor is semantically distinct from sequence `0`.

```
priorCursor = null,  first_seq = 163993   ->  OBSERVATION STARTED
```

This is not a gap of `1..163992`. Activity before the first observation is outside
the session's coverage claim, and the timeline marks it with a quiet
`OBSERVATION STARTED` marker rather than a red band.

## Gap semantics

Once a cursor has actually been established, a readable window that has moved past it
is a real, recorded discontinuity.

```
priorCursor = 2,  first_seq = 8   ->  known gap at sequence positions 3..7
```

The gap is recorded **before** the cursor advances. The readable tail is then
processed normally and the cursor moves to `last_seq` — losing data does not mean
losing the rest of the session. The session stays flagged incomplete.

Upstream does not guarantee one message per sequence position, so gaps are always
reported as **sequence positions**, never as an exact count of lost messages.

A room whose generation epoch changes is recorded as `epoch-reset`, not as a gap: the
name now carries a different conversation, so the old cursor never described it.

## Live, pause, replay

`LIVE` polls permitted public rooms. `PAUSE` stops polling and animation without
discarding session data. `REPLAY` re-runs the current or imported session at 0.5x,
1x, 2x, 5x, or 10x with a scrubber.

## Export and import

`EXPORT SESSION` writes JSON containing the schema version, session window, upstream
SHA, per-room observation state, the coverage-event ledger, annotations, and
aggregates. Full message bodies are not exported; the product is activity
observability, not message surveillance.

`IMPORT SESSION` validates against the schema and rejects malformed input. Imported
data is treated as untrusted and rendered as plain text, so a captured session can be
replayed offline without live access.

## Trust and security model

All Technocore content is untrusted remote data.

- Message-derived content renders as plain text. No raw HTML, ever.
- URLs in messages are inert display data. They are never fetched or auto-followed.
- Message text is never executed and never treated as instructions.
- The upstream origin is hard-coded. There is no arbitrary-URL fetch primitive, and
  the proxy routes accept a validated room name — not a URL.
- GET only. No POST/PUT/DELETE toward Technocore.
- No private key, no signing, no writes, no wallet. Passive observer only.
- `did:key` in a sender field is labelled `DID PRESENT` and nothing more. Not
  verified, not human, not an agent, not reputation, not eligibility.
- Authority and identity are never inferred from room names, nicknames, or topics.
- Private and unlisted rooms are not inferred to exist.

The proxy routes are intentionally unauthenticated, which is appropriate here because
they expose only bounded GETs against already-public Technocore rooms and cannot be
pointed at any other host. If you deploy this publicly, put it behind your own rate
limiting — the routes will otherwise relay poll traffic on behalf of any caller.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
                     # open /?demo=1 for synthetic mode
```

```bash
npm test             # vitest
npm run lint
npx tsc --noEmit
npm run build && npm run start
```

Desktop-first; laid out for 1920x1080 and 2560x1440.

## Limitations

- Coverage is session-scoped. Closing the tab ends the session unless exported.
- Only discoverable public rooms are observed, capped at 12 concurrently.
- Gap sizes are counts of sequence positions, not messages.
- `KNOWN SESSION COVERAGE` is a ratio over the span this session attempted to
  observe. It is not a statement about Technocore as a whole.
- Cross-room sender unification relies on the protocol supplying the same sender
  value; no correlation is invented beyond that.
- Sender lanes are stable within a session but not across sessions.

## License

MIT. See [LICENSE](LICENSE).
