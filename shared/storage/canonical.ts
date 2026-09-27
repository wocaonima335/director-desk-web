// DSK-004: deterministic JSON serialization for managed project objects.
// Object keys are sorted by UTF-16 code-unit order (plain `<` on JS strings), array order is
// preserved, only finite numbers are allowed, and the output is compact UTF-8-encodable text.
// The same bytes must hash identically in every engine (renderer, main process, tests), so this
// module is pure: no DOM, Electron, Node, crypto or locale-dependent operations (never localeCompare).
//
// RP5: the serializer is single-pass and streaming. It walks the ORIGINAL document (never a
// sorted copy of the tree) and accumulates the exact UTF-8 byte count token by token — object
// keys, punctuation, string escapes and surrogate pairs included — rejecting the moment the
// canonical form would exceed STORAGE_MAX_PROJECT_BYTES, the nesting would exceed
// STORAGE_MAX_DEPTH (root counts as depth 1) or the document would exceed STORAGE_MAX_NODES
// values (property keys are not nodes). An over-budget document therefore never produces the
// complete oversized text; serialization stops at the first offending token.
import { STORAGE_MAX_DEPTH, STORAGE_MAX_NODES, STORAGE_MAX_PROJECT_BYTES } from '../contracts/storage.ts';
import type { SceneDocument } from '../../src/scenes/sequence-project.ts';

export type CanonicalLimit = 'bytes' | 'depth' | 'nodes';

/** Budget violation during canonical serialization; `limit` says which frozen budget tripped. */
export class CanonicalLimitError extends Error {
    readonly limit: CanonicalLimit;
    constructor(limit: CanonicalLimit, message: string) {
        super(message);
        this.name = 'CanonicalLimitError';
        this.limit = limit;
    }
}

const bytesReason = `规范化工程超过 ${STORAGE_MAX_PROJECT_BYTES} 字节上限`;
const depthReason = `规范化工程嵌套深度超过 ${STORAGE_MAX_DEPTH} 层`;
const nodesReason = `规范化工程节点数超过 ${STORAGE_MAX_NODES} 上限`;
const nonFiniteReason = '规范化工程包含非有限数';
const unsupportedReason = '规范化工程包含无法序列化为 JSON 的值';

// Exact same escape set as JSON.stringify: the two mandatory characters, the five short control
// escapes and lowercase \u00xx for every other control code unit (plus lone surrogates below).
const SHORT_ESCAPES: Record<number, string> = {
    0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\',
};
const unicodeEscape = (unit: number) => '\\u' + unit.toString(16).padStart(4, '0');

// Pending string pieces are flushed into a block once they reach this many bytes; blocks keep the
// piece array short and cap the transient copy size. The final text joins blocks exactly once.
const BLOCK_FLUSH_BYTES = 262144;
// Plain (escape-free) string runs are emitted in slices of this many code units so a single huge
// string never materializes as one extra full copy mid-walk.
const RUN_SLICE_UNITS = 32768;

class CanonicalWriter {
    private blocks: string[] = [];
    private pieces: string[] = [];
    private pieceBytes = 0;
    nodes = 0;
    bytes = 0;

    /** Emit an ASCII-only token (punctuation, number, keyword); its byte size is its length. */
    raw(token: string): void {
        const size = token.length;
        const total = this.bytes + size;
        if (total > STORAGE_MAX_PROJECT_BYTES) throw new CanonicalLimitError('bytes', bytesReason);
        this.bytes = total;
        this.push(token, size);
    }

    /** Emit an already-budget-checked plain slice whose UTF-8 size is known. */
    run(source: string, start: number, end: number, byteLength: number): void {
        this.bytes += byteLength;
        this.push(source.slice(start, end), byteLength);
    }

    private push(piece: string, pieceBytes: number): void {
        this.pieces.push(piece);
        this.pieceBytes += pieceBytes;
        if (this.pieceBytes >= BLOCK_FLUSH_BYTES) {
            this.blocks.push(this.pieces.join(''));
            this.pieces = [];
            this.pieceBytes = 0;
        }
    }

    /** One JSON string token: opening/closing quotes, escapes and surrogate handling included. */
    string(value: string): void {
        this.raw('"');
        const length = value.length;
        let runStart = 0;
        let runBytes = 0;
        let i = 0;
        while (i < length) {
            const unit = value.charCodeAt(i);
            if (unit < 0x20 || unit === 0x22 || unit === 0x5c) {
                if (i > runStart) { this.run(value, runStart, i, runBytes); runBytes = 0; }
                this.raw(SHORT_ESCAPES[unit] ?? unicodeEscape(unit));
                i += 1;
                runStart = i;
            } else if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = i + 1 < length ? value.charCodeAt(i + 1) : 0;
                if (next >= 0xdc00 && next <= 0xdfff) {
                    runBytes += 4; // a valid surrogate pair encodes as one 4-byte UTF-8 sequence
                    i += 2;
                } else {
                    if (i > runStart) { this.run(value, runStart, i, runBytes); runBytes = 0; }
                    this.raw(unicodeEscape(unit)); // lone high surrogate escapes as 6 ASCII bytes
                    i += 1;
                    runStart = i;
                }
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
                if (i > runStart) { this.run(value, runStart, i, runBytes); runBytes = 0; }
                this.raw(unicodeEscape(unit)); // lone low surrogate escapes as 6 ASCII bytes
                i += 1;
                runStart = i;
            } else {
                runBytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
                i += 1;
            }
            if (this.bytes + runBytes > STORAGE_MAX_PROJECT_BYTES) throw new CanonicalLimitError('bytes', bytesReason);
            if (i - runStart >= RUN_SLICE_UNITS) {
                this.run(value, runStart, i, runBytes);
                runStart = i;
                runBytes = 0;
            }
        }
        if (i > runStart) this.run(value, runStart, i, runBytes);
        this.raw('"');
    }

    text(): string {
        if (this.blocks.length === 0) return this.pieces.join('');
        return this.blocks.join('') + this.pieces.join('');
    }
}

// The serializer recurses freely: the depth guard fires BEFORE descending past STORAGE_MAX_DEPTH,
// so the stack can never grow beyond the frozen budget regardless of the input's real nesting.
function writeValue(writer: CanonicalWriter, value: unknown, depth: number): void {
    writer.nodes += 1;
    if (writer.nodes > STORAGE_MAX_NODES) throw new CanonicalLimitError('nodes', nodesReason);
    if (depth > STORAGE_MAX_DEPTH) throw new CanonicalLimitError('depth', depthReason);
    if (value === null) { writer.raw('null'); return; }
    const kind = typeof value;
    if (kind === 'number') {
        if (!Number.isFinite(value)) throw Error(nonFiniteReason);
        writer.raw(String(value)); // ToString of a finite number is exactly JSON's number text
        return;
    }
    if (kind === 'boolean') { writer.raw(value ? 'true' : 'false'); return; }
    if (kind === 'string') { writer.string(value as string); return; }
    if (kind === 'bigint') throw Error(unsupportedReason);
    if (kind === 'object') {
        const holder = value as { toJSON?: unknown };
        if (typeof holder.toJSON === 'function') {
            writeValue(writer, (holder.toJSON as () => unknown).call(value), depth);
            return;
        }
        if (Array.isArray(value)) {
            writer.raw('[');
            let first = true;
            const entries = value as unknown[];
            for (let i = 0; i < entries.length; i += 1) {
                const entry = entries[i];
                if (!first) writer.raw(',');
                first = false;
                const entryKind = typeof entry;
                if (entryKind === 'bigint') throw Error(unsupportedReason);
                // JSON.stringify renders undefined/function/symbol holes as null inside arrays.
                // The rendered value always walks the normal writeValue path, so depth+1 and the
                // node budget apply to null elements exactly like any other array entry.
                const item = entry === null || entryKind === 'undefined' || entryKind === 'function' || entryKind === 'symbol' ? null : entry;
                writeValue(writer, item, depth + 1);
            }
            writer.raw(']');
            return;
        }
        writer.raw('{');
        const source = value as Record<string, unknown>;
        // Byte-compatible with the previous JSON.stringify(sorted-object) output: JSON array-index
        // keys (canonical non-negative integers below 2^32-1) come first in ascending NUMERIC
        // order, every other key follows in UTF-16 code-unit order. Only the key list is
        // reordered — values are still read lazily in emission order, never as a sorted tree copy.
        const indices: number[] = [];
        const names: string[] = [];
        for (const key of Object.keys(source)) {
            const numeric = Number(key);
            // The canonical-form check (String(numeric) === key) rejects "01", "+1", "1.0",
            // "1e2", "-0" and other non-canonical spellings, exactly like JSON.stringify.
            if (Number.isInteger(numeric) && numeric >= 0 && numeric < 4294967295 && String(numeric) === key) indices.push(numeric);
            else names.push(key);
        }
        indices.sort((a, b) => a - b);
        names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const keys = new Array<string>(indices.length + names.length);
        for (let i = 0; i < indices.length; i += 1) keys[i] = String(indices[i]);
        for (let i = 0; i < names.length; i += 1) keys[indices.length + i] = names[i];
        let first = true;
        for (const key of keys) {
            // Values are read in sorted-key order only: serialization stops at the first budget
            // violation, so later properties (and their getters) are never touched.
            const item = source[key];
            const itemKind = typeof item;
            // JSON.stringify omits undefined/function/symbol properties entirely.
            if (itemKind === 'undefined' || itemKind === 'function' || itemKind === 'symbol') continue;
            if (itemKind === 'bigint') throw Error(unsupportedReason);
            if (!first) writer.raw(',');
            first = false;
            writer.string(key);
            writer.raw(':');
            writeValue(writer, item, depth + 1);
        }
        writer.raw('}');
        return;
    }
    // Root-level undefined/function/symbol are handled by canonicalJson; never reached otherwise.
    throw Error(unsupportedReason);
}

/** Canonical text for an already-validated document; rejects non-finite numbers deterministically
 * and refuses documents whose canonical form exceeds the frozen storage budgets (bytes/depth/
 * nodes) by throwing CanonicalLimitError. Accepts any JSON-compatible value so tests and generic
 * payloads share the exact same ordering. As before, a JSON-invisible root (undefined/function/
 * symbol) yields no text at all. */
export function canonicalJson(document: SceneDocument | unknown): string {
    const kind = typeof document;
    if (document === null || (kind !== 'undefined' && kind !== 'function' && kind !== 'symbol')) {
        const writer = new CanonicalWriter();
        writeValue(writer, document, 1);
        return writer.text();
    }
    return undefined as unknown as string;
}
