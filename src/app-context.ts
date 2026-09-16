import type { SceneTemplate } from './scenes.ts';
import type { Engine } from './engine.ts';
import type { Action, Entity, Project, Vec3 } from './model.ts';
import type { EditorHistory } from './storage.ts';
import type { SceneWorkspace } from './scenes/scene-workspace.ts';
import type { SceneDocument } from './scenes/sequence-project.ts';
import type { SceneContext } from './scenes/sequence-session.ts';
import type { ManagedProjectController } from './editor/managed-project.ts';
/** UI modules receive an explicit application boundary; they never own the scene or persistence. */
export interface AppContext {
    addAsset(id: string, position?: Vec3): void;
    addGroundPoint(position: Vec3): void;
    retimePath(e: Entity, start: number, end: number): void;
    applyField(key: string, value: string): void;
    applyMotion(name: string): void;
    applyFraming(name: string): void;
    act(action: string, el: HTMLElement): Promise<void>;
    project: Project;
    selected: string;
    inspectorTab: string;
    sidebarTab: string;
    assetFilter: string;
    query: string;
    time: number;
    playing: boolean;
    loop: boolean;
    mode: string;
    preview: string;
    dirty: boolean;
    readonly revision: number;
    busy: boolean;
    draft: {
        id: string;
    } | null;
    aborter: AbortController | null;
    readonly engine: Engine;
    readonly history: EditorHistory;
    readonly scenes: SceneWorkspace;
    /** DSK-004 managed project library controller (absent in plain browser sessions). */
    readonly managed: ManagedProjectController;
    /** Drain pending recovery writes before switching documents (cancel + settle in-flight). */
    drainRecovery(): Promise<void>;
    /** R4: confirm unsaved edits, drain autosave and leave the managed session before the whole
     * document identity changes (新建/导入). False means the switch must be cancelled and the
     * original managed project (document, dirty state, lease) is preserved. */
    leaveManagedForSwitch(reason: string): Promise<boolean>;
    /** R4/R11: modal confirmation for discarding unsaved edits; false on any dismissal. */
    confirmDiscardEdits(reason: string): Promise<boolean>;
    applyDocument(document: SceneDocument, context: SceneContext, label: string, resetViews?: boolean, resetHistory?: boolean): void;
    switchScene(id: string, context: SceneContext): void;
    current(): Entity | undefined;
    toast(message: string, error?: boolean): void;
    change(fn: () => void, rebuild?: boolean): boolean;
    changed(rebuild?: boolean): void;
    extendDuration(): void;
    selectEntity(id: string, preserveTimelineSelection?: boolean): void;
    renderPanels(): void;
    renderSidebar(): void;
    renderInspector(): void;
    renderTimeline(): void;
    renderCameras(): void;
    updateTimeUI(): void;
    seek(t: number, deferSample?: boolean): void;
    saveProject(): Promise<boolean>;
    showModal(title: string, body: string, footer?: string): void;
    closeModal(): void;
    projectDialog(): void;
    roomDialog(): void;
    createNew(template?: SceneTemplate): void;
    sceneDialog(): void;
    makeCamera(fromView?: boolean): void;
    startPath(): void;
    finishPath(): void;
    cancelPath(): void;
    replaceAction(e: Entity, a: Action, start: number, end: number): void;
    deleteDialog(e: Entity): void;
    deleteEntity(id: string, replacement?: string): void;
    seatDialog(): void;
    seatApply(): void;
    snapshot(): Promise<void>;
    exportDialog(): void;
    startExport(): Promise<void>;
    helpDialog(): void;
    updateExportSummary(): void;
    setView(mode: string): void;
}
