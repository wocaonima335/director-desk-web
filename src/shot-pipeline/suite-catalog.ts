/** Approved catalogue for the five parameterized shot suites (DSK-006 plan, frozen).
 *  Pure local metadata: no AI, no downloads, no shared DTO changes. UI form (DSK-006-B)
 *  renders from this catalogue; the factory in create-shot-suite.ts enforces the same ranges. */

export const SHOT_SUITE_VERSION = 1;

/** 24fps only; durations are 5-15s aligned to the 1/24s frame grid. */
export const SHOT_SUITE_FPS = 24;
export const SHOT_SUITE_DURATION = { min: 5, max: 15, default: 10 } as const;
export const SHOT_SUITE_ASPECTS = ['16:9', '9:16'] as const;
export type ShotSuiteAspect = typeof SHOT_SUITE_ASPECTS[number];

export const SHOT_SUITE_IDS = [
    'two-person-dialogue',
    'character-enter-exit',
    'tracking-follow',
    'push-orbit',
    'simple-standoff',
] as const;
export type ShotSuiteId = typeof SHOT_SUITE_IDS[number];

export interface SuiteRange { min: number; max: number; default: number }
export interface SuiteCatalogEntry {
    id: ShotSuiteId;
    label: string;
    detail: string;
    /** Approved person count per plan; roles is an explicit roleId list with exactly this size. */
    roles: { min: number; max: number };
    /** Suites with a designated featured role (dialogue speaker / standoff lead) require that roleId. */
    featuredRole: boolean;
    numberParams: Partial<Record<'distance' | 'travel' | 'angle', SuiteRange>>;
    /** Enum parameters and their approved defaults; side means the screen side the movement relates to. */
    enumParams: Partial<Record<'direction' | 'side' | 'mode' | 'gesture', { values: readonly string[]; default?: string }>>;
}

export const SUITE_CATALOG: readonly SuiteCatalogEntry[] = [
    {
        id: 'two-person-dialogue', label: '双人对话', detail: '两人相向、错开的指向与待机姿态，固定双人机位，无语音与唇形',
        roles: { min: 2, max: 2 }, featuredRole: true,
        numberParams: { distance: { min: 1.2, max: 2.4, default: 1.6 } },
        enumParams: {},
    },
    {
        id: 'character-enter-exit', label: '入场 / 离场', detail: '固定机位，同一人物沿路径真正跨越画面边缘；入场约0.65T落位，离场约0.35T开始',
        roles: { min: 1, max: 1 }, featuredRole: false,
        numberParams: {},
        enumParams: { direction: { values: ['enter', 'exit'], default: 'enter' }, side: { values: ['left', 'right'], default: 'left' } },
    },
    {
        id: 'tracking-follow', label: '跟拍', detail: '人物行走，相机同时间基准平行移动并瞄准人物',
        roles: { min: 1, max: 1 }, featuredRole: false,
        numberParams: { travel: { min: 2, max: 6, default: 4 } },
        enumParams: { side: { values: ['left', 'right'], default: 'left' } },
    },
    {
        id: 'push-orbit', label: '推进 / 环绕', detail: '复用既有推近/环绕运镜；双人瞄准组中心；非当前分支参数拒绝',
        roles: { min: 1, max: 2 }, featuredRole: false,
        numberParams: { distance: { min: .5, max: 1.5, default: 1 }, angle: { min: 15, max: 45, default: 30 } },
        enumParams: { mode: { values: ['push', 'orbit'], default: 'push' }, side: { values: ['left', 'right'], default: 'left' } },
    },
    {
        id: 'simple-standoff', label: '简单对峙', detail: '两人相向、错开回应姿态，固定幅度缓推，无武器与搏斗',
        roles: { min: 2, max: 2 }, featuredRole: true,
        numberParams: { distance: { min: 1.5, max: 3, default: 2 } },
        enumParams: { gesture: { values: ['point', 'idle'], default: 'point' } },
    },
];

export const suiteCatalogEntry = (id: ShotSuiteId): SuiteCatalogEntry =>
    SUITE_CATALOG.find(entry => entry.id === id)!;

/** Resource statement returned with every generated project. Built-in white models and the
 *  offline procedural/CC0 motion library only; no downloaded assets attach to the project. */
export const SUITE_RESOURCE_NOTE =
    '仅使用内置白模人物、程序化动作与中性白模场地，无需下载或外部资源；动作素材许可见 src/animation/library/NOTICE.txt（Quaternius，CC0）。';
