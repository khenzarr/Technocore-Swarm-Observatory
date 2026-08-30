'use client';

/**
 * Application shell: mode machine, metrics sampling, controls.
 *
 * The session itself is mutable and lives in a ref. React state here holds only what the
 * chrome needs — a mode, a sampled aggregate snapshot, a filter — so a burst of
 * observations costs one canvas frame rather than one render per message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SwarmField from './SwarmField';
import SwarmCanvas from './SwarmCanvas';
import ActivityChart from './ActivityChart';
import RateChart from './RateChart';
import { ObservationSessionState } from '@/lib/session';
import { LiveCollector, type CollectorStatus } from '@/lib/collector';
import { createInitialState, type InitialState } from '@/lib/bootstrap';

import { generateSyntheticSession } from '@/lib/synthetic';
import { SessionImportError, parseSessionFile } from '@/lib/sessionSchema';

import { UPSTREAM_MAIN_SHA } from '@/lib/protocol';

import { roomColor } from '@/lib/palette';
import type { ObservatoryMode, SessionAggregates } from '@/lib/types';

/** Visible time window. Wide enough to show structure, short enough to feel live. */
const WINDOW_MS = 6 * 60_000;
/** Chrome sampling interval. The canvas runs at frame rate; the numbers do not need to. */
const SAMPLE_MS = 500;
const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10] as const;


export default function Observatory({
  demo,
  bootstrapAt,
}: {
  demo: boolean;
  /**
   * The instant the synthetic session ends, chosen once on the server. Both renders must
   * use the same value or the demo session differs across hydration.
   */
  bootstrapAt: number;
}) {
  /**
   * Built once, before first paint, so demo mode's very first frame already has a
   * populated session behind it and never shows a live-like empty state.
   */
  const initialRef = useRef<InitialState | null>(null);
  initialRef.current ??= createInitialState(demo, bootstrapAt);

  const initial = initialRef.current;

  const [mode, setMode] = useState<ObservatoryMode>(initial.mode);
  // Seeded from the initial session rather than from zeros: the metrics strip is sampled on
  // an interval, so starting empty made a populated demo session read as an empty live one
  // until the first tick landed.
  const [aggregates, setAggregates] = useState<SessionAggregates>(() =>
    initial.session.aggregates(initial.session.endedAt ?? Date.now()),
  );
  const [series, setSeries] = useState<Array<[number, number]>>(() =>
    initial.session.activitySeries(),
  );
  const [roomFilter, setRoomFilter] = useState<string | null>(null);
  const [rooms, setRooms] = useState<string[]>(() => [...initial.session.rooms.keys()]);

  const [notice, setNotice] = useState<string | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<CollectorStatus>('idle');
  /**
   * Render invalidation counter. Bumped whenever the mutable session has changed and the
   * chrome needs to look again.
   */
  const [version, setVersion] = useState(0);
  /**
   * Data-source generation. Bumped only when the session object itself is replaced, and it
   * is the collector effect's dependency: if the collector restarted on every `version`
   * change it would abort itself on its own first observation.
   */
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [speed, setSpeed] = useState<number>(1);

  /** Replay position, 0..1 across the session's span. */
  const [replayAt, setReplayAt] = useState(1);
  /** Replay transport. Scrubbing parks the playhead; PLAY resumes advancing it. */
  const [replayPlaying, setReplayPlaying] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  /**
   * Which visualization is on screen. SWARM is the default impression; TIMELINE keeps the
   * trail-oriented view for reading one sender's history against time.
   */
  const [view, setView] = useState<'swarm' | 'timeline'>('swarm');
  /** Focused sender id, or `null`. Lightweight emphasis, not a profile system. */
  const [focused, setFocused] = useState<string | null>(null);


  // The same object the initial aggregates were read from, so the numbers in the header and
  // the marks on the canvas can never describe two different sessions.
  const sessionRef = useRef<ObservationSessionState>(initial.session);

  const collectorRef = useRef<LiveCollector | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const session = sessionRef.current;

  /** Replace the session wholesale, e.g. on import or when switching data source. */
  const adopt = useCallback((next: ObservationSessionState, nextMode: ObservatoryMode) => {
    collectorRef.current?.stop();
    collectorRef.current = null;
    sessionRef.current = next;
    setRoomFilter(null);
    setRooms([...next.rooms.keys()]);
    setMode(nextMode);
    setVersion((v) => v + 1);
    setSessionEpoch((e) => e + 1);
    setCollectorStatus('idle');
    setReplayAt(1);
  }, []);


  // ── live collection ────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'live') {
      collectorRef.current?.stop();
      collectorRef.current = null;
      return;
    }
    if (sessionRef.current.provenance !== 'live') return;

    const collector = new LiveCollector(sessionRef.current, {
      onRooms: (discovered) => {
        setRooms(discovered);
        setNotice(discovered.length === 0 ? 'no active public rooms discovered' : null);
      },
      onError: (message) => setNotice(message),
      onStatus: (next) => {
        setCollectorStatus(next);
        // A successful read clears a stale retry notice rather than leaving the last

        // failure on screen while the observer is demonstrably working again.
        if (next === 'observing') setNotice(null);
      },
      // The canvas reads the mutable session on its own frame loop, but the metrics strip
      // samples on an interval. Bumping the render version on the first observations keeps
      // the "awaiting first observation" state from outliving the data by up to a tick.
      onUpdate: () => setVersion((v) => v + 1),
    });

    collectorRef.current = collector;
    void collector.start();
    return () => {
      collector.stop();
      collectorRef.current = null;
    };
    // Deliberately keyed on the data-source generation, not on `version`: `version` is
    // bumped by this collector's own `onUpdate`, so depending on it tore the collector down
    // and rebuilt it on every successful read, aborting the in-flight long polls forever.
  }, [mode, sessionEpoch]);


  // ── clock and metrics sampling ─────────────────────────────────────
  useEffect(() => {
    if (mode === 'paused') return;
    const id = setInterval(() => {
      const s = sessionRef.current;
      if (mode === 'replay') {
        // A parked playhead stays parked: scrubbing is an explicit instruction about which
        // instant to inspect, and advancing over it would fight the pointer.
        if (replayPlaying) {
          const startedAt = s.startedAt;
          const endedAt = s.endedAt ?? Date.now();
          const span = Math.max(endedAt - startedAt, 1);
          setReplayAt((at) => {
            const advanced = at + (SAMPLE_MS * speed) / span;
            return advanced >= 1 ? 1 : advanced;
          });
        }
      } else {
        // A synthetic session is a fixed window ending at its own end time.
        setNow(s.provenance === 'synthetic' ? (s.endedAt ?? Date.now()) : Date.now());
      }
      setAggregates(s.aggregates(mode === 'live' ? Date.now() : (s.endedAt ?? Date.now())));
      setSeries(s.activitySeries());
      if (s.rooms.size !== rooms.length && mode !== 'live') setRooms([...s.rooms.keys()]);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [mode, speed, rooms.length, replayPlaying]);

  // Replay maps its normalized position onto the session's own time span.
  const replayNow = useMemo(() => {
    const startedAt = session.startedAt;
    const endedAt = session.endedAt ?? Date.now();
    return startedAt + (endedAt - startedAt) * replayAt;
  }, [session, replayAt, session.endedAt]);

  const rightEdge = mode === 'replay' ? replayNow : now;

  // ── controls ───────────────────────────────────────────────────────
  const goLive = useCallback(() => {
    if (sessionRef.current.provenance === 'live') {
      setMode('live');
      setVersion((v) => v + 1);
      return;
    }
    // Leaving a synthetic or imported session means starting a fresh live one: synthetic
    // and live observations are never allowed to share a session.
    adopt(new ObservationSessionState('live'), 'live');
  }, [adopt]);

  const goDemo = useCallback(() => {
    adopt(generateSyntheticSession(), 'synthetic');
  }, [adopt]);

  /** Entering replay from the chart or the console always starts from the beginning. */
  const goReplay = useCallback(() => {
    setMode('replay');
    setReplayPlaying(true);
    setReplayAt(0);
  }, []);

  /**
   * Dragging the historical chart is also how replay is entered: a scrub implies the
   * viewer wants a past instant, so the swarm follows the playhead rather than the clock.
   */
  const scrubTo = useCallback(
    (at: number) => {
      const s = sessionRef.current;
      const startedAt = s.startedAt;
      const endedAt = s.endedAt ?? Date.now();
      const span = Math.max(endedAt - startedAt, 1);
      setMode('replay');
      setReplayPlaying(false);
      setReplayAt(Math.max(0, Math.min(1, (at - startedAt) / span)));
    },
    [],
  );

  const exportSession = useCallback(() => {
    const payload = sessionRef.current.toJSON();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `technocore-swarm-session-${payload.provenance}-${payload.startedAt}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const importSession = useCallback(
    async (file: File) => {
      try {
        // Imported JSON is untrusted: parsed, validated field by field, never evaluated.
        const parsed = parseSessionFile(JSON.parse(await file.text()));
        adopt(ObservationSessionState.fromJSON(parsed), 'replay');
        setNotice(`imported ${parsed.provenance} session · ${parsed.messages.length} observations`);
      } catch (error) {
        setNotice(
          error instanceof SessionImportError
            ? `import rejected: ${error.message}`
            : 'import rejected: not a valid session file',
        );
      }
    },
    [adopt],
  );

  const statusLabel: Record<ObservatoryMode, string> = {
    live: 'LIVE',
    paused: 'PAUSED',
    replay: 'REPLAY',
    synthetic: 'SYNTHETIC DEMO',
  };

  /**
   * One line of observer state, so a quiet screen is legible: waiting on discovery reads
   * differently from waiting on upstream traffic. Only meaningful for a live session.
   */
  const observerLabel: Record<CollectorStatus, string> = {
    idle: '',
    discovering: 'DISCOVERING ROOMS',
    connecting: 'CONNECTING',
    observing: 'OBSERVING',
    retrying: 'RETRYING',
  };
  const observerStatus =
    mode === 'live' && collectorStatus !== 'idle' ? observerLabel[collectorStatus] : null;


  const activeRooms = useMemo(() => {
    const observed = [...session.rooms.values()]
      .filter((r) => r.messagesObserved > 0)
      .sort((a, b) => b.messagesObserved - a.messagesObserved)
      .map((r) => r.room);
    // Fall back to the discovered set before any observation has landed.
    return observed.length > 0 ? observed : rooms;
  }, [session, rooms, version, aggregates.observations]);

  const coverage = aggregates.knownSessionCoverage;

  // The immediate hook: one sentence a viewer can read in two seconds. Phrased as
  // "observed senders", never as a claim about how many agents exist on Technocore.
  const headline =
    aggregates.observations === 0
      ? mode === 'live'
        ? 'AWAITING FIRST OBSERVATION'
        : 'NO OBSERVATIONS IN THIS SESSION'
      : `${aggregates.senders.toLocaleString()} OBSERVED SENDERS ACROSS ${aggregates.rooms.toLocaleString()} ${aggregates.rooms === 1 ? 'ROOM' : 'ROOMS'}`;

  /** Legend rows: the same stable room treatment the swarm and the chart both use. */
  const legend = activeRooms.slice(0, 6);

  // ESC leaves focus mode. Registered on the window so it works wherever the pointer is.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocused(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            TECHNOCORE
            <span>SWARM OBSERVATORY</span>
          </h1>
          <p className="tagline">Live public activity, as observed.</p>
          <p className="headline">{headline}</p>
        </div>
        <div className="masthead-right">
          <div className="status" data-mode={mode}>
            <span className="dot" />
            {statusLabel[mode]}
          </div>
          {observerStatus && (
            <div className="observer-status" data-state={collectorStatus}>{observerStatus}</div>
          )}
          {notice && <div className="notice">{notice}</div>}
          <div className="viewswitch" role="group" aria-label="Visualization mode">
            <button onClick={() => setView('swarm')} data-active={view === 'swarm'}>
              SWARM
            </button>
            <button onClick={() => setView('timeline')} data-active={view === 'timeline'}>
              TIMELINE
            </button>
          </div>
        </div>
      </header>

      <section className="metrics">
        <Metric label="Observed senders" value={aggregates.senders} />
        <Metric label="Messages observed" value={aggregates.observations} />
        <Metric label="Active rooms" value={aggregates.rooms} />
        <Metric label="Known gaps" value={aggregates.knownGaps} tone={aggregates.knownGaps > 0 ? 'gap' : undefined} />
        <Metric
          label="Known missing seq"
          value={aggregates.knownMissingSequencePositions}
          tone={aggregates.knownMissingSequencePositions > 0 ? 'warn' : undefined}
        />
        <Metric label="Messages / min" value={Math.round(aggregates.messagesPerMinute)} />
        {coverage !== null && (
          <Metric label="Known session coverage" value={`${(coverage * 100).toFixed(1)}%`} />
        )}
        <RateChart series={series} now={rightEdge} windowMs={WINDOW_MS} />
      </section>

      {/* The hero. Both views read the same session at the same instant. */}
      {view === 'swarm' ? (
        <SwarmCanvas
          session={session}
          version={version}
          now={rightEdge}
          roomFilter={roomFilter}
          focused={focused}
          onFocus={setFocused}
          paused={mode === 'paused'}
        />
      ) : (
        <SwarmField
          session={session}
          version={version}
          now={rightEdge}
          windowMs={WINDOW_MS}
          roomFilter={roomFilter}
          paused={mode === 'paused'}
        />
      )}

      <div className="legend">
        {legend.map((room) => (
          <span key={room} className="legend-room">
            <i style={{ background: roomColor(room) }} />
            {room}
          </span>
        ))}
        {activeRooms.length > legend.length && (
          <span className="legend-room" data-other="true">
            <i />
            other ({activeRooms.length - legend.length})
          </span>
        )}
        <span className="legend-sep" />
        <span className="legend-key"><i data-key="active" />active now</span>
        <span className="legend-key"><i data-key="idle" />observed / idle</span>
        <span className="legend-key"><i data-key="did" />DID present</span>
        <span className="legend-key"><i data-key="multi" />multi-room</span>
      </div>

      {/* Historical activity, and the replay navigation surface. */}
      <ActivityChart
        session={session}
        version={version}
        now={rightEdge}
        roomFilter={roomFilter}
        onScrub={scrubTo}
      />

      <section className="console">
        <div className="group">
          <button onClick={goLive} data-active={mode === 'live'}>Live</button>
          <button
            onClick={() => setMode((m) => (m === 'paused' ? (session.provenance === 'live' ? 'live' : 'synthetic') : 'paused'))}
            data-active={mode === 'paused'}
          >
            Pause
          </button>
          <button onClick={goReplay} data-active={mode === 'replay'}>Replay</button>
          <button onClick={goDemo} data-active={mode === 'synthetic'}>Demo</button>
        </div>

        <span className="sep" />

        {mode === 'replay' && (
          <>
            <div className="group">
              <button
                onClick={() => setReplayPlaying((p) => !p)}
                data-active={replayPlaying}
                aria-label={replayPlaying ? 'Pause replay' : 'Play replay'}
              >
                {replayPlaying ? 'Pause' : 'Play'}
              </button>
              <button
                onClick={() => {
                  setReplayAt(0);
                  setReplayPlaying(true);
                }}
              >
                Restart
              </button>
            </div>
            <div className="group speeds">
              {REPLAY_SPEEDS.map((s) => (
                <button key={s} onClick={() => setSpeed(s)} data-active={speed === s}>
                  {s}x
                </button>
              ))}
            </div>
            <span className="sep" />
          </>
        )}

        {/* Room filters stay available in every mode: they scope the swarm and the chart. */}
        <div className="rooms">
          <button onClick={() => setRoomFilter(null)} data-active={roomFilter === null}>All</button>
          {activeRooms.slice(0, 8).map((room) => (
            <button
              key={room}
              onClick={() => setRoomFilter(room === roomFilter ? null : room)}
              data-active={room === roomFilter}
              style={{ color: room === roomFilter ? undefined : roomColor(room) }}
            >
              <i style={{ background: roomColor(room) }} />
              {room}
            </button>
          ))}
          {activeRooms.length > 8 && (
            <span className="rooms-more">+{activeRooms.length - 8} more</span>
          )}
        </div>

        <span className="sep" />

        <div className="group">
          <button onClick={exportSession}>Export session</button>
          <button onClick={() => fileRef.current?.click()}>Import session</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importSession(file);
              e.target.value = '';
            }}
          />
        </div>

        <span className="creed">OBSERVED != COMPLETE</span>
      </section>

      <details className="about">
        <summary>About this view</summary>
        <ul>
          <li>A passive public Technocore observer. It reads; it never writes, signs or holds a key.</li>
          <li>Technocore room history is bounded: old messages are evicted upstream.</li>
          <li>Observed activity is <b>not</b> guaranteed complete.</li>
          <li>Known observation gaps are shown rather than silently hidden.</li>
          <li>Activity before cold start is outside this session&rsquo;s coverage claim.</li>
          <li>Gap sizes count <b>sequence positions</b>, not confirmed lost messages.</li>
          <li>Private and unlisted rooms are never inferred or probed.</li>
          <li>Sender labels are session-local. They are not real-world identity claims.</li>
          <li>DID presence alone is not reputation, human identity or trust.</li>
          <li>URLs inside messages are inert display data and are never followed.</li>
          <li>Synthetic demo data is never mixed into a live session.</li>
          <li>Protocol verified against technocore-chat @ <b>{UPSTREAM_MAIN_SHA.slice(0, 12)}</b>.</li>
        </ul>
      </details>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'warn' | 'gap';
}) {
  return (
    <div className="metric" data-tone={tone}>
      <b>{typeof value === 'number' ? value.toLocaleString() : value}</b>
      <small>{label}</small>
    </div>
  );
}
