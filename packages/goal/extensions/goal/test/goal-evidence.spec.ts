import { describe, expect, it } from 'vitest';
import {
  completionEvidenceErrors,
  createGoalEvidenceLedger,
  MAX_GOAL_EVIDENCE_LEDGER_BYTES,
  MAX_GOAL_EVIDENCE_PER_REQUIREMENT,
  mutateGoalEvidence,
  parseGoalEvidenceLedger,
  summarizeGoalEvidence,
  type GoalEvidenceLedger,
} from '../src/goal-evidence.ts';

function initialized(): GoalEvidenceLedger {
  return mutateGoalEvidence(
    createGoalEvidenceLedger('goal-1', 1),
    'goal-1',
    {
      action: 'initialize_requirements',
      expectedRevision: 0,
      requirements: [{ id: 'one', requirement: 'Verify the artifact directly' }],
    },
    2,
  );
}

describe('goal evidence ledger', () => {
  it('supports every mutation with optimistic concurrency', () => {
    let ledger = initialized();
    expect(ledger.revision).toBe(1);
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'upsert_requirement',
          expectedRevision: 0,
          requirementId: 'two',
          requirement: 'stale',
        },
        3,
      ),
    ).toThrow(/Stale evidence revision/);

    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'upsert_requirement',
        expectedRevision: 1,
        requirementId: 'two',
        requirement: 'Run the package checks',
      },
      3,
    );
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'add_evidence',
        expectedRevision: 2,
        requirementId: 'one',
        evidence: {
          id: 'source',
          kind: 'file',
          reference: 'src/goal.ts:1',
          claim: 'transition wiring inspected',
        },
      },
      4,
    );
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'set_requirement_status',
        expectedRevision: 3,
        requirementId: 'one',
        status: 'verified',
      },
      5,
    );
    expect(summarizeGoalEvidence(ledger)).toMatchObject({ total: 2, verified: 1, pending: 1 });
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'add_evidence',
        expectedRevision: 4,
        requirementId: 'two',
        evidence: { id: 'temporary', kind: 'log', reference: 'run.log', claim: 'temporary' },
      },
      6,
    );
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'remove_evidence',
        expectedRevision: 5,
        requirementId: 'two',
        evidenceId: 'temporary',
      },
      7,
    );
    expect(ledger.requirements.find((item) => item.id === 'two')?.evidence).toEqual([]);
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'remove_evidence',
          expectedRevision: 6,
          requirementId: 'one',
          evidenceId: 'source',
        },
        6,
      ),
    ).toThrow(/last evidence/);
  });

  it('requires fresh evidence when requirement text changes', () => {
    let ledger = initialized();
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'add_evidence',
        expectedRevision: 1,
        requirementId: 'one',
        evidence: {
          id: 'original',
          kind: 'test',
          reference: 'original.spec.ts',
          claim: 'the original requirement passed',
        },
      },
      3,
    );
    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'set_requirement_status',
        expectedRevision: 2,
        requirementId: 'one',
        status: 'verified',
      },
      4,
    );

    ledger = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'upsert_requirement',
        expectedRevision: 3,
        requirementId: 'one',
        requirement: 'Verify the replacement artifact directly',
      },
      5,
    );

    expect(ledger.requirements[0]).toMatchObject({
      requirement: 'Verify the replacement artifact directly',
      status: 'pending',
      evidence: [],
    });
    expect(completionEvidenceErrors(ledger, 'goal-1')).toEqual(['one is pending, not verified.']);
  });

  it('enforces verified evidence and blocked blocker invariants', () => {
    const ledger = initialized();
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'set_requirement_status',
          expectedRevision: 1,
          requirementId: 'one',
          status: 'verified',
        },
        3,
      ),
    ).toThrow(/at least one evidence/);
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'set_requirement_status',
          expectedRevision: 1,
          requirementId: 'one',
          status: 'blocked',
        },
        3,
      ),
    ).toThrow(/blocker/);
    expect(completionEvidenceErrors(ledger, 'goal-1')).toEqual(['one is pending, not verified.']);
    const blocked = mutateGoalEvidence(
      ledger,
      'goal-1',
      {
        action: 'set_requirement_status',
        expectedRevision: 1,
        requirementId: 'one',
        status: 'blocked',
        blocker: 'Needs user credentials',
      },
      4,
    );
    expect(blocked.requirements[0]).toMatchObject({
      status: 'blocked',
      blocker: 'Needs user credentials',
    });
    expect(completionEvidenceErrors(blocked, 'goal-1')).toEqual(['one is blocked, not verified.']);
  });

  it('bounds evidence and rejects duplicate/unknown/cross-goal IDs', () => {
    let ledger = initialized();
    for (let index = 0; index < MAX_GOAL_EVIDENCE_PER_REQUIREMENT; index += 1) {
      ledger = mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'add_evidence',
          expectedRevision: ledger.revision,
          requirementId: 'one',
          evidence: {
            id: `e-${index}`,
            kind: 'other',
            reference: `artifact-${index}`,
            claim: 'bounded claim',
          },
        },
        index + 3,
      );
    }
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'goal-1',
        {
          action: 'add_evidence',
          expectedRevision: ledger.revision,
          requirementId: 'one',
          evidence: { id: 'overflow', kind: 'other', reference: 'x', claim: 'x' },
        },
        100,
      ),
    ).toThrow(/At most/);
    expect(() =>
      mutateGoalEvidence(
        ledger,
        'other-goal',
        {
          action: 'remove_evidence',
          expectedRevision: ledger.revision,
          requirementId: 'one',
          evidenceId: 'e-0',
        },
        101,
      ),
    ).toThrow(/different goal/);
  });

  it('rejects mutations and persisted ledgers above the aggregate byte limit', () => {
    const requirements = Array.from({ length: 50 }, (_, index) => ({
      id: `requirement-${index}`,
      requirement: 'x'.repeat(2_000),
    }));
    expect(() =>
      mutateGoalEvidence(
        createGoalEvidenceLedger('goal-1', 1),
        'goal-1',
        {
          action: 'initialize_requirements',
          expectedRevision: 0,
          requirements,
        },
        2,
      ),
    ).toThrow(`Evidence ledger cannot exceed ${MAX_GOAL_EVIDENCE_LEDGER_BYTES} serialized bytes.`);

    expect(
      parseGoalEvidenceLedger(
        {
          goalId: 'goal-1',
          revision: 1,
          requirements: requirements.map(({ id, requirement }) => ({
            id,
            requirement,
            status: 'pending',
            evidence: [],
            updatedAt: 2,
          })),
          updatedAt: 2,
        },
        'goal-1',
      ),
    ).toBeNull();
  });

  it('drops malformed persisted ledgers and never stores raw output fields', () => {
    const parsed = parseGoalEvidenceLedger(
      {
        goalId: 'goal-1',
        revision: 0,
        requirements: [
          {
            id: 'one',
            requirement: 'x',
            status: 'verified',
            evidence: [],
            updatedAt: 1,
            commandOutput: 'secret raw output',
          },
        ],
        updatedAt: 1,
      },
      'goal-1',
    );
    expect(parsed).toBeNull();
    expect(JSON.stringify(initialized())).not.toContain('commandOutput');
  });
});
