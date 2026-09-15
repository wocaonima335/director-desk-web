// DSK-003: pure DTO types for the frozen dsk.v1 pipeline contract.
// Every type is DERIVED from the matching runtime schema, so the type layer and the validator
// cannot drift apart (acceptance A1: 类型与运行时校验互相一致). Plain data only: no methods,
// no classes, no DOM/Electron/Node types. roleId (casting identity) and entityId (per-shot
// engine instance) are distinct branded string types.
import type { z } from 'zod';
import type {
    ApprovalSchema,
    CompiledShotProposalSchema,
    DskErrorSchema,
    DskOperationKindSchema,
    EntityIdSchema,
    ModelShotProposalSchema,
    DskOperationSchema,
    ProviderRequestSchema,
    ProviderResponseSchema,
    ProviderUsageSchema,
    RoleIdSchema,
    ShotPlanSchema,
    SnapshotRefSchema,
    StorySpecSchema,
    BudgetSchema,
    WorkflowEventSchema,
    WorkflowStateSchema,
} from './schema.ts';
import type { DskAction, DskActionPayloads } from './actions.ts';
import type { DskContractVersion } from './version.ts';

export type { DskAction, DskActionPayloads, DskContractVersion };
export type DskError = z.infer<typeof DskErrorSchema>;
export type DskResult<T = unknown> = { ok: true; data: T } | { ok: false; error: DskError };

export type RoleId = z.infer<typeof RoleIdSchema>;
export type EntityId = z.infer<typeof EntityIdSchema>;
export type StorySpec = z.infer<typeof StorySpecSchema>;
export type ShotPlan = z.infer<typeof ShotPlanSchema>;
export type ModelShotProposal = z.infer<typeof ModelShotProposalSchema>;
export type DskOperationKind = z.infer<typeof DskOperationKindSchema>;
export type DskCompiledOperation = z.infer<typeof DskOperationSchema>;
export type CompiledShotProposal = z.infer<typeof CompiledShotProposalSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;
