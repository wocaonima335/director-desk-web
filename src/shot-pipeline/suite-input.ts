/** Strict input validation for shot suites. Unknown fields, wrong types, non-finite numbers,
 *  duplicate/invalid roles, wrong person counts, out-of-range values, frame-misaligned
 *  durations and branch-irrelevant parameters are rejected without silent coercion.
 *  roleId semantics intentionally mirror shared/contracts RoleIdSchema (verified by test);
 *  no contract or shared DTO is modified. */

import {
    SHOT_SUITE_ASPECTS, SHOT_SUITE_DURATION, SHOT_SUITE_FPS, SHOT_SUITE_IDS, suiteCatalogEntry,
    type ShotSuiteAspect, type ShotSuiteId,
} from './suite-catalog.ts';

/** Same shape as the frozen dsk.v1 RoleIdSchema: 2-64 lowercase ascii letters/digits/hyphens. */
export const SUITE_ROLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/;
export const SUITE_NAMESPACE_PATTERN = /^[a-z0-9]{8,16}$/;

export interface ShotSuiteInputBase {
    suite: ShotSuiteId;
    /** Required explicit instance namespace: 8-16 lowercase letters/digits. */
    namespace: string;
    durationSeconds?: number;
    aspect?: ShotSuiteAspect;
    roles: string[];
}

export type ShotSuiteInput =
    (ShotSuiteInputBase & { suite: 'two-person-dialogue'; speaker: string; distance?: number })
    | (ShotSuiteInputBase & { suite: 'character-enter-exit'; direction?: 'enter' | 'exit'; side?: 'left' | 'right' })
    | (ShotSuiteInputBase & { suite: 'tracking-follow'; travel?: number; side?: 'left' | 'right' })
    | (ShotSuiteInputBase & { suite: 'push-orbit'; mode?: 'push' | 'orbit'; distance?: number; angle?: number; side?: 'left' | 'right' })
    | (ShotSuiteInputBase & { suite: 'simple-standoff'; lead: string; gesture?: 'point' | 'idle'; distance?: number });

export interface NormalizedSuiteBase {
    suite: ShotSuiteId;
    namespace: string;
    durationSeconds: number;
    aspect: ShotSuiteAspect;
    /** Roles normalized to stable ASCII order; identical role sets normalize identically. */
    roles: string[];
}
export interface NormalizedDialogueSuite extends NormalizedSuiteBase { suite: 'two-person-dialogue'; speaker: string; distance: number }
export interface NormalizedEnterExitSuite extends NormalizedSuiteBase { suite: 'character-enter-exit'; direction: 'enter' | 'exit'; side: 'left' | 'right' }
export interface NormalizedFollowSuite extends NormalizedSuiteBase { suite: 'tracking-follow'; travel: number; side: 'left' | 'right' }
export interface NormalizedPushSuite extends NormalizedSuiteBase { suite: 'push-orbit'; mode: 'push'; distance: number; angle: null; side: null }
export interface NormalizedOrbitSuite extends NormalizedSuiteBase { suite: 'push-orbit'; mode: 'orbit'; distance: null; angle: number; side: 'left' | 'right' }
type NormalizedPushOrbitSuite = NormalizedPushSuite | NormalizedOrbitSuite;
export interface NormalizedStandoffSuite extends NormalizedSuiteBase { suite: 'simple-standoff'; lead: string; gesture: 'point' | 'idle'; distance: number }
export type NormalizedShotSuite =
    NormalizedDialogueSuite | NormalizedEnterExitSuite | NormalizedFollowSuite | NormalizedPushOrbitSuite | NormalizedStandoffSuite;

function fail(message: string): never { throw new Error(`套件参数无效：${message}`); }
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}必须是有限数值`);
    return value;
};

const rangeNumber = (value: unknown, label: string, min: number, max: number): number => {
    const n = finiteNumber(value, label);
    if (n < min || n > max) fail(`${label}必须在 ${min} 至 ${max} 之间`);
    return n;
};

const enumValue = <T extends string>(value: unknown, label: string, values: readonly T[]): T => {
    if (typeof value !== 'string' || !values.includes(value as T)) fail(`${label}仅支持 ${values.join(' / ')}`);
    return value as T;
};

const roleId = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !SUITE_ROLE_PATTERN.test(value))
        fail(`${label}必须为 2-64 位小写字母、数字或连字符`);
    return value;
};

/** Rejects unknown keys and branch-irrelevant fields by explicit allow-list. */
const checkKeys = (raw: Record<string, unknown>, allowed: readonly string[]) => {
    for (const key of Object.keys(raw))
        if (!allowed.includes(key)) fail(`未知字段或当前分支不支持的参数：${key}`);
};

const parseRoles = (raw: Record<string, unknown>, min: number, max: number): string[] => {
    if (!Array.isArray(raw.roles)) fail('roles 必须是 roleId 数组');
    if (raw.roles.length < min || raw.roles.length > max) fail(`人数需要 ${min}${min === max ? '' : `-${max}`} 个角色`);
    const roles = raw.roles.map((entry, index) => roleId(entry, `roles[${index}]`));
    if (new Set(roles).size !== roles.length) fail('角色 roleId 重复');
    return [...roles].sort();
};

const frameAligned = (seconds: number): number => {
    if (Math.abs(seconds * SHOT_SUITE_FPS - Math.round(seconds * SHOT_SUITE_FPS)) > 1e-6)
        fail('时长必须对齐 24fps 帧网格（1/24 秒的整数倍）');
    return seconds;
};

const base = <S extends ShotSuiteId>(raw: Record<string, unknown>, suite: S, roles: string[], namespace: string): NormalizedSuiteBase & { suite: S } => ({
    suite, namespace,
    durationSeconds: frameAligned(raw.durationSeconds === undefined
        ? SHOT_SUITE_DURATION.default
        : rangeNumber(raw.durationSeconds, 'durationSeconds', SHOT_SUITE_DURATION.min, SHOT_SUITE_DURATION.max)),
    aspect: raw.aspect === undefined ? '16:9' : enumValue(raw.aspect, 'aspect', SHOT_SUITE_ASPECTS),
    roles,
});

const featuredRole = (raw: Record<string, unknown>, field: 'speaker' | 'lead', roles: string[]): string => {
    if (typeof raw[field] !== 'string') fail(`${field} 必须为角色 roleId`);
    const id = roleId(raw[field], field);
    if (!roles.includes(id)) fail(`${field} 必须是 roles 中已有的角色`);
    return id;
};

export function parseShotSuiteInput(rawInput: unknown): NormalizedShotSuite {
    if (!isRecord(rawInput)) fail('输入必须是对象');
    const raw = rawInput as Record<string, unknown>;
    const suite = enumValue(raw.suite, 'suite', SHOT_SUITE_IDS);
    const namespace = raw.namespace;
    if (typeof namespace !== 'string' || !SUITE_NAMESPACE_PATTERN.test(namespace))
        fail('namespace 必须为 8-16 位小写字母或数字');
    const entry = suiteCatalogEntry(suite);
    const roles = parseRoles(raw, entry.roles.min, entry.roles.max);
    const baseKeys = ['suite', 'namespace', 'durationSeconds', 'aspect', 'roles'];

    if (suite === 'two-person-dialogue') {
        checkKeys(raw, [...baseKeys, 'speaker', 'distance']);
        const distance = raw.distance === undefined ? suiteCatalogEntry(suite).numberParams.distance!.default
            : rangeNumber(raw.distance, 'distance', 1.2, 2.4);
        return { ...base(raw, suite, roles, namespace), speaker: featuredRole(raw, 'speaker', roles), distance };
    }
    if (suite === 'character-enter-exit') {
        checkKeys(raw, [...baseKeys, 'direction', 'side']);
        const direction = raw.direction === undefined ? 'enter' : enumValue(raw.direction, 'direction', ['enter', 'exit']);
        const side = raw.side === undefined ? 'left' : enumValue(raw.side, 'side', ['left', 'right']);
        return { ...base(raw, suite, roles, namespace), direction, side };
    }
    if (suite === 'tracking-follow') {
        checkKeys(raw, [...baseKeys, 'travel', 'side']);
        const travel = raw.travel === undefined ? suiteCatalogEntry(suite).numberParams.travel!.default
            : rangeNumber(raw.travel, 'travel', 2, 6);
        const side = raw.side === undefined ? 'left' : enumValue(raw.side, 'side', ['left', 'right']);
        return { ...base(raw, suite, roles, namespace), travel, side };
    }
    if (suite === 'push-orbit') {
        const mode = raw.mode === undefined ? 'push' : enumValue(raw.mode, 'mode', ['push', 'orbit']);
        // Branch-irrelevant fields are rejected: push takes only distance, orbit only angle+side.
        checkKeys(raw, [...baseKeys, 'mode', ...(mode === 'push' ? ['distance'] : ['angle', 'side'])]);
        if (mode === 'push')
            return { ...base(raw, suite, roles, namespace), mode, distance: raw.distance === undefined ? 1 : rangeNumber(raw.distance, 'distance', .5, 1.5), angle: null, side: null };
        return {
            ...base(raw, suite, roles, namespace), mode, distance: null,
            angle: raw.angle === undefined ? 30 : rangeNumber(raw.angle, 'angle', 15, 45),
            side: raw.side === undefined ? 'left' : enumValue(raw.side, 'side', ['left', 'right']),
        };
    }
    checkKeys(raw, [...baseKeys, 'lead', 'gesture', 'distance']);
    const gesture = raw.gesture === undefined ? 'point' : enumValue(raw.gesture, 'gesture', ['point', 'idle']);
    const distance = raw.distance === undefined ? suiteCatalogEntry(suite).numberParams.distance!.default
        : rangeNumber(raw.distance, 'distance', 1.5, 3);
    return { ...base(raw, suite, roles, namespace), lead: featuredRole(raw, 'lead', roles), gesture, distance };
}
