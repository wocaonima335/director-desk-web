/** Controlled deterministic re-identification for one suite build.
 *
 *  Existing constructors (entity()/clip()) allocate temporary crypto.randomUUID() ids so all
 *  standard editing paths keep working during construction. Before returning, every generated
 *  entity/clip id and every actual reference field (cuts, faceTarget, camera.targetId, camera
 *  effect focus, hidden lists) is rewritten through this registry — callers never re-assemble
 *  final ids by string concatenation.
 *
 *  Final ids are `s-<namespace>-<key>`, mirroring the frozen EntityIdSchema contract shape:
 *  letter-led, only `[A-Za-z0-9_-]`, at most 64 chars. Keys are bounded (`r0`, `r1`, `r0-c1`,
 *  `cam`) and namespaces are 8-16 lowercase alphanumerics, so suite ids stay ≤ 35 chars.
 *  Namespaces cannot collide structurally: the character right after the namespace is always
 *  `-`, which is not allowed inside a namespace, so `s-ns1-…` never equals `s-ns2-…` for
 *  ns1 ≠ ns2 regardless of their lengths. Only typed reference fields are rewritten through
 *  the registry — no global crypto override, no blind recursive string replacement, and
 *  unknown references fail loudly. */

import type { Entity, Project } from '../model.ts';

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/;
const NAMESPACE_PATTERN = /^[a-z0-9]{8,16}$/;
/** Same shape as the frozen dsk.v1 EntityIdSchema: 1-64 chars, letter-led identifier charset. */
export const SUITE_FINAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TEMP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const indexKey = (prefix: string, index: number): string => {
    if (!Number.isInteger(index) || index < 0 || index > 9) throw new Error(`套件序号越界：${index}`);
    return `${prefix}${index}`;
};

export class SuiteIdRegistry {
    readonly #keys = new Map<string, string>();
    #finalByKey = new Map<string, string>();

    /** Registers a constructor-allocated temporary id under a controlled semantic key. */
    register(tempId: string, key: string): string {
        if (!KEY_PATTERN.test(key)) throw new Error(`套件语义键不合法：${key}`);
        if (!tempId) throw new Error('套件登记缺少临时标识');
        if (this.#keys.has(tempId)) throw new Error('同一临时标识被重复登记');
        for (const existing of this.#keys.values())
            if (existing === key) throw new Error(`套件语义键重复：${key}`);
        this.#keys.set(tempId, key);
        return tempId;
    }

    get size(): number { return this.#keys.size; }

    /** Deterministic final id for one semantic key; letter-led, schema-shaped, namespace-unique. */
    static finalId(namespace: string, key: string): string {
        if (!NAMESPACE_PATTERN.test(namespace)) throw new Error('套件namespace必须为 8-16 位小写字母或数字');
        if (!KEY_PATTERN.test(key)) throw new Error(`套件语义键不合法：${key}`);
        const id = `s-${namespace}-${key}`;
        if (!SUITE_FINAL_ID_PATTERN.test(id)) throw new Error(`套件最终标识越界：${id}`);
        return id;
    }

    /** Rewrites generated ids and actual reference fields; returns the key→finalId table so
     *  callers (roleMap included) take every final id from the registry, never re-concatenated. */
    finalize(project: Project, namespace: string): ReadonlyMap<string, string> {
        const keyToFinal = new Map<string, string>();
        const finalIds = new Map<string, string>();
        for (const [tempId, key] of this.#keys) {
            const final = SuiteIdRegistry.finalId(namespace, key);
            keyToFinal.set(key, final);
            finalIds.set(tempId, final);
        }
        const rewrite = (id: string, label: string): string => {
            if (id === '') return id;
            const final = finalIds.get(id);
            if (final === undefined) throw new Error(`套件引用的标识未登记：${label}`);
            return final;
        };
        for (const e of project.entities) {
            e.id = rewrite(e.id, `entity:${e.name}`);
            e.faceTarget = rewrite(e.faceTarget, `faceTarget:${e.name}`);
            for (const c of e.clips) c.id = rewrite(c.id, `clip:${e.name}`);
            const camera = e.camera;
            if (camera) {
                camera.targetId = rewrite(camera.targetId, `camera.targetId:${e.name}`);
                if (camera.effects?.focusTargetId !== undefined)
                    camera.effects.focusTargetId = rewrite(camera.effects.focusTargetId, `focusTargetId:${e.name}`);
                if (camera.hiddenEntityIds !== undefined)
                    camera.hiddenEntityIds = camera.hiddenEntityIds.map(id => rewrite(id, `hiddenEntityIds:${e.name}`));
            }
        }
        for (const cut of project.cuts) cut.cameraId = rewrite(cut.cameraId, 'cuts.cameraId');
        this.#finalByKey = keyToFinal;
        return keyToFinal;
    }

    /** Final id for an already-registered semantic key after finalize. */
    idOf(key: string): string {
        const final = this.#finalByKey.get(key);
        if (final === undefined) throw new Error(`套件标识未登记：${key}`);
        return final;
    }
}

/** Deep assertion that no temporary random id survives in the returned project. */
export function assertNoTemporaryIds(value: unknown): void {
    if (typeof value === 'string') {
        if (TEMP_UUID_PATTERN.test(value)) throw new Error('套件输出残留临时随机标识');
        return;
    }
    if (Array.isArray(value)) { value.forEach(entry => assertNoTemporaryIds(entry)); return; }
    if (value && typeof value === 'object') { for (const entry of Object.values(value)) assertNoTemporaryIds(entry); }
}

/** Controlled semantic keys: bounded, deterministic and independent of roleId text length. */
export const suiteEntityKey = {
    role: (roleIndex: number): string => indexKey('r', roleIndex),
    clip: (roleIndex: number, clipIndex: number): string => `${indexKey('r', roleIndex)}-c${indexKey('c', clipIndex)}`,
    camera: (): string => 'cam',
};

/** Registers an entity created through the standard builder and returns it unchanged. */
export function registerEntity<T extends Entity>(registry: SuiteIdRegistry, tempEntity: T, key: string): T {
    registry.register(tempEntity.id, key);
    return tempEntity;
}
