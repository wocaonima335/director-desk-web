// DSK-003: strict runtime schemas for the frozen dsk.v1 pipeline contract (zod 4.x).
// Rules enforced here (acceptance A1/A2/A4):
// - every object schema is strict: unknown fields are rejected;
// - every top-level DTO carries the contract version literal;
// - roleId and entityId are distinct branded string types with distinct shapes;
// - suite/enum values, finite numbers, ISO timestamps and sha256 hashes are closed sets;
// - shot bounds: single shot 5-15s, multi-shot only 3-5 shots of one scene, each 5-15s,
//   24fps-frame-aligned durations, plan total equals the sum of its shots, multi-shot total 15-75s;
//   a requested shot count n pins the spec total to the exact window 5n-15n seconds (R3);
// - shot plans reject duplicate roleIds entries per shot (R2) and keep roles/entity mappings total;
// - the model-call budget is capped at the approved whole-workflow maximum of 17 requests (R4);
// - model request/response bookkeeping events must carry requestId and stepId (R5);
// - model proposals carry suite/semantic parameters only and cannot express edit operations;
// - compiled proposals reference the plan hash and reuse the engine EditOperation shape,
//   but nothing in this task compiles or executes them (DSK-008 wires that).
// Pure module: no DOM, Electron, Node or filesystem imports.
import { z } from 'zod';
import { DSK_CONTRACT_VERSION } from './version.ts';

const version = z.literal(DSK_CONTRACT_VERSION);
// zod v4 numbers already reject NaN and Infinity; finite-ness is re-asserted by the IPC payload scan.
const number = (min: number, max: number) => z.number().min(min).max(max);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
// Durations snap to the 24fps product grid (acceptance A1: duration constraints stay consistent).
const frameAligned = <T extends z.ZodType<number>>(schema: T) => schema.check((ctx) => {
    if (Math.abs(ctx.value * 24 - Math.round(ctx.value * 24)) > 1e-6)
        ctx.issues.push({ code: 'custom', input: ctx.value, message: '时长必须对齐 24fps 帧网格（1/24 秒的整数倍）' });
});
const isoTimestamp = z.iso.datetime({ offset: true });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '必须是 64 位小写十六进制 sha256');

// Stable casting identity (survives re-generation) versus per-shot engine instance identity.
export const RoleIdSchema = z.string().min(2).max(64).regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'roleId 必须为 2-64 位小写字母、数字或连字符').brand<'DskRoleId'>();
export const EntityIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'entityId 必须为 1-64 位字母开头的标识符').brand<'DskEntityId'>();
export const IdSchema = z.string().min(2).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const DskErrorSchema = z.strictObject({
    code: z.enum(['UNTRUSTED_SENDER', 'UNKNOWN_VERSION', 'INVALID_ACTION', 'INVALID_PAYLOAD', 'PAYLOAD_TOO_LARGE', 'NOT_IMPLEMENTED', 'ACTION_FAILED']),
    message: z.string().min(1).max(500),
    details: z.array(z.string().min(1).max(200)).max(20).optional(),
});

// --- StorySpec: structured story intent (input of the pipeline; see implementation/DSK-002.md samples) ---
const StoryCharacterSchema = z.strictObject({
    roleId: RoleIdSchema,
    name: z.string().min(1).max(40),
    ageRange: z.string().min(1).max(20).optional(),
    gender: z.string().min(1).max(20).optional(),
    look: z.string().min(1).max(400),
    wardrobe: z.string().min(1).max(400),
});
const StoryEnvironmentSchema = z.strictObject({
    location: z.string().min(1).max(200),
    summary: z.string().min(1).max(400),
    timeOfDay: z.enum(['day', 'dusk', 'night', 'dawn']).optional(),
});
export const StorySpecSchema = z.strictObject({
    version,
    specId: IdSchema,
    title: z.string().min(1).max(120),
    premise: z.string().min(1).max(4000),
    style: z.string().min(1).max(400).optional(),
    mode: z.enum(['single-shot', 'multi-shot']),
    aspect: z.enum(['9:16', '16:9']),
    fps: z.literal(24),
    characters: z.array(StoryCharacterSchema).min(1).max(2),
    environment: StoryEnvironmentSchema,
    targetDurationSec: frameAligned(number(5, 75)),
    requestedShots: integer(1, 5).optional(),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const roleIds = new Set<string>();
    value.characters.forEach((character, index) => {
        if (roleIds.has(character.roleId)) fail(['characters', index], `角色 roleId 重复：${character.roleId}`);
        roleIds.add(character.roleId);
    });
    if (value.mode === 'single-shot') {
        if (value.targetDurationSec > 15) fail(['targetDurationSec'], '单镜头模式目标总时长必须为 5-15 秒');
        if (value.requestedShots !== undefined && value.requestedShots !== 1) fail(['requestedShots'], '单镜头模式 requestedShots 必须为 1');
    } else {
        if (value.targetDurationSec < 15) fail(['targetDurationSec'], '多镜头模式目标总时长必须为 15-75 秒');
        if (value.requestedShots !== undefined && value.requestedShots < 3) fail(['requestedShots'], '多镜头模式必须为同场景 3-5 镜头');
        // R3: a requested shot count makes the duration window exact: 5n <= total <= 15n keeps
        // every shot inside 5-15s solvable; omitted requestedShots keeps the 15-75s semantics only.
        if (value.requestedShots !== undefined) {
            const minTotal = 5 * value.requestedShots;
            const maxTotal = 15 * value.requestedShots;
            if (value.targetDurationSec < minTotal) fail(['targetDurationSec'], `指定 ${value.requestedShots} 个镜头时目标总时长不得低于 ${minTotal} 秒`);
            if (value.targetDurationSec > maxTotal) fail(['targetDurationSec'], `指定 ${value.requestedShots} 个镜头时目标总时长不得超过 ${maxTotal} 秒`);
        }
    }
});

// --- ShotPlan: deterministic shot plan for one scene ---
export const SUITES = ['two-person-dialogue', 'character-enter-exit', 'tracking-follow', 'push-orbit', 'simple-standoff'] as const;
const ShotSchema = z.strictObject({
    shotId: IdSchema,
    suite: z.enum(SUITES),
    durationSec: frameAligned(number(5, 15)),
    roleIds: z.array(RoleIdSchema).min(1).max(2),
    roles: z.array(z.strictObject({ roleId: RoleIdSchema, entityId: EntityIdSchema })).min(1).max(2),
    camera: z.strictObject({ type: z.literal('single-continuous'), intent: z.string().min(1).max(200) }),
    fixedElements: z.array(z.string().min(1).max(120)).max(10),
    changes: z.array(z.string().min(1).max(120)).max(10).optional(),
    summary: z.string().min(1).max(400),
});
export const ShotPlanSchema = z.strictObject({
    version,
    planId: IdSchema,
    specId: IdSchema,
    specHash: sha256Hex,
    totalDurationSec: number(5, 75),
    shots: z.array(ShotSchema).min(1).max(5),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const shotIds = new Set<string>();
    value.shots.forEach((shot, index) => {
        if (shotIds.has(shot.shotId)) fail(['shots', index], `镜头 shotId 重复：${shot.shotId}`);
        shotIds.add(shot.shotId);
        // R2: duplicate roleIds entries make the declared-role set ambiguous; reject them explicitly
        // instead of letting set dedup silently accept them.
        if (new Set<string>(shot.roleIds).size !== shot.roleIds.length) fail(['shots', index, 'roleIds'], 'roleIds 存在重复角色');
        const declared = new Set<string>(shot.roleIds);
        const mapped = new Set<string>();
        shot.roles.forEach((role, roleIndex) => {
            if (!declared.has(role.roleId)) fail(['shots', index, 'roles', roleIndex], `角色 ${role.roleId} 未在 roleIds 中声明`);
            if (mapped.has(role.roleId)) fail(['shots', index, 'roles', roleIndex], `角色 ${role.roleId} 重复映射`);
            mapped.add(role.roleId);
        });
        if (mapped.size !== declared.size) fail(['shots', index, 'roles'], 'roles 映射必须覆盖 roleIds 中的全部角色');
        const entityIds = new Set<string>();
        shot.roles.forEach((role, roleIndex) => {
            if (entityIds.has(role.entityId)) fail(['shots', index, 'roles', roleIndex], `entityId 重复：${role.entityId}`);
            entityIds.add(role.entityId);
        });
    });
    if (value.shots.length > 1 && value.shots.length < 3) fail(['shots'], '多镜头计划必须为同场景 3-5 镜头');
    const sum = value.shots.reduce((total, shot) => total + shot.durationSec, 0);
    if (Math.abs(value.totalDurationSec - sum) > 1e-6) fail(['totalDurationSec'], `totalDurationSec 必须等于各镜头时长之和（${sum}）`);
    if (value.shots.length > 1 && value.totalDurationSec < 15) fail(['totalDurationSec'], '多镜头计划总时长必须为 15-75 秒');
});

// --- ModelShotProposal: the ONLY payload shape a model may emit (suite/semantic parameters) ---
// Deliberately has no operations, entity mappings, provider or credential fields: a strict schema
// rejects such keys, so a model cannot smuggle executable edits or configuration through a proposal.
const ModelShotSchema = z.strictObject({
    shotId: IdSchema,
    suite: z.enum(SUITES),
    durationSec: frameAligned(number(5, 15)),
    roleIds: z.array(RoleIdSchema).min(1).max(2),
    cameraIntent: z.string().min(1).max(200),
    action: z.string().min(1).max(300),
    fixedElements: z.array(z.string().min(1).max(120)).max(10).optional(),
    summary: z.string().min(1).max(400).optional(),
});
export const ModelShotProposalSchema = z.strictObject({
    version,
    specId: IdSchema,
    mode: z.enum(['single-shot', 'multi-shot']),
    shots: z.array(ModelShotSchema).min(1).max(5),
    notes: z.string().min(1).max(400).optional(),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const shotIds = new Set<string>();
    value.shots.forEach((shot, index) => {
        if (shotIds.has(shot.shotId)) fail(['shots', index], `镜头 shotId 重复：${shot.shotId}`);
        shotIds.add(shot.shotId);
        if (new Set<string>(shot.roleIds).size !== shot.roleIds.length) fail(['shots', index, 'roleIds'], 'roleIds 存在重复角色');
    });
    if (value.mode === 'single-shot' && value.shots.length !== 1) fail(['shots'], '单镜头提案只能包含 1 个镜头');
    if (value.mode === 'multi-shot' && (value.shots.length < 3 || value.shots.length > 5)) fail(['shots'], '多镜头提案必须为同场景 3-5 镜头');
    const sum = value.shots.reduce((total, shot) => total + shot.durationSec, 0);
    if (value.mode === 'multi-shot' && (sum < 15 || sum > 75)) fail(['shots'], `多镜头提案总时长必须为 15-75 秒（当前 ${sum}）`);
});

// --- CompiledShotProposal: compiler output only; reuses the engine EditOperation shape ---
// Operation kinds mirror src/automation/contract.ts director_apply operations (kept in sync by
// tests/dsk-contracts.test.ts compile-time assertion `DskCompiledOperation extends EditOperation`).
// This task defines the DTO only; no compilation or execution happens in DSK-003.
export const DskOperationKindSchema = z.enum(['add', 'update', 'remove', 'project', 'cuts', 'notes', 'motion', 'camera-motion', 'lighting-preset', 'replace-prop', 'resource', 'resource-remove', 'clear-inherited-pose']);
export const DskOperationSchema = z.strictObject({
    operation: DskOperationKindSchema,
    id: IdSchema.optional(),
    asset: z.string().min(1).max(200).optional(),
    kind: z.enum(['actor', 'prop']).optional(),
    name: z.string().min(1).max(80).optional(),
    time: number(0, 36000).optional(),
    duration: number(0.000001, 36000).optional(),
    position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    value: z.unknown().optional(),
});
export const CompiledShotProposalSchema = z.strictObject({
    version,
    proposalId: IdSchema,
    planId: IdSchema,
    planHash: sha256Hex,
    compiledBy: z.literal('deterministic-compiler'),
    operations: z.array(DskOperationSchema).min(1).max(100),
    notes: z.string().min(1).max(400).optional(),
});

// --- Workflow state and events ---
export const WORKFLOW_STAGES = ['drafting', 'planning', 'awaiting-plan-approval', 'executing', 'awaiting-shot-approval', 'awaiting-export-approval', 'paused', 'completed', 'cancelled', 'failed'] as const;
export const WorkflowStateSchema = z.strictObject({
    version,
    workflowId: IdSchema,
    projectId: IdSchema,
    stage: z.enum(WORKFLOW_STAGES),
    stepId: IdSchema.optional(),
    revision: integer(1, 1000000),
    lastEventSeq: integer(0, 1000000000),
    activeApprovalIds: z.array(IdSchema).max(5).optional(),
    updatedAt: isoTimestamp,
});
export const WORKFLOW_EVENT_TYPES = ['stage-entered', 'approval-requested', 'approval-granted', 'approval-denied', 'approval-expired', 'proposal-ready', 'proposal-rejected', 'model-request-registered', 'model-response-recorded', 'budget-exceeded', 'validation-failed', 'paused', 'resumed', 'cancelled', 'completed', 'failed'] as const;
export const WorkflowEventSchema = z.strictObject({
    version,
    workflowId: IdSchema,
    seq: integer(1, 1000000000),
    type: z.enum(WORKFLOW_EVENT_TYPES),
    stepId: IdSchema.optional(),
    requestId: IdSchema.optional(),
    at: isoTimestamp,
    summary: z.string().min(1).max(300).optional(),
    payloadHash: sha256Hex.optional(),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    // R5: model bookkeeping events must name their request and step so budget/audit trails stay
    // attributable; genuinely workflow-level events (stage transitions, approvals, ...) may omit both.
    if (value.type === 'model-request-registered' || value.type === 'model-response-recorded') {
        if (value.requestId === undefined) fail(['requestId'], '模型请求登记/响应事件必须携带 requestId');
        if (value.stepId === undefined) fail(['stepId'], '模型请求登记/响应事件必须携带 stepId');
    }
});

// --- Approval bound to scope hash and finite budget ---
export const BudgetSchema = z.strictObject({
    // R4: maxModelRequests is the whole-workflow model-call budget cap; the approved plan bounds
    // the full pipeline at 17 requests (5 shots x (1 draft + 2 repairs) + 2 plan calls).
    // Per-stage and per-shot accounting stays a DSK-007 concern and is not encoded here.
    maxModelRequests: integer(0, 17),
    maxTotalTokens: integer(0, 10000000),
    maxWallClockSeconds: integer(1, 86400),
    maxShots: integer(1, 5),
});
export const ApprovalSchema = z.strictObject({
    version,
    approvalId: IdSchema,
    workflowId: IdSchema,
    kind: z.enum(['plan', 'export']),
    status: z.enum(['pending', 'granted', 'denied', 'expired', 'revoked']),
    scopeHash: sha256Hex,
    planHash: sha256Hex.optional(),
    budget: BudgetSchema,
    requestedAt: isoTimestamp,
    decidedAt: isoTimestamp.optional(),
    expiresAt: isoTimestamp.optional(),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (value.kind === 'plan' && value.planHash === undefined) fail(['planHash'], '计划审批必须绑定 planHash');
    if (value.kind === 'export' && value.planHash !== undefined) fail(['planHash'], '导出审批不携带 planHash，范围由 scopeHash 表达');
});

// --- SnapshotRef: opaque, path-free handle issued by the main process (A3) ---
export const SnapshotRefSchema = z.strictObject({
    version,
    snapshotId: IdSchema,
    projectId: IdSchema,
    revision: integer(1, 1000000),
    digest: sha256Hex,
    createdAt: isoTimestamp,
});

// --- Provider request/response/usage ---
export const ProviderUsageSchema = z.strictObject({
    known: z.boolean(),
    promptTokens: integer(0, 10000000).optional(),
    completionTokens: integer(0, 10000000).optional(),
    totalTokens: integer(0, 10000000).optional(),
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (!value.known) {
        if (value.promptTokens !== undefined || value.completionTokens !== undefined || value.totalTokens !== undefined)
            fail(['known'], 'usage 未知时不得伪造计数（含 0）；未知消费不能当作零消费');
        return;
    }
    if (value.promptTokens === undefined || value.completionTokens === undefined || value.totalTokens === undefined) {
        fail(['known'], 'usage 已知时必须提供完整计数');
        return;
    }
    if (value.totalTokens < value.promptTokens + value.completionTokens) fail(['totalTokens'], 'totalTokens 不得小于 prompt 与 completion 之和');
});
export const ProviderRequestSchema = z.strictObject({
    version,
    requestId: IdSchema,
    workflowId: IdSchema,
    stepId: IdSchema.optional(),
    provider: z.enum(['mock', 'openai-compatible']),
    model: z.string().min(1).max(200),
    purpose: z.enum(['plan', 'shot-draft', 'shot-repair']),
    timeoutMs: integer(1000, 120000),
    maxOutputTokens: integer(1, 1000000),
    inputFingerprint: sha256Hex,
    promptSummary: z.string().min(1).max(2000),
});
export const ProviderResponseSchema = z.strictObject({
    version,
    requestId: IdSchema,
    status: z.enum(['ok', 'error', 'unknown']),
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp.optional(),
    httpStatus: integer(100, 599).optional(),
    content: z.string().min(1).max(100000).optional(),
    errorDetail: z.string().min(1).max(300).optional(),
    usage: ProviderUsageSchema,
}).superRefine((value, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (value.status === 'ok' && value.content === undefined) fail(['content'], '成功响应必须包含内容');
    if (value.status === 'ok' && value.errorDetail !== undefined) fail(['errorDetail'], '成功响应不得携带错误详情');
    if (value.status === 'error' && value.errorDetail === undefined) fail(['errorDetail'], '失败响应必须说明原因');
    if (value.status === 'unknown') {
        if (value.content !== undefined) fail(['content'], '断流等不确定结果不得携带内容');
        if (value.usage.known) fail(['usage'], '不确定结果的 usage 必须标记为 unknown');
    }
});

// Schema registry consumed by both test harnesses (source import and bundled CJS).
export const DSK_SCHEMAS = {
    StorySpec: StorySpecSchema,
    ShotPlan: ShotPlanSchema,
    ModelShotProposal: ModelShotProposalSchema,
    CompiledShotProposal: CompiledShotProposalSchema,
    WorkflowState: WorkflowStateSchema,
    WorkflowEvent: WorkflowEventSchema,
    Approval: ApprovalSchema,
    SnapshotRef: SnapshotRefSchema,
    ProviderRequest: ProviderRequestSchema,
    ProviderResponse: ProviderResponseSchema,
} as const;
export type DskSchemaName = keyof typeof DSK_SCHEMAS;
