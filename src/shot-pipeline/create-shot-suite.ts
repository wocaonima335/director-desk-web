/** Deterministic factory for the five approved shot suites (DSK-006-A).
 *
 *  Output is one ordinary editable Project (single scene, single camera, one cut at time 0,
 *  24fps, 5-15s frame-aligned) plus the normalized parameters, an independent roleId→entityId
 *  map, the suite version and a resource statement. Nothing suite-specific is written into the
 *  project: no roleId fields, no recipes, no StorySpec/ShotPlan placeholders. Staging reuses
 *  templateBuilder/entity/clip/applyCameraMotion and the real engine projection
 *  (configureCamera) for framing; characters move on real entity paths, never scene copies.
 *
 *  Final ids and the roleMap are taken from the SuiteIdRegistry after finalize — never
 *  re-concatenated here. Enter/exit endpoints are solved against the real animated white
 *  model (makeActor/scaleHuman/animateActor/fitFeetToSurface projected through the configured
 *  lens), so the whole rig — not a chest point — crosses the frame edge. Walking actors keep
 *  one consistent root yaw across hold/walk/stop segments; the hold fallback rotation equals
 *  the path yaw, so the engine never snaps the root 90° when a walk starts. */

import { Mesh, PerspectiveCamera, Vector3 } from 'three';
import { COLORS, clip, assertProject, type Action, type Entity, type Project, type Vec3 } from '../model.ts';
import { templateBuilder } from '../scenes/template-builder.ts';
import { applyCameraMotion } from '../cinematography/motion-presets.ts';
import { entityPosition, entityYaw } from '../timeline.ts';
import { configureCamera } from '../engine.ts';
import { makeActor, animateActor } from '../assets/actors.ts';
import { scaleHuman } from '../assets/humanoid.ts';
import { fitFeetToSurface } from '../editor/foot-contact.ts';
import { disposeTree, type Rig } from '../assets.ts';
import { SHOT_SUITE_FPS, SHOT_SUITE_VERSION, SUITE_RESOURCE_NOTE, suiteCatalogEntry, type ShotSuiteId } from './suite-catalog.ts';
import { parseShotSuiteInput, type NormalizedShotSuite } from './suite-input.ts';
import { SuiteIdRegistry, assertNoTemporaryIds, registerEntity, suiteEntityKey } from './suite-ids.ts';

const CAMERA_HEIGHT = 1.5;
const TARGET_HEIGHT = 1.25;
/** Procedural walk reference pace: cycle 2π/6 s at clip speed 1, stride ≈ 2·2·0.85·sin(0.48) ≈ 1.57 m
 *  (human-animation.ts rate/amplitude and legacy rig leg length) → ≈1.5 m/s. Route pace is matched
 *  by scaling clip.speed, so cadence always follows the actual route duration. */
const WALK_NOMINAL_SPEED = 1.5;
const WALK_MAX_PACE = 1.8;
/** Frame-edge margin for the "fully off-screen" solve: every rig vertex at least 2% beyond |ndc|=1. */
const OFFSCREEN_MARGIN = .02;
const BACK = new Vector3(0, 0, 1);
const LIFT = new Vector3(0, CAMERA_HEIGHT - TARGET_HEIGHT, 0);

export interface ShotSuiteResult {
    suite: ShotSuiteId;
    suiteVersion: number;
    params: NormalizedShotSuite;
    roleMap: Record<string, string>;
    resourceNote: string;
    project: Project;
}

const frames = (seconds: number): number => Math.round(seconds * SHOT_SUITE_FPS);
const at = (frame: number): number => frame / SHOT_SUITE_FPS;

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    }
    return value;
}

/** Real engine lens: identical film gauge/focal mapping as program and editor cameras. */
function makeLens(focal: number, aspect: string): PerspectiveCamera {
    const [w, h] = aspect.split(':').map(Number);
    const lens = new PerspectiveCamera();
    configureCamera(lens, focal, w / h);
    return lens;
}

function projectNdc(lens: PerspectiveCamera, position: Vector3, aim: Vector3, point: Vector3): { x: number; y: number } {
    lens.position.copy(position);
    lens.up.set(0, 1, 0);
    lens.lookAt(aim);
    lens.updateMatrixWorld(true);
    const out = point.clone().project(lens);
    return { x: out.x, y: out.y };
}

/** Smallest camera distance along `back` from `aim` where every point stays inside the NDC box.
 *  Projection through the real configured lens; monotone bisection keeps this deterministic. */
function solveDistance(lens: PerspectiveCamera, aim: Vector3, points: Vector3[], maxX: number, maxY: number, minDistance: number): number {
    const fits = (distance: number) => {
        const position = aim.clone().addScaledVector(BACK, distance).add(LIFT);
        return points.every(point => {
            const ndc = projectNdc(lens, position, aim, point);
            return Math.abs(ndc.x) <= maxX && Math.abs(ndc.y) <= maxY;
        });
    };
    if (fits(minDistance)) return minDistance;
    let low = minDistance, high = minDistance * 2;
    while (high < 500 && !fits(high)) { low = high; high *= 2; }
    if (high >= 500) throw new Error('套件构图无法在有限机距内覆盖目标');
    for (let i = 0; i < 48; i++) { const mid = (low + high) / 2; if (fits(mid)) high = mid; else low = mid; }
    return high;
}

/** |ndc.x| = limit crossing along the walk line through the aim point (used for frame edges). */
function solveLineNdc(lens: PerspectiveCamera, position: Vector3, aim: Vector3, limit: number): number {
    let low = 0, high = 1;
    const offset = (x: number) => Math.abs(projectNdc(lens, position, aim, new Vector3(x, TARGET_HEIGHT, aim.z)).x);
    while (offset(high) < limit && high < 500) high *= 2;
    if (high >= 500) throw new Error('套件入出画端点超出可计算范围');
    for (let i = 0; i < 48; i++) { const mid = (low + high) / 2; if (offset(mid) < limit) low = mid; else high = mid; }
    return high;
}

interface Build {
    project: Project;
    registry: SuiteIdRegistry;
    tb: ReturnType<typeof templateBuilder>;
}

function emptyProject(name: string, durationSeconds: number, aspect: string): Build {
    const project: Project = {
        format: 'director-desk', version: 2, name,
        duration: durationSeconds, fps: SHOT_SUITE_FPS, aspect,
        room: { enabled: true, width: 6, depth: 6, height: 3.2 },
        entities: [], cuts: [], references: [],
    };
    return { project, registry: new SuiteIdRegistry(), tb: templateBuilder(project) };
}

interface PersonOptions {
    position: Vec3;
    color: string;
    face?: Entity['face'];
    faceTarget?: string;
    rotationY?: number;
    footContact?: boolean;
}

function person(build: Build, roleIndex: number, roleId: string, letter: string, options: PersonOptions): Entity {
    const e = registerEntity(build.registry, build.tb.actor(`人物 ${letter} · ${roleId}`, options.position, options.color), suiteEntityKey.role(roleIndex));
    e.clips = [];
    if (options.face) e.face = options.face;
    if (options.faceTarget) e.faceTarget = options.faceTarget;
    if (options.rotationY !== undefined) e.rotation = [0, options.rotationY, 0];
    if (options.footContact) e.footContact = true;
    return e;
}

interface ClipEntry { purpose: string; action: Action; startFrame: number; endFrame: number; speed?: number }

function setClips(build: Build, e: Entity, roleIndex: number, entries: ClipEntry[]): void {
    let previous = -1;
    entries.forEach((entry, clipIndex) => {
        if (entry.endFrame <= entry.startFrame || entry.startFrame < previous) throw new Error(`套件动作分段非法：${entry.purpose}`);
        previous = entry.endFrame;
        const c = clip(entry.action, at(entry.startFrame), at(entry.endFrame));
        c.speed = entry.speed ?? 1;
        build.registry.register(c.id, suiteEntityKey.clip(roleIndex, clipIndex));
        e.clips.push(c);
    });
}

function poseKeys(e: Entity, keys: { time: number; pose: Record<string, number> }[]): void {
    e.poseKeys = keys;
}

function cameraEntity(build: Build, namespace: string, position: Vec3, target: Vec3, focal: number): Entity {
    const cam = registerEntity(build.registry, build.tb.camera(`套件主机位 · ${namespace}`, position, target, focal), suiteEntityKey.camera());
    cam.camera!.targetHeight = TARGET_HEIGHT;
    return cam;
}

function personCoverage(halfSpan: number): Vector3[] {
    return [-halfSpan, halfSpan].flatMap(x => [new Vector3(x, 0, 0), new Vector3(x, .9, 0), new Vector3(x, 1.8, 0)]);
}

/** Sizes the white-model room from real sampled staging extents so walls never crop the shot. */
function fitRoom(build: Build, durationSeconds: number): void {
    const { project } = build;
    let maxX = 1.5, maxZ = 1.5;
    for (let frame = 0; frame <= frames(durationSeconds); frame++) {
        const time = at(frame);
        for (const e of project.entities) {
            const position = entityPosition(e, time);
            maxX = Math.max(maxX, Math.abs(position.x));
            maxZ = Math.max(maxZ, Math.abs(position.z));
        }
    }
    project.room = {
        enabled: true,
        width: Math.max(6, Math.ceil((maxX + 2) * 2)),
        depth: Math.max(6, Math.ceil((maxZ + 2) * 2)),
        height: 3.2,
    };
}

function walkSpeed(distanceMeters: number, windowFrames: number): number {
    const pace = distanceMeters / (windowFrames / SHOT_SUITE_FPS);
    if (pace > WALK_MAX_PACE) throw new Error('套件时长不足完成行走路程，请增加时长或缩短行程');
    return pace / WALK_NOMINAL_SPEED;
}

/** Real white-model probe: the actual animated rig, sampled through the same chain as the
 *  engine (makeActor → scaleHuman → animateActor → fitFeetToSurface on flat ground) and
 *  projected through the configured lens. Disclosed after each solve; nothing persists. */
interface RigProbe { entity: Entity; rig: Rig; meshes: Mesh[]; vertex: Vector3 }

function openRigProbe(actor: Entity): RigProbe {
    const entity = structuredClone(actor);
    const rig = makeActor(entity);
    try {
        scaleHuman(rig, entity);
        const meshes: Mesh[] = [];
        rig.root.traverse(o => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
        return { entity, rig, meshes, vertex: new Vector3() };
    } catch (error) {
        // Construction failed after makeActor succeeded: release what was built, rethrow as-is.
        disposeTree(rig.root);
        throw error;
    }
}

function closeRigProbe(probe: RigProbe): void { disposeTree(probe.rig.root); }

/** Min/max ndc.x over every vertex of the real animated rig at `time` (engine root semantics). */
function probeNdcRange(probe: RigProbe, project: Project, lens: PerspectiveCamera, time: number): { min: number; max: number } {
    const e = probe.entity;
    probe.rig.root.position.copy(entityPosition(e, time));
    probe.rig.root.rotation.set(e.rotation[0], entityYaw(e, time, project), e.rotation[2]);
    animateActor(probe.rig, e, time);
    fitFeetToSurface(probe.rig, () => 0);
    probe.rig.root.updateMatrixWorld(true);
    let min = Infinity, max = -Infinity;
    for (const mesh of probe.meshes) {
        const attribute = mesh.geometry.attributes.position;
        for (let i = 0; i < attribute.count; i++) {
            probe.vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).project(lens);
            if (probe.vertex.x < min) min = probe.vertex.x;
            if (probe.vertex.x > max) max = probe.vertex.x;
        }
    }
    return { min, max };
}

function buildTwoPersonDialogue(build: Build, params: Extract<NormalizedShotSuite, { suite: 'two-person-dialogue' }>): void {
    const [first, second] = params.roles;
    const total = frames(params.durationSeconds);
    const mid = Math.round(total * .18), gestureEnd = Math.min(mid + Math.max(24, Math.round(total * .2)), total - Math.max(6, Math.round(total * .08)));
    const replyStart = Math.min(gestureEnd + Math.max(6, Math.round(total * .08)), total - 24);
    const replyEnd = Math.min(replyStart + Math.max(24, Math.round(total * .18)), total);
    const offset = params.distance / 2;
    const left = person(build, 0, first, 'A', { position: [-offset, 0, 0], color: COLORS[0] });
    const right = person(build, 1, second, 'B', { position: [offset, 0, 0], color: COLORS[1] });
    left.face = right.face = 'target';
    left.faceTarget = right.id;
    right.faceTarget = left.id;
    const speaker = params.speaker === first ? left : right;
    const listener = speaker === left ? right : left;
    const speakerIndex = speaker === left ? 0 : 1, listenerIndex = 1 - speakerIndex;
    setClips(build, speaker, speakerIndex, [
        { purpose: 'listen', action: 'idle', startFrame: 0, endFrame: mid },
        { purpose: 'point', action: 'point', startFrame: mid, endFrame: gestureEnd },
        { purpose: 'settle', action: 'idle', startFrame: gestureEnd, endFrame: total },
    ]);
    setClips(build, listener, listenerIndex, [
        { purpose: 'listen', action: 'idle', startFrame: 0, endFrame: replyStart },
        { purpose: 'point', action: 'point', startFrame: replyStart, endFrame: replyEnd },
        { purpose: 'settle', action: 'idle', startFrame: replyEnd, endFrame: total },
    ]);
    poseKeys(speaker, [{ time: 0, pose: { headYaw: 5 } }, { time: at(gestureEnd), pose: { headYaw: -3 } }]);
    poseKeys(listener, [{ time: 0, pose: { head: 3 } }, { time: at(replyStart), pose: { headYaw: 4, head: 0 } }]);
    const aim = new Vector3(0, TARGET_HEIGHT, 0);
    const lens = makeLens(28, params.aspect);
    const distance = solveDistance(lens, aim, personCoverage(offset + .45), .86, .88, 1.6);
    cameraEntity(build, params.namespace, [0, CAMERA_HEIGHT, distance], [0, TARGET_HEIGHT, 0], 28);
}

function buildCharacterEnterExit(build: Build, params: Extract<NormalizedShotSuite, { suite: 'character-enter-exit' }>): void {
    const [role] = params.roles;
    const total = frames(params.durationSeconds);
    const sideSign = params.side === 'right' ? 1 : -1;
    const aim = new Vector3(0, TARGET_HEIGHT, 0);
    const lens = makeLens(20, params.aspect);
    const distance = solveDistance(lens, aim, personCoverage(.55), .88, .88, 1.6);
    const position = aim.clone().addScaledVector(BACK, distance).add(LIFT);
    const edge = solveLineNdc(lens, position, aim, 1);
    const walkEnd = params.direction === 'enter' ? Math.round(total * .65) : total;
    const walkStart = params.direction === 'enter' ? 0 : Math.round(total * .35);
    const line = (x: number): Vec3 => [x, 0, 0];
    const landingX = -sideSign * .3 * edge;
    // Hold segments have no path direction, so the fallback root rotation must equal the walking
    // yaw; otherwise the engine snaps the root 90° the moment the walk clip begins.
    const walkYaw = (params.direction === 'enter' ? -sideSign : sideSign) * Math.PI / 2;
    const actor = person(build, 0, role, 'A', { position: [0, 0, 0], color: COLORS[0], face: 'path', rotationY: walkYaw, footContact: true });
    // Solve the route endpoint against the real animated white model: every rig vertex must sit
    // beyond the frame edge at the first playable frame (enter) / last playable frame (exit),
    // accounting for aspect, yaw, walk pose and the actual end-frame position.
    const probe = openRigProbe(actor);
    const evalTime = params.direction === 'enter' ? 0 : at(total - 1);
    const applyCandidate = (offset: number): number => {
        const start = params.direction === 'enter' ? sideSign * offset : -sideSign * .3 * edge;
        const end = params.direction === 'enter' ? landingX : sideSign * offset;
        const pace = Math.abs(end - start) / ((walkEnd - walkStart) / SHOT_SUITE_FPS);
        const speed = pace / WALK_NOMINAL_SPEED;
        probe.entity.position = line(start);
        probe.entity.path = { smooth: false, points: params.direction === 'enter'
            ? [{ time: 0, position: line(start) }, { time: at(walkEnd), position: line(end) }]
            : [{ time: 0, position: line(start) }, { time: at(walkStart), position: line(start) }, { time: at(walkEnd), position: line(end) }] };
        probe.entity.clips = params.direction === 'enter'
            ? [{ id: 'probe-a', action: 'walk', start: 0, end: at(walkEnd), speed }, { id: 'probe-b', action: 'idle', start: at(walkEnd), end: at(total), speed: 1 }]
            : [{ id: 'probe-a', action: 'idle', start: 0, end: at(walkStart), speed: 1 }, { id: 'probe-b', action: 'walk', start: at(walkStart), end: at(walkEnd), speed }];
        return pace;
    };
    let offset: number;
    // Every exit path — explicit no-solution throw included — releases the probe exactly once.
    try {
        const offscreen = (candidate: number): boolean => {
            if (applyCandidate(candidate) <= 0) return false;
            const range = probeNdcRange(probe, build.project, lens, evalTime);
            return (sideSign === 1 ? range.min : -range.max) >= 1 + OFFSCREEN_MARGIN;
        };
        let low = edge, high = edge + .5;
        let solved = false;
        while (high < 14) { if (offscreen(high)) { solved = true; break; } low = high; high *= 1.5; }
        if (!solved) throw new Error('套件入出画端点超出可计算范围');
        // Bisection keeps only candidates already judged off-screen (high); a non-monotone walk
        // phase can wiggle between neighbours, but high is never assigned an unverified value.
        for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (offscreen(mid)) high = mid; else low = mid; }
        offset = high;
    } finally {
        closeRigProbe(probe);
    }
    const start = params.direction === 'enter' ? sideSign * offset : -sideSign * .3 * edge;
    const end = params.direction === 'enter' ? landingX : sideSign * offset;
    const speed = walkSpeed(Math.abs(end - start), walkEnd - walkStart);
    actor.position = line(start);
    actor.path = params.direction === 'enter'
        ? { smooth: false, points: [{ time: 0, position: line(start) }, { time: at(walkEnd), position: line(end) }] }
        : { smooth: false, points: [{ time: 0, position: line(start) }, { time: at(walkStart), position: line(start) }, { time: at(walkEnd), position: line(end) }] };
    setClips(build, actor, 0, params.direction === 'enter'
        ? [{ purpose: 'cross', action: 'walk', startFrame: 0, endFrame: walkEnd, speed }, { purpose: 'settle', action: 'idle', startFrame: walkEnd, endFrame: total }]
        : [{ purpose: 'wait', action: 'idle', startFrame: 0, endFrame: walkStart }, { purpose: 'cross', action: 'walk', startFrame: walkStart, endFrame: walkEnd, speed }]);
    cameraEntity(build, params.namespace, [0, CAMERA_HEIGHT, distance], [0, TARGET_HEIGHT, 0], 20);
}

function buildTrackingFollow(build: Build, params: Extract<NormalizedShotSuite, { suite: 'tracking-follow' }>): void {
    const [role] = params.roles;
    const total = frames(params.durationSeconds);
    const directionSign = params.side === 'right' ? 1 : -1;
    const aim = new Vector3(0, TARGET_HEIGHT, 0);
    const lens = makeLens(28, params.aspect);
    const abeam = solveDistance(lens, aim, personCoverage(.55), .8, .88, 2.2);
    // Cadence follows the route: prefer ~0.9 m/s, speed up (bounded) when the shot is too short.
    const window = Math.min(Math.max(Math.ceil(params.travel * SHOT_SUITE_FPS / WALK_MAX_PACE), Math.round(params.travel / .9 * SHOT_SUITE_FPS)), total - 12);
    const walkSpeedValue = walkSpeed(params.travel, window);
    const startFrame = Math.floor((total - window) / 2), endFrame = startFrame + window;
    const startX = -directionSign * params.travel / 2, endX = startX + directionSign * params.travel;
    // Hold segments have no path direction: keep the fallback root rotation equal to the walking
    // yaw so hold → walk → stop never snaps the root orientation.
    const actor = person(build, 0, role, 'A', { position: [startX, 0, 0], color: COLORS[0], face: 'path', rotationY: directionSign * Math.PI / 2, footContact: true });
    actor.path = { smooth: false, points: [
        { time: 0, position: [startX, 0, 0] }, { time: at(startFrame), position: [startX, 0, 0] },
        { time: at(endFrame), position: [endX, 0, 0] }, { time: at(total), position: [endX, 0, 0] },
    ] };
    setClips(build, actor, 0, [
        { purpose: 'wait', action: 'idle', startFrame: 0, endFrame: startFrame },
        { purpose: 'walk', action: 'walk', startFrame: startFrame, endFrame: endFrame, speed: walkSpeedValue },
        { purpose: 'settle', action: 'idle', startFrame: endFrame, endFrame: total },
    ]);
    const cam = cameraEntity(build, params.namespace, [startX, CAMERA_HEIGHT, abeam], [0, TARGET_HEIGHT, 0], 28);
    cam.camera!.targetId = actor.id;
    cam.camera!.targetHeight = TARGET_HEIGHT;
    cam.path = { smooth: false, points: [
        { time: 0, position: [startX, CAMERA_HEIGHT, abeam] }, { time: at(startFrame), position: [startX, CAMERA_HEIGHT, abeam] },
        { time: at(endFrame), position: [endX, CAMERA_HEIGHT, abeam] }, { time: at(total), position: [endX, CAMERA_HEIGHT, abeam] },
    ] };
}

/** Person separation inside two-person push/orbit staging (fixed staging constant, not an input). */
const PAIR_SPACING = 1.2;

function buildPushOrbit(build: Build, params: Extract<NormalizedShotSuite, { suite: 'push-orbit' }>): void {
    const total = frames(params.durationSeconds);
    const pair = params.roles.length === 2;
    const halfSpan = pair ? PAIR_SPACING / 2 + .45 : .5;
    if (pair) {
        const [first, second] = params.roles;
        const left = person(build, 0, first, 'A', { position: [-PAIR_SPACING / 2, 0, 0], color: COLORS[0] });
        const right = person(build, 1, second, 'B', { position: [PAIR_SPACING / 2, 0, 0], color: COLORS[1] });
        left.face = right.face = 'target';
        left.faceTarget = right.id;
        right.faceTarget = left.id;
        setClips(build, left, 0, [{ purpose: 'idle', action: 'idle', startFrame: 0, endFrame: total }]);
        setClips(build, right, 1, [{ purpose: 'idle', action: 'idle', startFrame: 0, endFrame: total }]);
        poseKeys(left, [{ time: 0, pose: { headYaw: 3 } }]);
        poseKeys(right, [{ time: 0, pose: { headYaw: -3 } }]);
    } else {
        const [role] = params.roles;
        const solo = person(build, 0, role, 'A', { position: [0, 0, 0], color: COLORS[0], rotationY: 0 });
        setClips(build, solo, 0, [{ purpose: 'idle', action: 'idle', startFrame: 0, endFrame: total }]);
    }
    const aim = new Vector3(0, TARGET_HEIGHT, 0);
    const lens = makeLens(24, params.aspect);
    // Tighter margins than push: the arc's smoothed path dips slightly inside the pure circle.
    const endDistance = Math.max(solveDistance(lens, aim, personCoverage(halfSpan), .78, .8, 2), 2);
    const cam = cameraEntity(build, params.namespace, [0, CAMERA_HEIGHT, params.mode === 'push' ? endDistance + params.distance : endDistance], [0, TARGET_HEIGHT, 0], 24);
    if (!pair) cam.camera!.targetId = build.project.entities.find(e => e.kind === 'actor')!.id;
    if (params.mode === 'push') {
        applyCameraMotion(build.project, cam.id, 'push', 0, params.durationSeconds, { amplitude: params.distance, easing: 'smooth' });
    } else {
        // Arc rotation +1 moves the camera toward +X (screen right when looking down -Z).
        applyCameraMotion(build.project, cam.id, 'arc', 0, params.durationSeconds, { angle: params.angle, side: params.side === 'right' ? 1 : -1, easing: 'smooth' });
    }
    build.project.duration = params.durationSeconds;
}

function buildSimpleStandoff(build: Build, params: Extract<NormalizedShotSuite, { suite: 'simple-standoff' }>): void {
    const [first, second] = params.roles;
    const total = frames(params.durationSeconds);
    const offset = params.distance / 2;
    const left = person(build, 0, first, 'A', { position: [-offset, 0, 0], color: COLORS[0] });
    const right = person(build, 1, second, 'B', { position: [offset, 0, 0], color: COLORS[1] });
    left.face = right.face = 'target';
    left.faceTarget = right.id;
    right.faceTarget = left.id;
    const lead = params.lead === first ? left : right;
    const responder = lead === left ? right : left;
    const leadIndex = lead === left ? 0 : 1, responderIndex = 1 - leadIndex;
    const start = Math.max(12, Math.round(total * .15)), end = Math.min(start + Math.max(24, Math.round(total * .22)), total - Math.max(6, Math.round(total * .08)));
    const replyStart = Math.min(end + Math.max(6, Math.round(total * .08)), total - 24);
    const replyEnd = Math.min(replyStart + Math.max(24, Math.round(total * .18)), total);
    if (params.gesture === 'point') {
        setClips(build, lead, leadIndex, [
            { purpose: 'faceoff', action: 'idle', startFrame: 0, endFrame: start },
            { purpose: 'point', action: 'point', startFrame: start, endFrame: end },
            { purpose: 'settle', action: 'idle', startFrame: end, endFrame: total },
        ]);
        setClips(build, responder, responderIndex, [
            { purpose: 'faceoff', action: 'idle', startFrame: 0, endFrame: replyStart },
            { purpose: 'point', action: 'point', startFrame: replyStart, endFrame: replyEnd },
            { purpose: 'settle', action: 'idle', startFrame: replyEnd, endFrame: total },
        ]);
    } else {
        setClips(build, lead, leadIndex, [{ purpose: 'faceoff', action: 'idle', startFrame: 0, endFrame: total }]);
        setClips(build, responder, responderIndex, [{ purpose: 'faceoff', action: 'idle', startFrame: 0, endFrame: total }]);
    }
    poseKeys(lead, [{ time: 0, pose: { headYaw: 4 } }, { time: at(end), pose: { headYaw: -2 } }]);
    poseKeys(responder, [{ time: 0, pose: { head: 3 } }, { time: at(replyStart), pose: { headYaw: -4, head: 0 } }]);
    const aim = new Vector3(0, TARGET_HEIGHT, 0);
    const lens = makeLens(28, params.aspect);
    const endDistance = Math.max(solveDistance(lens, aim, personCoverage(offset + .45), .85, .88, 1.8), 1.8);
    const cam = cameraEntity(build, params.namespace, [0, CAMERA_HEIGHT, endDistance + .5], [0, TARGET_HEIGHT, 0], 28);
    applyCameraMotion(build.project, cam.id, 'push', 0, params.durationSeconds, { amplitude: .5, easing: 'smooth' });
    build.project.duration = params.durationSeconds;
}

function buildProject(params: NormalizedShotSuite): Build {
    const entry = suiteCatalogEntry(params.suite);
    const build = emptyProject(`${entry.label} · ${params.namespace}`, params.durationSeconds, params.aspect);
    if (params.suite === 'two-person-dialogue') buildTwoPersonDialogue(build, params);
    else if (params.suite === 'character-enter-exit') buildCharacterEnterExit(build, params);
    else if (params.suite === 'tracking-follow') buildTrackingFollow(build, params);
    else if (params.suite === 'push-orbit') buildPushOrbit(build, params);
    else buildSimpleStandoff(build, params);
    fitRoom(build, params.durationSeconds);
    return build;
}

/** Builds one suite instance. Same normalized input + namespace → deep-equal result;
 *  different namespaces never share ids. Throws on any invalid input (see suite-input.ts). */
export function createShotSuite(input: unknown): ShotSuiteResult {
    const params = deepFreeze(parseShotSuiteInput(input));
    const { project, registry } = buildProject(params);
    const finalIds = registry.finalize(project, params.namespace);
    assertNoTemporaryIds(project);
    assertProject(project);
    // roleMap entries come straight from the registry table, never re-assembled strings.
    const roleMap: Record<string, string> = {};
    for (const [roleIndex, roleId] of params.roles.entries()) {
        const finalId = finalIds.get(suiteEntityKey.role(roleIndex));
        const entity = project.entities.find(candidate => candidate.id === finalId);
        if (finalId === undefined || !entity || entity.kind !== 'actor') throw new Error(`套件角色实体缺失：${roleId}`);
        roleMap[roleId] = finalId;
    }
    const result: ShotSuiteResult = {
        suite: params.suite,
        suiteVersion: SHOT_SUITE_VERSION,
        params,
        roleMap: deepFreeze(roleMap),
        resourceNote: SUITE_RESOURCE_NOTE,
        project,
    };
    return Object.freeze(result);
}
