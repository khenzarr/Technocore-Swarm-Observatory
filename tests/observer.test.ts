import { describe, expect, it } from 'vitest';
import { applyRoomRead, createRoomState, knownSessionCoverage } from '@/lib/observer';
import type { RoomReadInput } from '@/lib/observer';
import type { ObservedRoom } from '@/lib/types';

const NONE: ReadonlySet<number> = new Set();

function read(partial: Partial<RoomReadInput> & { firstSeq: number | null; lastSeq: number }): RoomReadInput {
  return {
    room: 'lobby',
    seqs: [],
    observedAt: 1_700_000_000_000,
    ...partial,
  };
}

describe('cold start', () => {
  it('does not record a gap when there is no prior cursor', () => {
    const result = applyRoomRead(
      createRoomState('lobby'),
      read({ firstSeq: 163_993, lastSeq: 164_000, seqs: [163_993, 164_000] }),
      NONE,
    );

    expect(result.events.map((e) => e.kind)).toEqual(['observation-start']);
    expect(result.events[0].missingSequencePositions).toBe(0);
    expect(result.room.knownMissingSequencePositions).toBe(0);
    expect(result.room.gapCount).toBe(0);
  });

  it('keeps observation start distinct from a sequence gap', () => {
    // A cold start at a high sequence must not be reported as "gap 1..163992".
    const result = applyRoomRead(
      createRoomState('lobby'),
      read({ firstSeq: 163_993, lastSeq: 163_993, seqs: [163_993] }),
      NONE,
    );

    const event = result.events[0];
    expect(event.kind).toBe('observation-start');
    expect(event.kind).not.toBe('gap');
    expect(event.previousCursor).toBeNull();
    expect(event.expectedNextSeq).toBeNull();
    // Distinct from a cursor of 0: null means "no claim", not "started at zero".
    expect(createRoomState('lobby').cursor).toBeNull();
    expect(createRoomState('lobby').cursor).not.toBe(0);
  });

  it('leaves the cursor null when the first read returns an empty tail', () => {
    const result = applyRoomRead(
      createRoomState('quiet'),
      read({ room: 'quiet', firstSeq: null, lastSeq: 0, seqs: [] }),
      NONE,
    );
    expect(result.room.cursor).toBeNull();
    expect(result.events.map((e) => e.kind)).toEqual(['observation-start']);
  });
});

describe('gap detection', () => {
  it('records gap 3..7 for prior cursor 2 and first_seq 8', () => {
    const prev = { ...createRoomState('lobby'), cursor: 2, lastObservedSeq: 2, firstObservedSeq: 1 };
    const result = applyRoomRead(prev, read({ firstSeq: 8, lastSeq: 9, seqs: [8, 9] }), NONE);

    const gap = result.events.find((e) => e.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap!.previousCursor).toBe(2);
    expect(gap!.expectedNextSeq).toBe(3);
    expect(gap!.firstReadableSeq).toBe(8);
    // Positions 3,4,5,6,7 — five sequence positions, not five known messages.
    expect(gap!.missingSequencePositions).toBe(5);
    expect(result.room.knownMissingSequencePositions).toBe(5);
    expect(result.room.gapCount).toBe(1);
  });

  it('records the gap against the pre-advance cursor, not the advanced one', () => {
    const prev = { ...createRoomState('lobby'), cursor: 2 };
    const result = applyRoomRead(prev, read({ firstSeq: 8, lastSeq: 9, seqs: [8, 9] }), NONE);

    const gap = result.events.find((e) => e.kind === 'gap')!;
    // The event describes the cursor as it was before this read; the state has moved on.
    expect(gap.previousCursor).toBe(2);
    expect(result.room.cursor).toBe(9);
    expect(gap.previousCursor).not.toBe(result.room.cursor);
  });

  it('still advances the cursor to the readable last_seq after a gap', () => {
    const prev = { ...createRoomState('lobby'), cursor: 2 };
    const result = applyRoomRead(prev, read({ firstSeq: 8, lastSeq: 9, seqs: [8, 9] }), NONE);

    expect(result.room.cursor).toBe(9);
    // The readable tail is processed rather than discarded.
    expect(result.acceptedSeqs).toEqual([8, 9]);
    expect(result.room.messagesObserved).toBe(2);
  });

  it('keeps the session marked incomplete after a gap', () => {
    let state: ObservedRoom = { ...createRoomState('lobby'), cursor: 2 };
    state = applyRoomRead(state, read({ firstSeq: 8, lastSeq: 9, seqs: [8, 9] }), NONE).room;
    // A later clean read must not erase the recorded incompleteness.
    state = applyRoomRead(state, read({ firstSeq: 10, lastSeq: 11, seqs: [10, 11] }), new Set([8, 9])).room;

    expect(state.gapCount).toBe(1);
    expect(state.knownMissingSequencePositions).toBe(5);
  });

  it('treats a contiguous read as clean', () => {
    const prev = { ...createRoomState('lobby'), cursor: 7 };
    const result = applyRoomRead(prev, read({ firstSeq: 8, lastSeq: 10, seqs: [8, 9, 10] }), NONE);

    expect(result.events).toHaveLength(0);
    expect(result.room.gapCount).toBe(0);
    expect(result.room.cursor).toBe(10);
  });

  it('does not treat an empty tail as a gap or a regression', () => {
    // An empty read echoes the caller's cursor back as last_seq with first_seq null.
    const prev = { ...createRoomState('lobby'), cursor: 42 };
    const result = applyRoomRead(prev, read({ firstSeq: null, lastSeq: 42, seqs: [] }), NONE);

    expect(result.events).toHaveLength(0);
    expect(result.room.cursor).toBe(42);
  });
});

describe('epoch reset', () => {
  it('classifies a sequence rollback as an epoch reset rather than a gap', () => {
    const prev = { ...createRoomState('lobby'), cursor: 500, generation: 1 };
    const result = applyRoomRead(prev, read({ firstSeq: 3, lastSeq: 6, seqs: [3, 4, 5, 6], generation: 2 }), NONE);

    expect(result.events.map((e) => e.kind)).toEqual(['epoch-reset']);
    expect(result.room.gapCount).toBe(0);
    expect(result.room.knownMissingSequencePositions).toBe(0);
    expect(result.room.cursor).toBe(6);
  });
});

describe('deduplication', () => {
  it('drops sequences already observed in this session', () => {
    const prev = { ...createRoomState('lobby'), cursor: 10, messagesObserved: 3 };
    const result = applyRoomRead(
      prev,
      read({ firstSeq: 9, lastSeq: 13, seqs: [9, 10, 11, 12, 13] }),
      new Set([9, 10, 11]),
    );

    expect(result.acceptedSeqs).toEqual([12, 13]);
    expect(result.duplicateSeqs).toEqual([9, 10, 11]);
    expect(result.room.messagesObserved).toBe(5);
  });

  it('drops repeats within a single response', () => {
    const result = applyRoomRead(
      { ...createRoomState('lobby'), cursor: 1 },
      read({ firstSeq: 2, lastSeq: 3, seqs: [2, 2, 3, 3, 3] }),
      NONE,
    );

    expect(result.acceptedSeqs).toEqual([2, 3]);
    expect(result.duplicateSeqs).toEqual([2, 3, 3]);
  });
});

describe('session coverage', () => {
  it('is null before anything is observed', () => {
    expect(knownSessionCoverage([createRoomState('lobby')])).toBeNull();
  });

  it('reports a fraction below 1 when positions are known missing', () => {
    const coverage = knownSessionCoverage([
      {
        ...createRoomState('lobby'),
        firstObservedSeq: 1,
        lastObservedSeq: 10,
        messagesObserved: 5,
      },
    ]);
    expect(coverage).toBeCloseTo(0.5);
  });
});
