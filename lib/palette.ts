/**
 * Session-stable room colours.
 *
 * A room keeps its colour for as long as the session lives, so a viewer can learn the
 * field. The palette is small and deliberately low-contrast against the background, with
 * red reserved: red means a coverage gap, never a room.
 */

const ROOM_COLORS = [
  '#35e6ff',
  '#7cf7c4',
  '#ffd166',
  '#b79cff',
  '#5fa8ff',
  '#8ce99a',
  '#f6a5c0',
  '#a0e7e5',
  '#e5c185',
  '#9fb8ff',
  '#c9d6a3',
  '#d9c2ff',
] as const;

/** Stable hash so a room's colour does not depend on discovery order. */
function hash(room: string): number {
  let h = 2166136261;
  for (let i = 0; i < room.length; i++) {
    h ^= room.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % ROOM_COLORS.length;
}

export function roomColor(room: string): string {
  return ROOM_COLORS[hash(room)];
}

export const GAP_COLOR = '#ff3f6f';
export const START_COLOR = '#ffb347';
