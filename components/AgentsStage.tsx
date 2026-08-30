'use client';

/**
 * AGENTS: the population view.
 *
 * The narrative counterpart to the swarm field. Every observed sender becomes one small
 * agent standing in a single shared arena — one continuous field, no per-room panels — so
 * the view reads as one crowd rather than as a set of dashboards. Room membership travels
 * with the agent instead of dividing the space: its colour, the legend, the hover card and
 * the filters all carry it. An agent idles with a slow bob, brightens and pops when an
 * observation lands on it, and a sampled few speak in short quote bubbles above their heads.
 *
 * The same rules as the swarm canvas apply. One canvas, one requestAnimationFrame loop,
 * no DOM per agent. Everything drawn is derived from `lib/agentsModel`, which reads the
 * same observation session the rest of the app reads, so what is on screen is exactly
 * what a test can assert on. Motion that is not the idle bob always corresponds to a real
 * — or replayed — observation; the bob is the only ambient animation, and it carries no
 * information.
 *
 * Bubble text arrives pre-sanitized and pre-truncated from the model and is painted with
 * `fillText`. It is never markup, never parsed, and no URL in it is ever followed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservationSessionState } from '@/lib/session';
import type { ObservedSender } from '@/lib/types';
import { roomColor } from '@/lib/palette';
import {
  buildAgentsLayout,
  sampleAgentBubbles,
  sampleAgentsState,
  type AgentBubble,
  type AgentsLayout,
  type AgentsState,
} from '@/lib/agentsModel';

const PAD_X = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
/**
 * Agent body half-width bounds, in CSS pixels.
 *
 * The floor is deliberately low: one shared arena holding a thousand agents has to shrink
 * the glyph rather than drop anyone, and at this size the lozenge fallback still reads as a
 * body. The ceiling keeps a nearly empty arena from turning into a handful of billboards.
 */
const AGENT_MIN = 2.1;
const AGENT_MAX = 7.5;
/** Below this body size the detailed minion is replaced by a simple lozenge. */
const DETAIL_THRESHOLD = 3.4;
/** Idle bob amplitude, as a multiple of body size. Deliberately small. */
const BOB = 0.34;
/** Arena grid spacing, in CSS pixels. A faint technical floor, not a room boundary. */
const GRID_STEP = 46;
/** Dim factor applied to every agent other than the focused one. */
const DIM = 0.16;
/** Upward nudges attempted before a bubble accepts an overlap. */
const BUBBLE_ATTEMPTS = 4;

export interface AgentsStageProps {
  session: ObservationSessionState;
  /** Bumped by the host on session mutation, so the layout is rebuilt. */
  version: number;
  /** The instant the stage represents. Live clock or replay playhead. */
  now: number;
  roomFilter: string | null;
  /** Sender id under focus, or `null`. */
  focused: string | null;
  onFocus: (senderId: string | null) => void;
  paused: boolean;
}

interface Hover {
  x: number;
  y: number;
  sender: ObservedSender;
}

export default function AgentsStage(props: AgentsStageProps) {
  const { session, version, now, roomFilter, focused, onFocus, paused } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const live = useRef({ session, now, roomFilter, focused, paused });
  live.current = { session, now, roomFilter, focused, paused };

  /**
   * Layout is rebuilt only when the session's shape changes, never per frame: rebuilding
   * per frame is what would make agents teleport as new ones arrive.
   */
  const layoutRef = useRef<{ layout: AgentsLayout; senders: number; rooms: number } | null>(null);
  const layoutFor = useCallback((s: ObservationSessionState): AgentsLayout => {
    const cached = layoutRef.current;
    if (cached && cached.senders === s.senders.size && cached.rooms === s.rooms.size) {
      return cached.layout;
    }
    const layout = buildAgentsLayout(s);
    layoutRef.current = { layout, senders: s.senders.size, rooms: s.rooms.size };
    return layout;
  }, []);

  // Reused across frames so a populated stage does not allocate per agent per frame.
  const stateRef = useRef<AgentsState | null>(null);
  /** Screen geometry of the last frame, shared with hit-testing. */
  const geom = useRef({ x0: 0, y0: 0, w: 1, h: 1, body: AGENT_MIN });
  /**
   * Bob clock. Frozen while paused, so PAUSE actually stops the stage instead of leaving
   * it breathing.
   */
  const bobClock = useRef(0);
  const lastFrameAt = useRef<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const { session: s, now: at, roomFilter: filter, focused: focusId, paused: isPaused } =
      live.current;

    const frameAt = performance.now();
    const delta = lastFrameAt.current === null ? 0 : frameAt - lastFrameAt.current;
    lastFrameAt.current = frameAt;
    if (!isPaused) bobClock.current += Math.min(delta, 64);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const layout = layoutFor(s);
    const state = sampleAgentsState(s, layout, at, {
      roomFilter: filter,
      into: stateRef.current ?? undefined,
    });
    stateRef.current = state;
    const bubbles = sampleAgentBubbles(s, layout, at, { roomFilter: filter });

    const fieldX = PAD_X;
    const fieldY = PAD_TOP;
    const fieldW = cssW - PAD_X * 2;
    const fieldH = cssH - PAD_TOP - PAD_BOTTOM;
    if (fieldW <= 0 || fieldH <= 0) return;

    // One scale for the whole arena: it is one space, so a single density figure governs
    // it. Falls with population, floors at the legibility limit rather than dropping or
    // stacking agents.
    const present = Math.max(state.presentCount, 1);
    const body = Math.max(
      AGENT_MIN,
      Math.min(AGENT_MAX, Math.sqrt((fieldW * fieldH) / present) * 0.21),
    );
    geom.current = { x0: fieldX, y0: fieldY, w: fieldW, h: fieldH, body };
    const px = (u: number) => fieldX + u * fieldW;
    const py = (v: number) => fieldY + v * fieldH;

    const focusSlot = focusId === null ? -1 : (layout.slotOf.get(focusId) ?? -1);
    const detailed = body >= DETAIL_THRESHOLD;
    const t = bobClock.current / 1000;

    // ── arena ──────────────────────────────────────────────────────────
    // One continuous environment: a dark ground, a faint technical grid, a single horizon
    // band and a vignette. Deliberately no cards, panels or room rectangles — the crowd
    // has to read as one population, and any internal box would break that instantly.
    drawArena(ctx, fieldX, fieldY, fieldW, fieldH);

    // ── agents ─────────────────────────────────────────────────────────
    // One pass, back rows first, so a foreground agent overlaps the one behind it and the
    // arena reads as a crowd with depth.
    const order = drawOrder(layout);
    for (const i of order) {
      if (state.present[i] === 0) continue;
      const d = layout.room[i];
      if (layout.x[i] < 0) continue;

      const heat = state.heat[i];
      const pulse = state.pulse[i];
      const spawn = state.spawn[i];
      // Focus dims the rest of the population rather than the rest of a district: there
      // are no districts, so emphasis is per agent.
      const dimmed = focusSlot >= 0 && i !== focusSlot;
      // Room colour rides on the agent. `lastRoom` is the room of its most recent
      // observation in the window, so an agent seen elsewhere recolours in place instead
      // of moving.
      const roomIndex = state.lastRoom[i] >= 0 ? state.lastRoom[i] : d;
      const color = roomIndex >= 0 ? roomColor(layout.rooms[roomIndex].room) : '#4a5a68';

      // Depth: the back rows sit slightly smaller and dimmer.
      const depthScale = 0.78 + layout.depth[i] * 0.28;
      // Arrival: a new agent drops in and settles, which is what makes a growing session
      // visibly grow rather than silently gain dots.
      const spawnEase = spawn > 0 ? 1 - spawn * spawn : 1;
      const popScale = 1 + pulse * 0.42 + heat * 0.14;
      const r = body * depthScale * spawnEase * popScale;

      const x = px(layout.x[i]);
      const bobOffset = Math.sin(t * (1.1 + layout.depth[i] * 0.35) + layout.phase[i]) * r * BOB;
      const dropIn = spawn > 0 ? -spawn * spawn * body * 4.5 : 0;
      const y = py(layout.y[i]) + bobOffset + dropIn;

      const alpha =
        (0.34 + layout.depth[i] * 0.1 + heat * 0.6) * (dimmed ? DIM : 1) * (0.35 + spawnEase * 0.65);

      // Glow for genuinely active agents only, so the stage breathes with activity rather
      // than everywhere at once.
      if (heat > 0.3 && !dimmed) {
        ctx.fillStyle = withAlpha(color, 0.1 * heat);
        ctx.beginPath();
        ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Contact shadow. Cheap, and it is what anchors the agent to the ground.
      if (detailed && !dimmed) {
        ctx.fillStyle = withAlpha('#000000', 0.3);
        ctx.beginPath();
        ctx.ellipse(x, py(layout.y[i]) + r * 1.5, r * 0.85, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (detailed) {
        drawAgent(ctx, x, y, r, color, alpha, heat, layout.didPresent[i] === 1);
      } else {
        // Low-detail fallback: a lozenge with a visor tick. Keeps a thousand-agent stage
        // affordable while still reading as a body rather than as a dot.
        ctx.fillStyle = withAlpha(color, alpha);
        roundRect(ctx, x - r * 0.62, y - r, r * 1.24, r * 2, r * 0.55);
        ctx.fill();
        if (heat > 0.2) {
          ctx.fillStyle = withAlpha('#e6f1f7', 0.5 * heat);
          ctx.fillRect(x - r * 0.36, y - r * 0.34, r * 0.72, Math.max(1, r * 0.26));
        }
      }

      // DID present: a thin halo. Literal `did:key:` prefix presence and nothing more —
      // not identity, not reputation, not trust.
      if (layout.didPresent[i] === 1 && (heat > 0.1 || detailed)) {
        ctx.strokeStyle = withAlpha(color, (0.1 + heat * 0.4) * (dimmed ? 0.25 : 1));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y - r * 1.5, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Multi-room: a wider ground ring. The same observed identifier appeared in more
      // than one room this session.
      if (layout.multiRoom[i] === 1 && heat > 0.18 && !dimmed) {
        ctx.strokeStyle = withAlpha('#e6f1f7', 0.2 * heat);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, py(layout.y[i]) + r * 1.5, r * 1.5, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Pop ring: one per fresh observation.
      if (pulse > 0 && !dimmed) {
        const grow = 1 - pulse;
        ctx.strokeStyle = withAlpha(color, 0.55 * pulse);
        ctx.lineWidth = Math.max(1, r * 0.22 * pulse);
        ctx.beginPath();
        ctx.arc(x, y, r * (1.2 + grow * 4.2), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Arrival flash, so a first observation is visibly a first observation.
      if (spawn > 0 && !dimmed) {
        ctx.strokeStyle = withAlpha('#e6f1f7', 0.4 * spawn);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.6 + (1 - spawn) * 2.4), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── focus emphasis ─────────────────────────────────────────────────
    if (focusSlot >= 0 && layout.x[focusSlot] >= 0 && state.present[focusSlot] === 1) {
      const x = px(layout.x[focusSlot]);
      const y = py(layout.y[focusSlot]);
      ctx.strokeStyle = '#35e6ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, body * 3.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── quote bubbles ──────────────────────────────────────────────────
    // Drawn last so they always sit above the crowd. Sampled and capped by the model; the
    // only work here is keeping the few on screen from overlapping each other.
    const placed: Rect[] = [];
    for (const bubble of bubbles) {
      if (state.present[bubble.slot] === 0) continue;
      if (focusSlot >= 0 && bubble.slot !== focusSlot) continue;
      drawBubble(
        ctx,
        bubble,
        px(layout.x[bubble.slot]),
        py(layout.y[bubble.slot]),
        body,
        fieldX,
        fieldY,
        fieldW,
        placed,
      );
    }

    // ── arena readout ──────────────────────────────────────────────────
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#4a5a68';
    const overflowNote = layout.overflow > 0 ? ` · +${layout.overflow} BEYOND ARENA` : '';
    ctx.fillText(
      `${state.presentCount.toLocaleString()} OBSERVED AGENTS · ${state.activeCount.toLocaleString()} ACTIVE NOW · ${layout.rooms.length.toLocaleString()} ROOMS${overflowNote}`,
      fieldX + 2,
      cssH - 6,
    );
  }, [layoutFor]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  // A replaced session must not keep the previous session's layout.
  useEffect(() => {
    layoutRef.current = null;
    stateRef.current = null;
  }, [session]);

  /** Nearest agent to the pointer, within a generous radius. */
  const hitTest = useCallback((clientX: number, clientY: number): Hover | null => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current?.layout;
    if (!canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { x0, y0, w, h, body } = geom.current;
    const reach = Math.max(body * 3, 10);
    let best = -1;
    let bestDist = reach * reach;
    const state = stateRef.current;
    for (let i = 0; i < layout.count; i++) {
      if (layout.x[i] < 0) continue;
      if (state && state.present[i] === 0) continue;
      const dx = x0 + layout.x[i] * w - mx;
      const dy = y0 + layout.y[i] * h - my;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best < 0) return null;
    const sender = live.current.session.senders.get(layout.ids[best]);
    return sender ? { x: mx, y: my, sender } : null;
  }, []);

  // ESC leaves focus mode.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, onFocus]);

  const senderCount = session.senders.size;
  const emptyMessage = useMemo(() => {
    if (senderCount > 0) return null;
    return paused ? 'PAUSED — NO AGENTS OBSERVED YET' : 'AWAITING FIRST OBSERVATION';
  }, [senderCount, paused]);

  return (
    <div className="field agents" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => setHover(hitTest(e.clientX, e.clientY))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = hitTest(e.clientX, e.clientY);
          onFocus(hit && hit.sender.id !== focused ? hit.sender.id : null);
        }}
        aria-label={`Agent population: ${senderCount} observed senders across ${session.rooms.size} rooms, ${session.messages.length} observations`}
        role="img"
        data-version={version}
      />
      {emptyMessage && (
        <div className="empty">
          <span>{emptyMessage}</span>
          <span style={{ color: 'var(--ink-faint)' }}>OBSERVED != COMPLETE</span>
        </div>
      )}
      {hover && <AgentCard hover={hover} wrap={wrapRef.current} />}
    </div>
  );
}

/**
 * Draw order: back rows first.
 *
 * Cached on the layout object, since it only changes when the layout is rebuilt.
 */
const orderCache = new WeakMap<AgentsLayout, Int32Array>();
function drawOrder(layout: AgentsLayout): Int32Array {
  const cached = orderCache.get(layout);
  if (cached) return cached;
  const order = Int32Array.from({ length: layout.count }, (_, i) => i);
  const sorted = Array.from(order).sort((a, b) => layout.y[a] - layout.y[b]);
  const result = Int32Array.from(sorted);
  orderCache.set(layout, result);
  return result;
}

/**
 * One agent: a rounded body, a visor band, a pair of ground ticks and — when active — a
 * small antenna. Primitives only; no sprites, no images, no per-agent DOM.
 */
function drawAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
  heat: number,
  did: boolean,
): void {
  // Legs: two short ticks. Read as "standing" at a glance.
  ctx.strokeStyle = withAlpha(color, alpha * 0.7);
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.34, y + r * 0.9);
  ctx.lineTo(x - r * 0.34, y + r * 1.45);
  ctx.moveTo(x + r * 0.34, y + r * 0.9);
  ctx.lineTo(x + r * 0.34, y + r * 1.45);
  ctx.stroke();

  // Body.
  ctx.fillStyle = withAlpha(color, alpha);
  roundRect(ctx, x - r * 0.72, y - r * 0.95, r * 1.44, r * 1.95, r * 0.62);
  ctx.fill();

  // Visor: a bright band across the head. The single feature that gives the glyph a face.
  ctx.fillStyle = withAlpha('#02040a', 0.55 + heat * 0.2);
  roundRect(ctx, x - r * 0.52, y - r * 0.5, r * 1.04, r * 0.46, r * 0.2);
  ctx.fill();
  ctx.fillStyle = withAlpha(heat > 0.25 ? '#e6f1f7' : color, 0.35 + heat * 0.65);
  roundRect(ctx, x - r * 0.42, y - r * 0.42, r * 0.84, r * 0.28, r * 0.14);
  ctx.fill();

  // Antenna: only while active, so a talking agent is distinguishable at a distance.
  if (heat > 0.22) {
    ctx.strokeStyle = withAlpha(color, 0.5 + heat * 0.5);
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.95);
    ctx.lineTo(x, y - r * 1.5);
    ctx.stroke();
    ctx.fillStyle = withAlpha('#e6f1f7', 0.4 + heat * 0.6);
    ctx.beginPath();
    ctx.arc(x, y - r * 1.62, Math.max(0.8, r * 0.2), 0, Math.PI * 2);
    ctx.fill();
  }

  // DID present: a small notch on the shoulder, in addition to the halo drawn by the
  // caller, so the distinction is not carried by a single faint ellipse alone.
  if (did && r > 4.5) {
    ctx.fillStyle = withAlpha('#e6f1f7', 0.22 + heat * 0.3);
    ctx.fillRect(x + r * 0.5, y + r * 0.1, Math.max(1, r * 0.22), Math.max(1, r * 0.22));
  }
}

/**
 * The shared arena floor.
 *
 * One continuous environment for the entire population: a cool ground gradient, a faint
 * technical grid, a single horizon band and a soft vignette. There is deliberately nothing
 * here that subdivides the space — no cards, no panels, no room rectangles — because the
 * whole point of this view is that the eye reads one crowd. Room identity is carried by the
 * agents themselves and by the legend beneath the field.
 */
function drawArena(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  roundRect(ctx, x, y, w, h, 14);
  ctx.clip();

  // Ground: darker at the back, so the field has a direction without needing a boundary.
  const ground = ctx.createLinearGradient(x, y, x, y + h);
  ground.addColorStop(0, 'rgba(8,14,24,0.92)');
  ground.addColorStop(0.55, 'rgba(10,18,29,0.72)');
  ground.addColorStop(1, 'rgba(6,11,19,0.9)');
  ctx.fillStyle = ground;
  ctx.fillRect(x, y, w, h);

  // Technical grid. Rows compress towards the back, which does most of the work of making
  // a flat scatter of glyphs read as a floor that agents are standing on.
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(53,230,255,0.045)';
  ctx.beginPath();
  for (let gx = x + GRID_STEP; gx < x + w; gx += GRID_STEP) {
    const gridX = Math.round(gx) + 0.5;
    ctx.moveTo(gridX, y);
    ctx.lineTo(gridX, y + h);
  }
  for (let row = 1; row < 14; row++) {
    const v = Math.pow(row / 14, 1.55);
    const gridY = Math.round(y + v * h) + 0.5;
    ctx.moveTo(x, gridY);
    ctx.lineTo(x + w, gridY);
  }
  ctx.stroke();

  // Horizon: a single soft band near the back. Atmosphere, not a container.
  const horizon = ctx.createLinearGradient(x, y, x, y + h * 0.3);
  horizon.addColorStop(0, 'rgba(53,230,255,0.07)');
  horizon.addColorStop(1, 'rgba(53,230,255,0)');
  ctx.fillStyle = horizon;
  ctx.fillRect(x, y, w, h * 0.3);

  // Vignette, so the crowd fades into the field instead of ending at a hard edge.
  const vignette = ctx.createRadialGradient(
    x + w / 2,
    y + h * 0.55,
    Math.min(w, h) * 0.25,
    x + w / 2,
    y + h * 0.55,
    Math.max(w, h) * 0.62,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(2,4,10,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  // A single hairline boundary for the arena as a whole: one frame around one space.
  ctx.strokeStyle = 'rgba(53,230,255,0.1)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
  ctx.stroke();
}

/** An axis-aligned box, used only for keeping the few live bubbles off each other. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A short-lived quote bubble.
 *
 * `bubble.text` is already sanitized and truncated by the model. It is painted as plain
 * text; nothing here parses it, and no URL inside it is ever resolved or followed.
 *
 * Placement nudges upward while the candidate box overlaps one already placed. With at most
 * `BUBBLE_MAX` bubbles on screen this is a handful of comparisons per frame — deliberately
 * a small heuristic rather than a layout solver, since the alternative to a rare overlap is
 * a physics engine nobody needs.
 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  bubble: AgentBubble,
  x: number,
  y: number,
  body: number,
  fieldX: number,
  fieldY: number,
  fieldW: number,
  placed: Rect[],
): void {
  // Ease in fast, hold, fade out. Never a hard pop-out.
  const fade = bubble.age < 0.12 ? bubble.age / 0.12 : bubble.age > 0.7 ? (1 - bubble.age) / 0.3 : 1;
  const alpha = Math.max(0, Math.min(1, fade));
  if (alpha <= 0.01) return;

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = 6;
  const textW = ctx.measureText(bubble.text).width;
  const w = textW + padX * 2;
  const h = 17;
  // Rise as it ages, and keep the whole bubble inside the field rather than clipping it.
  let cy = y - body * 3.2 - 8 - bubble.age * 6;
  const cx = Math.max(fieldX + 2, Math.min(fieldX + fieldW - w - 2, x - w / 2));

  // Lift clear of earlier bubbles, but never out of the arena: an overlap is a smaller
  // problem than a bubble floating outside the field.
  for (let attempt = 0; attempt < BUBBLE_ATTEMPTS; attempt++) {
    const box: Rect = { x: cx, y: cy - h / 2, w, h };
    const clash = placed.find((p) => overlaps(p, box));
    if (!clash) break;
    const lifted = clash.y - h / 2 - 3;
    if (lifted - h / 2 < fieldY + 2) break;
    cy = lifted;
  }
  placed.push({ x: cx, y: cy - h / 2, w, h });

  ctx.fillStyle = withAlpha('#070c14', 0.9 * alpha);
  roundRect(ctx, cx, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#35e6ff', 0.3 * alpha);
  ctx.lineWidth = 1;
  roundRect(ctx, cx + 0.5, cy - h / 2 + 0.5, w - 1, h - 1, 5);
  ctx.stroke();

  // Tail, pointing back at the speaking agent.
  const tailX = Math.max(cx + 5, Math.min(cx + w - 5, x));
  ctx.fillStyle = withAlpha('#070c14', 0.9 * alpha);
  ctx.beginPath();
  ctx.moveTo(tailX - 3.5, cy + h / 2 - 0.5);
  ctx.lineTo(tailX + 3.5, cy + h / 2 - 0.5);
  ctx.lineTo(tailX, cy + h / 2 + 4.5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = withAlpha('#cfe6f2', 0.92 * alpha);
  ctx.fillText(bubble.text, cx + padX, cy);
}

/** Box overlap, with a small margin so two bubbles never merely touch. */
function overlaps(a: Rect, b: Rect): boolean {
  const gap = 2;
  return (
    a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  );
}

/** Agent inspection card. Every value is text; nothing here is ever markup. */
function AgentCard({ hover, wrap }: { hover: Hover; wrap: HTMLDivElement | null }) {
  const width = wrap?.clientWidth ?? 0;
  const height = wrap?.clientHeight ?? 0;
  const flipX = hover.x > width - 330;
  const flipY = hover.y > height - 210;
  const s = hover.sender;
  return (
    <div
      className="inspect"
      style={{
        left: flipX ? undefined : hover.x + 16,
        right: flipX ? width - hover.x + 16 : undefined,
        top: flipY ? undefined : hover.y + 14,
        bottom: flipY ? height - hover.y + 14 : undefined,
      }}
    >
      <h4>Observed agent</h4>
      <dl>
        <dt>Sender</dt>
        <dd>{s.label}</dd>
        <dt>First observed</dt>
        <dd>{new Date(s.firstObservedAt).toLocaleTimeString()}</dd>
        <dt>Last observed</dt>
        <dd>{new Date(s.lastObservedAt).toLocaleTimeString()}</dd>
        <dt>Messages observed</dt>
        <dd>{s.messageCount.toLocaleString()}</dd>
        <dt>Rooms observed</dt>
        <dd>{s.roomsObserved.length}</dd>
        <dt>Latest room</dt>
        <dd>{s.latestRoom}</dd>
        <dt>DID present</dt>
        <dd>{s.didPresent ? 'YES' : 'NO'}</dd>
      </dl>
      <p>A session-local label. Not an identity, reputation or trust claim.</p>
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** `#rrggbb` plus alpha, as an `rgba()` string. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
