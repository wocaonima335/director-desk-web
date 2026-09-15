// DSK-003: renderer-to-main pipeline IPC surface (channel "director-dsk").
// The action list is a closed whitelist; every payload is schema-validated; every schema is strict.
// There is deliberately no action that accepts code, tools, or arbitrary paths: storage handles
// (SnapshotRef) are opaque and issued by the main process, and credentials never appear here.
// Pure module: no DOM, Electron, Node or filesystem imports.
import { z } from 'zod';
import { DSK_CONTRACT_VERSION, type DskContractVersion } from './version.ts';
import { DskErrorSchema, IdSchema, StorySpecSchema } from './schema.ts';

export type { DskContractVersion };
export const DSK_ACTIONS = ['project.list', 'project.status', 'project.open', 'project.create', 'plan.submit-spec', 'plan.get', 'approval.request', 'approval.decide', 'state.get', 'state.events', 'model.status'] as const;
export type DskAction = (typeof DSK_ACTIONS)[number];

const version = z.literal(DSK_CONTRACT_VERSION);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);

// Per-action payload schemas. `data` is required except for actions that take no parameters.
const PAYLOAD_SCHEMAS = {
    'project.list': z.strictObject({}),
    'project.status': z.strictObject({ projectId: IdSchema }),
    'project.open': z.strictObject({ projectId: IdSchema }),
    'project.create': z.strictObject({ name: z.string().min(1).max(80) }),
    'plan.submit-spec': z.strictObject({ spec: StorySpecSchema }),
    'plan.get': z.strictObject({ planId: IdSchema }),
    'approval.request': z.strictObject({ workflowId: IdSchema, kind: z.enum(['plan', 'export']) }),
    'approval.decide': z.strictObject({ approvalId: IdSchema, decision: z.enum(['grant', 'deny']) }),
    'state.get': z.strictObject({ workflowId: IdSchema }),
    'state.events': z.strictObject({ workflowId: IdSchema, afterSeq: integer(0, 1000000000), limit: integer(1, 200) }),
    'model.status': z.strictObject({}),
} satisfies Record<DskAction, z.ZodType>;
export const DSK_ACTION_PAYLOAD_SCHEMAS: Record<DskAction, z.ZodType> = PAYLOAD_SCHEMAS;
export type DskActionPayloads = { [A in DskAction]: z.infer<(typeof PAYLOAD_SCHEMAS)[A]> };

const DskEnvelopeSchema = z.strictObject({
    version,
    action: z.enum(DSK_ACTIONS),
    data: z.unknown().optional(),
});

// IPC input limits (A2: oversized/over-deep inputs are rejected deterministically).
export const DSK_MAX_PAYLOAD_CHARS = 262144;
export const DSK_MAX_PAYLOAD_DEPTH = 32;
export const DSK_MAX_PAYLOAD_NODES = 20000;

export type DskError = z.infer<typeof DskErrorSchema>;
export type DskResult<T = unknown> = { ok: true; data: T } | { ok: false; error: DskError };

const failure = (code: DskError['code'], message: string, details?: string[]): DskResult<never> =>
    ({ ok: false, error: details ? { code, message, details } : { code, message } });

const formatIssues = (error: z.ZodError): string[] => error.issues.slice(0, 10).map(issue => {
    const at = issue.path.length ? issue.path.join('.') : '(root)';
    return `${at}: ${issue.message}`;
});

// Iterative payload scan: rejects non-finite numbers, prototype-smuggling keys and over-deep or
// oversized structures before any schema runs. Bounded queue, so cyclic input cannot loop it.
export function scanDskPayload(value: unknown): string | null {
    const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
    let nodes = 0;
    while (queue.length) {
        const item = queue.pop()!;
        nodes += 1;
        if (nodes > DSK_MAX_PAYLOAD_NODES) return '负载节点数超过上限';
        if (item.d > DSK_MAX_PAYLOAD_DEPTH) return '负载嵌套深度超过 32 层';
        const v = item.v;
        if (typeof v === 'number' && !Number.isFinite(v)) return '负载包含 NaN 或 Infinity';
        if (Array.isArray(v)) {
            for (const entry of v) queue.push({ v: entry, d: item.d + 1 });
        } else if (v !== null && typeof v === 'object') {
            for (const key of Object.keys(v as Record<string, unknown>)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') return '负载包含被禁止的原型键';
                queue.push({ v: (v as Record<string, unknown>)[key], d: item.d + 1 });
            }
        }
    }
    return null;
}

// Same sender/frame policy as the existing director-host channel: the event must come from the
// app's own webContents main frame on the director://app/ origin (A3).
export function isTrustedDskFrame(event: { sender?: unknown; senderFrame?: { url?: unknown } | null }, window: { webContents?: unknown; isDestroyed?: () => boolean }): boolean {
    if (!event || !window) return false;
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) return false;
    if (event.sender !== window.webContents) return false;
    const url = event.senderFrame?.url;
    return typeof url === 'string' && url === 'director://app/';
}

export type DskActionHandler = (data: unknown) => DskResult<unknown> | Promise<DskResult<unknown>>;
export type DskActionHandlers = { [A in DskAction]?: DskActionHandler };

// Pure request pipeline shared by the real Electron main process and both test harnesses.
// DSK-003 ships no storage/workflow handlers yet, so every legal action returns NOT_IMPLEMENTED;
// illegal requests are rejected with a specific error code instead (A3: no fake success).
export async function dispatchDskRequest(input: unknown, handlers: DskActionHandlers): Promise<DskResult<unknown>> {
    const scan = scanDskPayload(input);
    if (scan) return failure('INVALID_PAYLOAD', scan);
    let serialized: string;
    try {
        serialized = JSON.stringify(input) ?? '';
    } catch {
        return failure('INVALID_PAYLOAD', '负载无法序列化');
    }
    if (serialized.length > DSK_MAX_PAYLOAD_CHARS) return failure('PAYLOAD_TOO_LARGE', `负载超过 ${DSK_MAX_PAYLOAD_CHARS} 字符上限`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_PAYLOAD', '负载必须是对象');
    if ((input as { version?: unknown }).version !== DSK_CONTRACT_VERSION) return failure('UNKNOWN_VERSION', `契约版本必须是 ${DSK_CONTRACT_VERSION}`);
    const envelope = DskEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
        if (envelope.error.issues.some(issue => issue.path[0] === 'action')) return failure('INVALID_ACTION', '未知或缺失的 dsk 动作', formatIssues(envelope.error));
        return failure('INVALID_PAYLOAD', '信封结构不合法', formatIssues(envelope.error));
    }
    const { action } = envelope.data;
    const payload = DSK_ACTION_PAYLOAD_SCHEMAS[action].safeParse(envelope.data.data === undefined ? {} : envelope.data.data);
    if (!payload.success) return failure('INVALID_PAYLOAD', '动作参数未通过校验', formatIssues(payload.error));
    const handler = handlers[action];
    if (!handler) return failure('NOT_IMPLEMENTED', `动作 ${action} 已通过校验，但处理器尚未接入（DSK-004/007/016 交付）`);
    try {
        return await handler(payload.data);
    } catch (error) {
        return failure('ACTION_FAILED', error instanceof Error ? error.message : '动作处理器异常');
    }
}
