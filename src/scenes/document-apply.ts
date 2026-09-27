import type { Project } from '../model.ts';
import type { SceneDocument } from './sequence-project.ts';
import type { SceneContext } from './sequence-session.ts';

/** RP6: whole-document apply with mandatory rollback.
 *
 * The editor replaces its entire document (打开/新建/导入). This module owns the transaction:
 * a read-only capture happens before anything mutates, a refused guard never captures at all,
 * and every failure after the capture — model/view preparation, the document swap itself or the
 * first presentation — is rolled back to the captured state. Only when the rollback ALSO fails
 * does the caller enter an explicit write-blocked failure state; the outcome never pretends a
 * broken apply succeeded. UI side effects (engine, DOM, toasts, managed writes) stay in the
 * ports provided by the caller, so the protocol is testable without a browser. */

export interface DocumentApplyOptions {
    context: SceneContext;
    label: string;
    resetViews: boolean;
    resetHistory: boolean;
}

/** RP6-R02: one gate object shared by every mutating write entry (change(), engine transform
 * drag, undo/redo, live fields, path drawing, timeline drag, model recording and the whole
 * document apply itself). While a whole-document rollback has failed, every entry funnels
 * through this gate and refuses, so no path can mutate the document, history or revision. */
export class WriteGate {
    #reason: string | null = null;
    /** True while every mutating entry must refuse writes. */
    get blocked() { return this.#reason !== null; }
    /** User-facing denial for entries that report with a toast; null when writes are allowed. */
    denial(): string | null { return this.#reason === null ? null : `编辑器处于整档回滚失败禁写状态，请重启应用：${this.#reason}`; }
    /** Throw-shaped gate for write paths that report failures by throwing. */
    refuse() { const denial = this.denial(); if (denial !== null) throw Error(denial); }
    /** Enter the blocked state; only a failed whole-document rollback may call this. */
    block(reason: unknown) { this.#reason = reason instanceof Error ? reason.message : String(reason); }
    /** Recovery/testing hook: lift the block again. */
    clear() { this.#reason = null; }
}

/** RP6-R03: where a failed apply failed. 'prepare' means the candidate never replaced the
 * document (prepare or the swap itself refused) — nothing visible changed, so the rollback must
 * preserve the live view, timeline/path selections and playback untouched. 'swap' means the new
 * document HAD been swapped in (the swap completed but presentation failed) — the full captured
 * view must be restored, including the captured playback flag, timeline clip selection and
 * path-point selection exactly as captured (never an unconditional stop/clear/reset). */
export type RollbackStage = 'prepare' | 'swap';

export interface WholeDocumentPorts {
    /** Busy/draft/pending gate. Throwing refuses the apply before anything is captured. */
    guard(): void;
    /** Read-only readiness check of the candidate (structure, per-scene model readiness).
     * Must not mutate visible editor state; its validation-cache leftovers are rolled back. */
    prepare(document: SceneDocument): void;
    /** Capture everything a failed apply must restore: document history, views, model resources,
     * managed epoch and the live editor view. Read-only; returns an opaque snapshot. */
    capture(): unknown;
    /** Swap the whole document (history replace, or a fresh session via resetHistory). */
    commit(document: SceneDocument, options: DocumentApplyOptions): Project;
    /** First presentation of the new document (engine rebuild, panels, view). */
    present(project: Project): void;
    /** Success-only side effects, e.g. the managed epoch bump; runs only after present() held and
     * receives the capture so pinned model resources can be released. */
    applied(snapshot: unknown): void;
    /** Restore the captured state exactly and re-present the original document. stage='prepare'
     * means the candidate never replaced the document: the live view, timeline clip selection,
     * path-point selection and playback state were never touched and must be preserved as-is,
     * with no re-presentation and no save. stage='swap' means the document had already been
     * replaced, so the full captured view must be restored — playback flag, clip selection and
     * path-point selection exactly as captured, not reset to defaults. Throwing means the
     * restoration itself failed — the editor must then be write-blocked, never "restored". */
    rollback(snapshot: unknown, stage: RollbackStage): Project;
    /** Enter the explicit write-blocked state; must not fake a successful recovery. */
    writeBlocked(applyError: unknown, rollbackError: unknown): void;
}

export type WholeDocumentOutcome =
    | { status: 'refused'; error: unknown }
    | { status: 'applied'; project: Project }
    | { status: 'rolled-back'; project: Project; error: unknown }
    | { status: 'write-blocked'; error: unknown; rollbackError: unknown };

/** Apply a whole document transactionally. Synchronous by contract: prepare in the editor is the
 * synchronous readiness assert; async model preloading stays with the callers before they call. */
export function applyWholeDocument(ports: WholeDocumentPorts, document: SceneDocument, context: SceneContext, label: string,
    options: { resetViews?: boolean; resetHistory?: boolean } = {}): WholeDocumentOutcome {
    try { ports.guard(); } catch (error) { return { status: 'refused', error }; }
    const snapshot = ports.capture();
    let project: Project | null = null;
    let swapped = false;
    try {
        ports.prepare(document);
        project = ports.commit(document, { context, label, resetViews: options.resetViews ?? false, resetHistory: options.resetHistory ?? false });
        swapped = true;
        ports.present(project);
    } catch (error) {
        try {
            const restored = ports.rollback(snapshot, swapped ? 'swap' : 'prepare');
            return { status: 'rolled-back', project: restored, error };
        } catch (rollbackError) {
            ports.writeBlocked(error, rollbackError);
            return { status: 'write-blocked', error, rollbackError };
        }
    }
    ports.applied(snapshot);
    return { status: 'applied', project: project! };
}
