// DSK-003: public barrel of the frozen dsk.v1 contract. Consumers (main process via esbuild
// bundling, tests via source import and via a CJS esbuild bundle, renderer types via desktop-types)
// all import from here. Pure module: no DOM, Electron, Node or filesystem imports.
export { DSK_CONTRACT_VERSION } from './version.ts';
export {
    DSK_SCHEMAS,
    SUITES,
    WORKFLOW_STAGES,
    WORKFLOW_EVENT_TYPES,
    StorySpecSchema,
    ShotPlanSchema,
    ModelShotProposalSchema,
    CompiledShotProposalSchema,
    DskOperationSchema,
    DskOperationKindSchema,
    WorkflowStateSchema,
    WorkflowEventSchema,
    ApprovalSchema,
    SnapshotRefSchema,
    ProviderRequestSchema,
    ProviderResponseSchema,
    ProviderUsageSchema,
    BudgetSchema,
    RoleIdSchema,
    EntityIdSchema,
} from './schema.ts';
export {
    DSK_ACTIONS,
    DSK_ACTION_PAYLOAD_SCHEMAS,
    DSK_MAX_PAYLOAD_CHARS,
    DSK_MAX_PAYLOAD_DEPTH,
    DSK_MAX_PAYLOAD_NODES,
    dispatchDskRequest,
    isTrustedDskFrame,
    scanDskPayload,
} from './actions.ts';
export type {
    DskAction,
    DskActionHandler,
    DskActionHandlers,
    DskActionPayloads,
    DskError,
    DskResult,
} from './actions.ts';
export type {
    RoleId,
    EntityId,
    StorySpec,
    ShotPlan,
    ModelShotProposal,
    DskOperationKind,
    DskCompiledOperation,
    CompiledShotProposal,
    WorkflowState,
    WorkflowEvent,
    Budget,
    Approval,
    SnapshotRef,
    ProviderUsage,
    ProviderRequest,
    ProviderResponse,
} from './dto.ts';
