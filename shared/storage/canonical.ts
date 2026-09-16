// DSK-004: deterministic JSON serialization for managed project objects.
// Object keys are sorted by UTF-16 code-unit order (plain `<` on JS strings), array order is
// preserved, only finite numbers are allowed, and the output is compact UTF-8-encodable text.
// The same bytes must hash identically in every engine (renderer, main process, tests), so this
// module is pure: no DOM, Electron, Node, crypto or locale-dependent operations (never localeCompare).
import type { SceneDocument } from '../../src/scenes/sequence-project.ts';

function sortValue(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) throw Error('规范化工程包含非有限数');
        return value;
    }
    if (Array.isArray(value)) {
        const out = new Array<unknown>(value.length);
        for (let i = 0; i < value.length; i += 1) out[i] = sortValue(value[i]);
        return out;
    }
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = sortValue(source[key]);
    return out;
}

/** Canonical text for an already-validated document; rejects non-finite numbers deterministically.
 * Accepts any JSON-compatible value so tests and generic payloads share the exact same ordering. */
export function canonicalJson(document: SceneDocument | unknown): string {
    return JSON.stringify(sortValue(document));
}
