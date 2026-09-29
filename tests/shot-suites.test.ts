import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { createShotSuite } from '../src/shot-pipeline/create-shot-suite.ts';
import { SHOT_SUITE_FPS, SHOT_SUITE_IDS, SHOT_SUITE_VERSION, SUITE_CATALOG, SUITE_RESOURCE_NOTE, suiteCatalogEntry, type ShotSuiteId } from '../src/shot-pipeline/suite-catalog.ts';
import { SUITE_NAMESPACE_PATTERN, SUITE_ROLE_PATTERN, parseShotSuiteInput } from '../src/shot-pipeline/suite-input.ts';
import { SuiteIdRegistry, suiteEntityKey } from '../src/shot-pipeline/suite-ids.ts';
import { ACTIONS, assertProject, aspectNumber, type Entity, type Project } from '../src/model.ts';
import { entityPosition, entityYaw, sampledAction, samplePose } from '../src/timeline.ts';
import { projectForScene, readSceneDocument } from '../src/scenes/sequence-project.ts';
import { configureCamera } from '../src/engine.ts';
import { makeActor, animateActor } from '../src/assets/actors.ts';
import { scaleHuman } from '../src/assets/humanoid.ts';
import { fitFeetToSurface } from '../src/editor/foot-contact.ts';
import { disposeTree } from '../src/assets.ts';
import { EntityIdSchema, RoleIdSchema } from '../shared/contracts/schema.ts';

const NS = 'suite01a9';
/** Maximal 16-char namespace boundary (single literal so the length is pinned in one place). */
const MAX_NAMESPACE = 'a0123456789abcde';
const ASPECTS = ['16:9', '9:16'] as const;
const DURATIONS = [5, 10, 15] as const;
const ROLE_SETS: Record<ShotSuiteId, string[]> = {
    'two-person-dialogue': ['lin-xia', 'wang-hai'],
    'character-enter-exit': ['chen-lu'],
    'tracking-follow': ['zhao-yun'],
    'push-orbit': ['li-lei'],
    'simple-standoff': ['han-mei', 'zhou-qi'],
};
const FEATURED: Partial<Record<ShotSuiteId, Record<string, string>>> = {
    'two-person-dialogue': { speaker: 'lin-xia' },
    'simple-standoff': { lead: 'han-mei' },
};
const validInput = (suite: ShotSuiteId, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ suite, namespace: NS, roles: [...ROLE_SETS[suite]], ...FEATURED[suite], ...overrides });

const deepFreezeInput = <T>(value: T): T => {
    if (value && typeof value === 'object') { Object.freeze(value); for (const entry of Object.values(value as Record<string, unknown>)) deepFreezeInput(entry); }
    return value;
};

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const totalFrames = (project: Project) => Math.round(project.duration * SHOT_SUITE_FPS);

/** Sampling entry guard: t is SECONDS inside the playable window [0, duration). A raw frame
 *  number (e.g. 119 handed to a 5s shot) fails here immediately instead of silently sampling
 *  after the shot ended — wrong units can never reach the rig or the lens. */
function assertSampleTime(project: Project, t: number, label: string): void {
    assert.ok(Number.isFinite(t) && t >= 0 && t < project.duration - 1e-9,
        `${label}: sampling time ${t}s outside the playable window [0, ${project.duration}s) — was a frame number passed instead of seconds?`);
}

/** Mirrors engine target semantics (targetId → entity + targetHeight, else fixed target). */
function cameraSampler(project: Project) {
    const cam = project.entities.find(e => e.kind === 'camera')!;
    const config = cam.camera!;
    const lens = new T.PerspectiveCamera();
    configureCamera(lens, config.focal, aspectNumber(project.aspect));
    const aimOf = (t: number) => {
        if (config.targetId) {
            const target = project.entities.find(e => e.id === config.targetId)!;
            return entityPosition(target, t).add(new T.Vector3(0, config.targetHeight, 0));
        }
        return new T.Vector3(...config.target);
    };
    return {
        entity: cam,
        aimOf,
        lens,
        /** Places the lens exactly where the engine would place it at time t. */
        focus(t: number) {
            assertSampleTime(project, t, 'camera');
            lens.position.copy(entityPosition(cam, t));
            lens.up.set(0, 1, 0);
            lens.lookAt(aimOf(t));
            lens.updateMatrixWorld(true);
        },
        ndc(t: number, point: T.Vector3) {
            this.focus(t);
            return point.clone().project(lens);
        },
    };
}

const finite = (n: number) => Number.isFinite(n);
const assertVecFinite = (v: { x: number; y: number; z: number }, label: string) =>
    assert.ok([v.x, v.y, v.z].every(finite), label);

/** Per-frame real-camera check: finite aim target, aim direction and world/projection matrices. */
function assertCameraFinite(sampler: ReturnType<typeof cameraSampler>, t: number, label: string, frame: number): void {
    sampler.focus(t);
    assertVecFinite(sampler.aimOf(t), `${label}: camera target at frame ${frame}`);
    const direction = new T.Vector3();
    sampler.lens.getWorldDirection(direction);
    assertVecFinite(direction, `${label}: camera direction at frame ${frame}`);
    for (const name of ['matrixWorld', 'projectionMatrix'] as const)
        for (const [index, value] of sampler.lens[name].elements.entries())
            assert.ok(finite(value), `${label}: camera ${name}[${index}] finite at frame ${frame}`);
}

interface RealRig {
    place: (t: number) => void;
    /** Min/max ndc over every vertex of the animated white model plus the visible vertex count. */
    ndcBounds: (sampler: ReturnType<typeof cameraSampler>, t: number) => { minX: number; maxX: number; minY: number; maxY: number; inside: number };
    /** World-space facing direction of the actual rig (a local +Z head point vs head origin). */
    forward: (t: number) => T.Vector3;
    /** World bounding box of the animated rig at t. */
    bounds: (t: number) => { center: T.Vector3; minY: number };
    hipSwing: (t: number) => number;
    assertJointsFinite: (t: number) => void;
    /** One place() then per-frame runtime finiteness: every joint rotation and the root's
     *  world matrix (the transform the engine would apply). */
    assertFrameRuntime: (t: number) => void;
    dispose: () => void;
}

/** The real runtime chain (makeActor → scaleHuman → animateActor → fitFeetToSurface) with
 *  engine-equivalent root placement — not samplePose and not a hand-tuned proxy. */
function openRig(project: Project, actor: Entity): RealRig {
    const rig = makeActor(actor);
    scaleHuman(rig, actor);
    const meshes: T.Mesh[] = [];
    rig.root.traverse(o => { if ((o as T.Mesh).isMesh) meshes.push(o as T.Mesh); });
    const vertex = new T.Vector3();
    const place = (t: number) => {
        assertSampleTime(project, t, `${actor.name} rig`);
        rig.root.position.copy(entityPosition(actor, t));
        rig.root.rotation.set(actor.rotation[0], entityYaw(actor, t, project), actor.rotation[2]);
        animateActor(rig, actor, t);
        if (actor.footContact) fitFeetToSurface(rig, () => 0);
        rig.root.updateMatrixWorld(true);
    };
    return {
        place,
        ndcBounds(sampler, t) {
            sampler.focus(t);
            place(t);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, inside = 0;
            for (const mesh of meshes) {
                const attribute = mesh.geometry.attributes.position;
                for (let i = 0; i < attribute.count; i++) {
                    vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).project(sampler.lens);
                    minX = Math.min(minX, vertex.x); maxX = Math.max(maxX, vertex.x);
                    minY = Math.min(minY, vertex.y); maxY = Math.max(maxY, vertex.y);
                    if (Math.abs(vertex.x) <= 1 && Math.abs(vertex.y) <= 1) inside++;
                }
            }
            return { minX, maxX, minY, maxY, inside };
        },
        forward(t) {
            place(t);
            const origin = rig.head.getWorldPosition(new T.Vector3());
            return rig.head.localToWorld(new T.Vector3(0, 0, .3)).sub(origin).normalize();
        },
        bounds(t) {
            place(t);
            const box = new T.Box3().setFromObject(rig.root, true);
            return { center: box.getCenter(new T.Vector3()), minY: box.min.y };
        },
        hipSwing(t) { place(t); return rig.joints.leftHip.rotation.x; },
        assertJointsFinite(t) {
            place(t);
            for (const [name, joint] of Object.entries(rig.joints))
                for (const axis of ['x', 'y', 'z'] as const)
                    assert.ok(finite(joint.rotation[axis]), `joint ${name}.${axis} finite at t=${t}`);
        },
        assertFrameRuntime(t) {
            place(t);
            for (const [name, joint] of Object.entries(rig.joints))
                for (const axis of ['x', 'y', 'z'] as const)
                    assert.ok(finite(joint.rotation[axis]), `joint ${name}.${axis} finite at t=${t}`);
            for (const [index, value] of rig.root.matrixWorld.elements.entries())
                assert.ok(finite(value), `root world matrix [${index}] finite at t=${t}`);
        },
        dispose() { disposeTree(rig.root); },
    };
}

function assertEditableAndSerializable(project: Project): void {
    assertProject(project);
    const round = JSON.parse(JSON.stringify(project));
    assertProject(round);
    const back = projectForScene(readSceneDocument(round));
    assertProject(back);
    assert.deepStrictEqual(back, { ...round, resources: [] });
}

/** Every id (entities, clips and actual references) must satisfy the frozen EntityIdSchema and
 *  carry the bounded `s-<namespace>-…` shape; roleMap must point at real actors. */
function assertStaticStructure(project: Project, roleMap: Record<string, string>, namespace = NS): void {
    assert.equal(project.version, 2, 'suite projects stay ordinary v2 documents');
    assert.equal(project.fps, SHOT_SUITE_FPS);
    assert.equal(project.resources, undefined, 'no downloaded resources');
    assert.equal(project.entities.filter(e => e.kind === 'camera').length, 1, 'one camera');
    assert.equal(project.cuts.length, 1, 'one cut');
    assert.equal(project.cuts[0].time, 0, 'cut starts at zero');
    assert.equal(project.cuts[0].cameraId, project.entities.find(e => e.kind === 'camera')!.id);
    const seen = new Set<string>();
    const checkId = (id: string, label: string) => {
        assert.ok(EntityIdSchema.safeParse(id).success, `${label} ${id} violates the frozen EntityIdSchema`);
        assert.ok(id.startsWith(`s-${namespace}-`), `${label} ${id} lacks the controlled prefix`);
        assert.ok(id.length <= 64, `${label} ${id} exceeds the bounded length`);
        assert.ok(!seen.has(id), `${label} ${id} unique`);
        seen.add(id);
    };
    for (const e of project.entities) {
        checkId(e.id, 'entity id');
        if (e.faceTarget) assert.ok(project.entities.some(t => t.id === e.faceTarget), 'faceTarget resolves');
        for (const c of e.clips) {
            checkId(c.id, 'clip id');
            assert.equal(Math.round(c.start * 24), c.start * 24, 'clip starts on frames');
            assert.equal(Math.round(c.end * 24), c.end * 24, 'clip ends on frames');
            assert.ok(c.start >= 0 && c.end <= project.duration + 1e-9 && c.end > c.start, 'clips stay inside the shot');
        }
        if (e.camera) {
            const cam = e.camera;
            if (cam.targetId) assert.ok(project.entities.some(t => t.id === cam.targetId && t.kind !== 'camera'), 'camera target resolves');
            if (cam.effects?.focusTargetId !== undefined) {
                const focusId = cam.effects.focusTargetId;
                assert.ok(project.entities.some(t => t.id === focusId), 'focus target resolves');
            }
        }
    }
    for (const entityId of Object.values(roleMap)) {
        assert.ok(EntityIdSchema.safeParse(entityId).success, `roleMap id ${entityId} violates the frozen EntityIdSchema`);
        const e = project.entities.find(candidate => candidate.id === entityId);
        assert.ok(e && e.kind === 'actor', 'roleMap points at actors');
    }
}

function assertFrameSampling(project: Project): void {
    const total = totalFrames(project);
    const previous = new Map<string, { x: number; y: number; z: number }>();
    const yaws = new Map<string, number>();
    for (let frame = 0; frame < total; frame++) {
        const t = frame / SHOT_SUITE_FPS;
        for (const e of project.entities) {
            const position = entityPosition(e, t);
            assertVecFinite(position, `${e.id} position at ${t}`);
            if (e.kind === 'actor') {
                const yaw = entityYaw(e, t, project);
                assert.ok(finite(yaw), `${e.id} yaw at ${t}`);
                const beforeYaw = yaws.get(e.id);
                if (beforeYaw !== undefined) assert.ok(Math.abs(wrapPi(yaw - beforeYaw)) <= 1e-6, `${e.id} yaw jumps at ${t}`);
                yaws.set(e.id, yaw);
                for (const value of Object.values(samplePose(e, t))) assert.ok(finite(value), `${e.id} pose at ${t}`);
                const action = sampledAction(e, t).action;
                assert.ok(Object.hasOwn(ACTIONS, action), `${e.id} action ${action} at ${t}`);
            }
            const before = previous.get(e.id);
            if (before) {
                const rate = e.kind === 'camera' ? 1.2 : 1.9;
                const jump = Math.hypot(position.x - before.x, position.y - before.y, position.z - before.z);
                assert.ok(jump <= rate / SHOT_SUITE_FPS + 1e-7, `${e.id} moves ${jump}m in one frame at ${t}`);
            }
            previous.set(e.id, position);
        }
    }
    assert.ok(total >= 5 * SHOT_SUITE_FPS, 'sampling actually visits the runtime frames');
}

function assertCoverage(project: Project, times: number[], marginX = .92, marginY = .95): void {
    const sampler = cameraSampler(project);
    for (const t of times) {
        for (const e of project.entities.filter(e => e.kind === 'actor')) {
            const base = entityPosition(e, t);
            for (const height of [0, 1.0, 1.75]) {
                const ndc = sampler.ndc(t, base.clone().add(new T.Vector3(0, height, 0)));
                assert.ok(Math.abs(ndc.x) <= marginX && Math.abs(ndc.y) <= marginY,
                    `${e.name} (${height}m) framed at t=${t}: ${ndc.x.toFixed(3)},${ndc.y.toFixed(3)}`);
            }
        }
    }
}

for (const suite of SHOT_SUITE_IDS) {
    for (const aspect of ASPECTS) {
        for (const duration of DURATIONS) {
            test(`A1/A6 base ${suite} ${aspect} ${duration}s stays editable and samples clean`, () => {
                const result = createShotSuite(validInput(suite, { aspect, durationSeconds: duration }));
                assert.equal(result.suite, suite);
                assert.equal(result.suiteVersion, SHOT_SUITE_VERSION);
                assert.equal(result.resourceNote, SUITE_RESOURCE_NOTE);
                assert.equal(result.params.aspect, aspect);
                assert.equal(result.params.durationSeconds, duration);
                const project = result.project;
                assert.equal(project.duration, duration);
                assert.equal(project.aspect, aspect);
                assert.ok(project.room.enabled, 'neutral white-model room stage');
                assertEditableAndSerializable(project);
                assertStaticStructure(project, result.roleMap);
                assertFrameSampling(project);
                // Enter starts deliberately fully off-screen and exit ends fully off-screen; the
                // whole-model edge behaviour is proven by the dedicated A2/A3 matrix below.
                const coverageTimes = suite === 'character-enter-exit'
                    ? [duration / 2, duration - 1 / SHOT_SUITE_FPS]
                    : [0, duration / 2, duration - 1 / SHOT_SUITE_FPS];
                assertCoverage(project, coverageTimes);
            });
        }
    }
}

test('catalogue mirrors the approved five suites and their frozen ranges', () => {
    assert.deepEqual(SUITE_CATALOG.map(entry => entry.id), [...SHOT_SUITE_IDS]);
    assert.deepEqual(suiteCatalogEntry('two-person-dialogue').numberParams.distance, { min: 1.2, max: 2.4, default: 1.6 });
    assert.deepEqual(suiteCatalogEntry('character-enter-exit').enumParams.direction, { values: ['enter', 'exit'], default: 'enter' });
    assert.deepEqual(suiteCatalogEntry('tracking-follow').numberParams.travel, { min: 2, max: 6, default: 4 });
    assert.deepEqual(suiteCatalogEntry('push-orbit').numberParams.angle, { min: 15, max: 45, default: 30 });
    assert.deepEqual(suiteCatalogEntry('simple-standoff').numberParams.distance, { min: 1.5, max: 3, default: 2 });
    for (const entry of SUITE_CATALOG) assert.ok(entry.label && entry.detail && entry.roles.min >= 1);
});

test('roleId and namespace semantics mirror the frozen dsk.v1 schema without importing it', () => {
    const samples = ['ab', 'a-b', 'a1', 'a'.repeat(64), 'a', '-ab', 'ab-', 'A-b', 'a_b', 'ab.cd', '', 'a'.repeat(65), 42, null, undefined];
    for (const sample of samples) {
        const ours = typeof sample === 'string' && SUITE_ROLE_PATTERN.test(sample);
        assert.equal(ours, RoleIdSchema.safeParse(sample).success, `roleId mismatch for ${String(sample)}`);
    }
    for (const good of ['suite01a9', 'aaaaaaaa', '0123456789abcdef']) assert.ok(SUITE_NAMESPACE_PATTERN.test(good));
    for (const bad of ['short7z', 'aaaaaaaaaaaaaaaaa', 'UPPERCASE12', 'with-hyphn', 'with_underscore', '']) assert.ok(!SUITE_NAMESPACE_PATTERN.test(bad));
    // The boundary literal itself is proven, not assumed: exactly 16 chars, accepted; 17 chars
    // and below-minimum 7 chars are rejected. (15 chars stay legal — inside 8-16.)
    assert.equal(MAX_NAMESPACE.length, 16, `max namespace literal must be exactly 16 chars (got ${MAX_NAMESPACE.length})`);
    assert.ok(SUITE_NAMESPACE_PATTERN.test(MAX_NAMESPACE), 'the 16-char boundary namespace is valid');
    assert.ok(SUITE_NAMESPACE_PATTERN.test(MAX_NAMESPACE.slice(0, 15)), '15 chars stay valid inside the 8-16 window');
    assert.ok(!SUITE_NAMESPACE_PATTERN.test(MAX_NAMESPACE + 'f'), '17 chars are rejected');
    assert.ok(!SUITE_NAMESPACE_PATTERN.test('a012345'), '7 chars are rejected');
});

test('A1/A5 every final id satisfies the frozen EntityIdSchema across namespace and role extremes', () => {
    const longA = 'x'.repeat(63) + 'a', longB = 'x'.repeat(63) + 'b';
    assert.equal(RoleIdSchema.safeParse(longA).success, true, '64-char similar roles are legal inputs');
    // Digit-leading 8-char namespace, prefix-adjacent 9-char namespace, maximal 16-char namespace,
    // two-char roles, 64-char roles and a near-identical 64-char pair.
    const scenarios = [
        { namespace: '01234567', roles: ['ab', longA], speaker: 'ab' },
        { namespace: '012345678', roles: [longA, longB], speaker: longA },
        { namespace: MAX_NAMESPACE, roles: ['c-d', 'e1f2'], speaker: 'c-d' },
    ];
    const allIds: string[] = [];
    for (const scenario of scenarios) {
        const result = createShotSuite({ suite: 'two-person-dialogue', ...scenario });
        const ids = result.project.entities.flatMap(e => [e.id, ...e.clips.map(c => c.id)]);
        assert.ok(ids.length >= 5, 'ids collected for entities and clips');
        for (const id of ids) {
            assert.equal(EntityIdSchema.safeParse(id).success, true, `id ${id} must satisfy the frozen EntityIdSchema`);
            assert.ok(id.startsWith(`s-${scenario.namespace}-`), `id ${id} keeps the namespace prefix`);
        }
        assert.equal(new Set(ids).size, ids.length, `ids unique in ${scenario.namespace}`);
        for (const [role, entityId] of Object.entries(result.roleMap)) {
            assert.equal(EntityIdSchema.safeParse(entityId).success, true, `roleMap ${role} → ${entityId} schema-safe`);
        }
        // roleMap values come from the registry derivation: stable sorted index, never roleId text.
        scenario.roles.forEach((role, index) => {
            const expected = SuiteIdRegistry.finalId(scenario.namespace, suiteEntityKey.role(index));
            assert.equal(result.roleMap[role], expected, `${role} maps to the registry-derived id`);
        });
        allIds.push(...ids);
    }
    assert.equal(new Set(allIds).size, allIds.length, 'id sets of different namespaces never intersect (incl. prefix-adjacent)');
});

test('A4 role mapping survives rename, reorder, duration and aspect changes under extreme ids', () => {
    const longA = 'x'.repeat(63) + 'a', longB = 'x'.repeat(63) + 'b';
    const base = createShotSuite({ suite: 'simple-standoff', namespace: '01234567', roles: [longA, longB], lead: longB, durationSeconds: 10 });
    const reordered = createShotSuite({ suite: 'simple-standoff', namespace: '01234567', roles: [longB, longA], lead: longB, durationSeconds: 10 });
    assert.deepStrictEqual(base.roleMap, reordered.roleMap, 'input order never changes the mapping');
    const reframed = createShotSuite({ suite: 'simple-standoff', namespace: '01234567', roles: [longA, longB], lead: longB, durationSeconds: 5, aspect: '9:16' });
    assert.deepStrictEqual(base.roleMap, reframed.roleMap, 'duration/aspect never change the mapping');
    const renamed = createShotSuite({ suite: 'simple-standoff', namespace: '01234567', roles: [longA, 'short-role'], lead: 'short-role' });
    // Ids derive from the sorted position inside the CURRENT role set: 'short-role' sorts before
    // longA, so longA shifts to slot 1. Stability is guaranteed for a fixed role set (above);
    // swapping roleIds is a set change and re-derives slots, per the approved identity semantics.
    const sorted = [longA, 'short-role'].sort();
    assert.equal(renamed.roleMap[longA], SuiteIdRegistry.finalId('01234567', suiteEntityKey.role(sorted.indexOf(longA))));
    assert.equal(renamed.roleMap['short-role'], SuiteIdRegistry.finalId('01234567', suiteEntityKey.role(sorted.indexOf('short-role'))));
    for (const id of Object.values(renamed.roleMap)) assert.equal(EntityIdSchema.safeParse(id).success, true);
});

test('A2 enter/exit and follow keep one continuous root yaw across hold/walk/stop boundaries', () => {
    for (const duration of DURATIONS) {
        for (const side of ['left', 'right'] as const) {
            const follow = createShotSuite(validInput('tracking-follow', { side, durationSeconds: duration }));
            const followActor = follow.project.entities.find(e => e.kind === 'actor')!;
            const followTotal = totalFrames(follow.project);
            const followSign = side === 'right' ? 1 : -1;
            for (let frame = 0; frame < followTotal; frame++) {
                const yaw = entityYaw(followActor, frame / SHOT_SUITE_FPS, follow.project);
                assert.ok(Math.abs(Math.abs(yaw) - Math.PI / 2) < 1e-9, `follow yaw stays on the walk line at ${frame}`);
            }
            const rig = openRig(follow.project, followActor);
            try {
                for (const frame of [0, 1, Math.floor(followTotal * .25), Math.floor(followTotal * .5), followTotal - 2, followTotal - 1]) {
                    const forward = rig.forward(frame / SHOT_SUITE_FPS);
                    assert.ok(forward.x * followSign > .9 && Math.abs(forward.y) < .3,
                        `follow rig faces the walk direction at frame ${frame} (x=${forward.x.toFixed(3)})`);
                }
            } finally { rig.dispose(); }
        }
    }
});

test('A2/A3/A7 the whole white model crosses the frame edge on every branch, aspect and duration', () => {
    for (const aspect of ASPECTS) {
        for (const direction of ['enter', 'exit'] as const) {
            for (const side of ['left', 'right'] as const) {
                for (const duration of DURATIONS) {
                    const { project } = createShotSuite(validInput('character-enter-exit', { aspect, direction, side, durationSeconds: duration }));
                    const actor = project.entities.find(e => e.kind === 'actor')!;
                    const sampler = cameraSampler(project);
                    const rig = openRig(project, actor);
                    try {
                        const total = totalFrames(project);
                        const sideSign = side === 'right' ? 1 : -1;
                        const walkStart = direction === 'enter' ? 0 : Math.round(total * .35);
                        const walkEnd = direction === 'enter' ? Math.round(total * .65) : total;
                        const walkSign = (direction === 'enter' ? -sideSign : sideSign);
                        // Continuous wrapped yaw through hold → walk → stop, with the correct sign.
                        let previousYaw: number | null = null;
                        for (let frame = 0; frame < total; frame++) {
                            const yaw = entityYaw(actor, frame / SHOT_SUITE_FPS, project);
                            assert.ok(Math.abs(Math.abs(yaw) - Math.PI / 2) < 1e-9, `${aspect} ${direction} ${side} ${duration}s yaw on walk line at ${frame}`);
                            if (previousYaw !== null) assert.ok(Math.abs(wrapPi(yaw - previousYaw)) <= 1e-9, `yaw jumps at frame ${frame}`);
                            previousYaw = yaw;
                        }
                        // The real rig actually faces the walk direction around every boundary.
                        const boundaryFrames = [...new Set([0, 1, Math.max(0, walkStart - 1), walkStart, Math.min(walkStart + 1, total - 1),
                            Math.max(0, walkEnd - 1), Math.min(walkEnd, total - 1), total - 1])];
                        for (const frame of boundaryFrames) {
                            const forward = rig.forward(frame / SHOT_SUITE_FPS);
                            assert.ok(forward.x * walkSign > .9, `${aspect} ${direction} ${side} ${duration}s rig faces walk dir at frame ${frame}`);
                        }
                        const fullyBeyond = (b: { minX: number; maxX: number }, label: string) => {
                            if (sideSign === 1) assert.ok(b.minX > 1, `${label}: nearest vertex ${b.minX.toFixed(3)} must sit beyond the right edge`);
                            else assert.ok(b.maxX < -1, `${label}: nearest vertex ${b.maxX.toFixed(3)} must sit beyond the left edge`);
                        };
                        if (direction === 'enter') {
                            fullyBeyond(rig.ndcBounds(sampler, 0), `${aspect} enter ${side} ${duration}s first frame`);
                            // Landing: the whole model back inside the frame at 0.65T and at the end.
                            for (const frame of [walkEnd, total - 1]) {
                                const b = rig.ndcBounds(sampler, frame / SHOT_SUITE_FPS);
                                assert.ok(b.inside > 0 && b.maxX <= .99 && b.minX >= -.99 && b.maxY <= .99 && b.minY >= -.99,
                                    `${aspect} enter ${side} ${duration}s lands fully inside at frame ${frame} (${b.minX.toFixed(2)}..${b.maxX.toFixed(2)})`);
                            }
                            let firstVisible = -1;
                            for (let frame = 0; frame < total; frame++) if (rig.ndcBounds(sampler, frame / SHOT_SUITE_FPS).inside > 0) { firstVisible = frame; break; }
                            assert.ok(firstVisible >= 0 && firstVisible <= walkEnd * .5, `${aspect} enter ${side} ${duration}s crosses early (frame ${firstVisible})`);
                        } else {
                            // Last PLAYABLE frame is T-1/24: the whole model must already be beyond the edge.
                            const last = rig.ndcBounds(sampler, (total - 1) / SHOT_SUITE_FPS);
                            fullyBeyond(last, `${aspect} exit ${side} ${duration}s last playable frame`);
                            assert.equal(last.inside, 0, `${aspect} exit ${side} ${duration}s has no visible vertex at T-1/24`);
                            const atWalkStart = rig.ndcBounds(sampler, walkStart / SHOT_SUITE_FPS);
                            assert.ok(atWalkStart.inside > 0, `${aspect} exit ${side} ${duration}s still visible when the walk starts`);
                            const chest = sampler.ndc((total - 1) / SHOT_SUITE_FPS, entityPosition(actor, (total - 1) / SHOT_SUITE_FPS).add(new T.Vector3(0, 1, 0)));
                            assert.ok((sideSign === 1 ? chest.x > 0 : chest.x < 0), `exits toward ${side}`);
                            let lastVisible = total - 1;
                            while (rig.ndcBounds(sampler, lastVisible / SHOT_SUITE_FPS).inside === 0) lastVisible--;
                            assert.ok(lastVisible > walkStart, `${aspect} exit ${side} ${duration}s stays visible past the exit start (frame ${lastVisible})`);
                        }
                        // The animated joints are real finite animation, not a frozen proxy.
                        rig.assertJointsFinite(Math.min(walkStart + 1, total - 1) / SHOT_SUITE_FPS);
                    } finally { rig.dispose(); }
                }
            }
        }
    }
});

test('A2 tracking-follow moves actor and camera by the same travel with a constant offset', () => {
    for (const duration of DURATIONS) {
        for (const side of ['left', 'right'] as const) {
            for (const travel of [2, 6]) {
                const { project } = createShotSuite(validInput('tracking-follow', { side, travel, durationSeconds: duration }));
                const actor = project.entities.find(e => e.kind === 'actor')!;
                const sampler = cameraSampler(project);
                const walk = actor.clips.find(c => c.action === 'walk')!;
                const moved = entityPosition(actor, walk.end).distanceTo(entityPosition(actor, walk.start));
                const cameraMoved = entityPosition(sampler.entity, walk.end).distanceTo(entityPosition(sampler.entity, walk.start));
                assert.ok(Math.abs(moved - travel) < 1e-9, `actor travels ${moved}`);
                assert.ok(Math.abs(cameraMoved - travel) < 1e-9, `camera travels ${cameraMoved}`);
                const offset0 = entityPosition(sampler.entity, walk.start).sub(entityPosition(actor, walk.start));
                for (let t = walk.start; t <= walk.end + 1e-9; t += 1 / SHOT_SUITE_FPS) {
                    const offset = entityPosition(sampler.entity, t).sub(entityPosition(actor, t));
                    assert.ok(offset.distanceTo(offset0) < 1e-9, `parallel offset holds at ${t}`);
                    const ndc = sampler.ndc(t, entityPosition(actor, t).add(new T.Vector3(0, 1, 0)));
                    assert.ok(Math.abs(ndc.x) <= .9 && Math.abs(ndc.y) <= .92, `subject framed at ${t}`);
                }
                const pace = travel / (walk.end - walk.start);
                assert.ok(walk.speed > 0 && walk.speed <= 1.2, 'cadence stays in a walkable band');
                assert.ok(Math.abs(walk.speed * 1.5 - pace) < 1e-9, 'gait cadence matches route pace');
                const direction = entityPosition(actor, walk.end).sub(entityPosition(actor, walk.start)).x;
                assert.ok((side === 'right' ? direction > 0 : direction < 0), `moves toward ${side}`);
            }
        }
    }
});

test('A2 push and orbit reuse the presets with approved ranges and stay framed', () => {
    const samplerOf = (suite: ShotSuiteId, overrides: Record<string, unknown>) => {
        const { project } = createShotSuite(validInput(suite, overrides));
        return { project, sampler: cameraSampler(project) };
    };
    for (const distance of [.5, 1.5]) {
        const { project, sampler } = samplerOf('push-orbit', { mode: 'push', distance, durationSeconds: 10 });
        const end = project.duration;
        const moved = entityPosition(sampler.entity, end).distanceTo(entityPosition(sampler.entity, 0));
        assert.ok(Math.abs(moved - distance) < 1e-6, `push travels ${moved}`);
        const step = entityPosition(sampler.entity, end).sub(entityPosition(sampler.entity, 0));
        assert.ok(step.dot(sampler.aimOf(0).sub(entityPosition(sampler.entity, 0))) > 0, 'push moves toward the subject');
        // Framing at the true push END FRAME (last playable frame), not past the shot end.
        assertCoverage(project, [end - 1 / SHOT_SUITE_FPS], .92, .95);
    }
    for (const angle of [15, 45]) {
        for (const side of ['left', 'right'] as const) {
            const { project, sampler } = samplerOf('push-orbit', { mode: 'orbit', angle, side, durationSeconds: 10 });
            const end = project.duration;
            const azimuth = (t: number) => { const off = entityPosition(sampler.entity, t).sub(sampler.aimOf(t)); return Math.atan2(off.x, off.z); };
            const sweep = azimuth(end) - azimuth(0);
            const expected = (side === 'right' ? 1 : -1) * angle * Math.PI / 180;
            assert.ok(Math.abs(sweep - expected) < 1e-6, `orbit sweeps ${sweep}`);
            // Mid-sweep and last PLAYABLE frame — the entry guard rejects t = duration.
            assertCoverage(project, [end / 2, end - 1 / SHOT_SUITE_FPS], .92, .95);
        }
    }
    for (const mode of ['push', 'orbit'] as const) {
        const overrides = mode === 'push' ? { mode, roles: ['han-mei', 'zhou-qi'] } : { mode, angle: 45, side: 'left', roles: ['han-mei', 'zhou-qi'] };
        const { project } = samplerOf('push-orbit', overrides);
        assert.equal(project.entities.filter(e => e.kind === 'actor').length, 2);
        assertCoverage(project, [project.duration / 2, project.duration - 1 / SHOT_SUITE_FPS], .92, .95);
    }
});

test('A2 dialogue and standoff honor distance, facing, stagger and the slow standoff push', () => {
    for (const distance of [1.2, 2.4]) {
        const { project, roleMap } = createShotSuite(validInput('two-person-dialogue', { distance, durationSeconds: 10 }));
        const actors = project.entities.filter(e => e.kind === 'actor');
        assert.ok(Math.abs(entityPosition(actors[0], 0).distanceTo(entityPosition(actors[1], 0)) - distance) < 1e-9);
        const yawA = entityYaw(actors[0], 0, project), yawB = entityYaw(actors[1], 0, project);
        const diff = Math.atan2(Math.sin(yawA - yawB), Math.cos(yawA - yawB));
        assert.ok(Math.abs(Math.abs(diff) - Math.PI) < 1e-6, 'actors face each other');
        const speaker = project.entities.find(e => e.id === roleMap['lin-xia'])!;
        const listener = project.entities.find(e => e.id === roleMap['wang-hai'])!;
        const speakerPoint = speaker.clips.find(c => c.action === 'point')!;
        const listenerPoint = listener.clips.find(c => c.action === 'point')!;
        assert.ok(speakerPoint.start < listenerPoint.start, 'speaker gestures first');
        const flipped = createShotSuite(validInput('two-person-dialogue', { distance, speaker: 'wang-hai' }));
        assert.ok(flipped.project.entities.find(e => e.id === flipped.roleMap['wang-hai'])!.clips.find(c => c.action === 'point')!.start
            < flipped.project.entities.find(e => e.id === flipped.roleMap['lin-xia'])!.clips.find(c => c.action === 'point')!.start,
            'either role can be the designated speaker');
        assert.deepStrictEqual(flipped.roleMap, { 'lin-xia': `s-${NS}-r0`, 'wang-hai': `s-${NS}-r1` });
    }
    for (const distance of [1.5, 3]) {
        for (const gesture of ['point', 'idle'] as const) {
            const { project } = createShotSuite(validInput('simple-standoff', { distance, gesture, durationSeconds: 10, lead: 'zhou-qi' }));
            const actors = project.entities.filter(e => e.kind === 'actor');
            assert.ok(Math.abs(entityPosition(actors[0], 0).distanceTo(entityPosition(actors[1], 0)) - distance) < 1e-9);
            const sampler = cameraSampler(project);
            const end = project.duration;
            const moved = entityPosition(sampler.entity, end).distanceTo(entityPosition(sampler.entity, 0));
            assert.ok(Math.abs(moved - .5) < 1e-6, `standoff push is the fixed slow ${moved}`);
            assertCoverage(project, [end - 1 / SHOT_SUITE_FPS], .92, .95);
            const points = project.entities.flatMap(e => e.clips).filter(c => c.action === 'point').sort((a, b) => a.start - b.start);
            assert.equal(points.length, gesture === 'point' ? 2 : 0, 'response gestures follow the lead');
            if (gesture === 'point') assert.ok(points[0].end <= points[1].start, 'response starts after the lead gesture');
        }
    }
});

test('A4/A6 finite branch-aspect-parameter matrix: real rigs, per-frame runtime and full framing', () => {
    // Explicit bounded matrix: suite branches × parameter boundaries × aspects × duration ends.
    const matrix: { label: string; suite: ShotSuiteId; overrides: Record<string, unknown>; expectedFacing: (project: Project, actor: Entity) => T.Vector3 }[] = [
        { label: 'dialogue near', suite: 'two-person-dialogue', overrides: { distance: 1.2, aspect: '16:9', durationSeconds: 5 }, expectedFacing: mutual },
        { label: 'dialogue far portrait', suite: 'two-person-dialogue', overrides: { distance: 2.4, speaker: 'wang-hai', aspect: '9:16', durationSeconds: 15 }, expectedFacing: mutual },
        { label: 'follow short portrait', suite: 'tracking-follow', overrides: { travel: 2, side: 'left', aspect: '9:16', durationSeconds: 5 }, expectedFacing: p => walkDir(p) },
        { label: 'follow long', suite: 'tracking-follow', overrides: { travel: 6, side: 'right', aspect: '16:9', durationSeconds: 15 }, expectedFacing: p => walkDir(p) },
        { label: 'push near portrait', suite: 'push-orbit', overrides: { mode: 'push', distance: .5, aspect: '9:16', durationSeconds: 5 }, expectedFacing: () => new T.Vector3(0, 0, 1) },
        { label: 'push far', suite: 'push-orbit', overrides: { mode: 'push', distance: 1.5, aspect: '16:9', durationSeconds: 15 }, expectedFacing: () => new T.Vector3(0, 0, 1) },
        { label: 'orbit narrow', suite: 'push-orbit', overrides: { mode: 'orbit', angle: 15, side: 'left', aspect: '16:9', durationSeconds: 5 }, expectedFacing: () => new T.Vector3(0, 0, 1) },
        { label: 'orbit wide portrait', suite: 'push-orbit', overrides: { mode: 'orbit', angle: 45, side: 'right', aspect: '9:16', durationSeconds: 15 }, expectedFacing: () => new T.Vector3(0, 0, 1) },
        { label: 'orbit pair', suite: 'push-orbit', overrides: { mode: 'orbit', angle: 45, side: 'left', roles: ['han-mei', 'zhou-qi'], aspect: '9:16', durationSeconds: 10 }, expectedFacing: mutual },
        { label: 'push pair', suite: 'push-orbit', overrides: { mode: 'push', roles: ['han-mei', 'zhou-qi'], aspect: '16:9', durationSeconds: 10 }, expectedFacing: mutual },
        { label: 'standoff near portrait', suite: 'simple-standoff', overrides: { distance: 1.5, gesture: 'point', lead: 'han-mei', aspect: '9:16', durationSeconds: 5 }, expectedFacing: mutual },
        { label: 'standoff far idle', suite: 'simple-standoff', overrides: { distance: 3, gesture: 'idle', lead: 'zhou-qi', aspect: '16:9', durationSeconds: 15 }, expectedFacing: mutual },
    ];
    function mutual(project: Project, actor: Entity): T.Vector3 {
        const other = project.entities.find(e => e.kind === 'actor' && e.id !== actor.id)!;
        return entityPosition(other, 0).sub(entityPosition(actor, 0)).setY(0).normalize();
    }
    function walkDir(project: Project): T.Vector3 {
        const actor = project.entities.find(e => e.kind === 'actor')!;
        const dir = entityPosition(actor, project.duration).sub(entityPosition(actor, 0));
        assert.ok(Math.abs(dir.x) > .5, 'follow route has real lateral travel');
        return new T.Vector3(Math.sign(dir.x), 0, 0);
    }
    for (const scenario of matrix) {
        const result = createShotSuite(validInput(scenario.suite, scenario.overrides));
        const { project } = result;
        assertEditableAndSerializable(project);
        assertStaticStructure(project, result.roleMap);
        // Full per-frame runtime sampling: finite world transforms, monotone clips, no teleports,
        // continuous yaw, live camera.
        assertFrameSampling(project);
        const sampler = cameraSampler(project);
        const total = totalFrames(project);
        for (const actor of project.entities.filter(e => e.kind === 'actor')) {
            const rig = openRig(project, actor);
            try {
                const expected = scenario.expectedFacing(project, actor);
                // F2: the real animated rig AND the real camera are sampled at EVERY playable
                // frame — joints and root world matrix finite after animateActor, camera target/
                // direction/world/projection finite — and the counter proves 0..total-1 all ran.
                let visited = 0;
                for (let frame = 0; frame < total; frame++) {
                    const t = frame / SHOT_SUITE_FPS;
                    rig.assertFrameRuntime(t);
                    assertCameraFinite(sampler, t, scenario.label, frame);
                    visited++;
                }
                assert.equal(visited, total, `${scenario.label}: every playable frame 0..${total - 1} visited on the real rig`);
                // World bounding box adherence at the key moments (first, dynamic mid, last).
                for (const frame of [0, Math.floor(total / 2), total - 1]) {
                    const world = rig.bounds(frame / SHOT_SUITE_FPS);
                    assert.ok(finite(world.center.x) && finite(world.center.y) && finite(world.center.z),
                        `${scenario.label}: rig world transform finite at frame ${frame}`);
                    const root = entityPosition(actor, frame / SHOT_SUITE_FPS);
                    assert.ok(Math.hypot(world.center.x - root.x, world.center.z - root.z) < .6,
                        `${scenario.label}: rig stays on its entity at frame ${frame}`);
                    assert.ok(world.minY > -.06 && world.minY < .12, `${scenario.label}: feet on the floor at frame ${frame}`);
                }
                for (const frame of [0, Math.floor(total / 2), total - 1]) {
                    const forward = rig.forward(frame / SHOT_SUITE_FPS);
                    assert.ok(forward.dot(expected) > .85, `${scenario.label}: ${actor.name} faces the staged direction at frame ${frame}`);
                }
                // Walk phase really advances on the rig (animation applied, not a static snapshot).
                if (scenario.suite === 'tracking-follow') {
                    const walk = actor.clips.find(c => c.action === 'walk')!;
                    const a = rig.hipSwing(walk.start + 3 / SHOT_SUITE_FPS), b = rig.hipSwing(walk.start + 9 / SHOT_SUITE_FPS);
                    assert.ok(Math.abs(b - a) > .05, `${scenario.label}: walk cycle animates the rig`);
                }
                // Full white model inside the frame at the middle and last playable frames
                // (times are real seconds — the entry guard rejects raw frame numbers).
                for (const frame of [Math.floor(total / 2), total - 1]) {
                    const b = rig.ndcBounds(sampler, frame / SHOT_SUITE_FPS);
                    assert.ok(b.inside > 0 && b.maxX <= .99 && b.minX >= -.99 && b.maxY <= .99 && b.minY >= -.99,
                        `${scenario.label}: whole model framed at frame ${frame} (x ${b.minX.toFixed(2)}..${b.maxX.toFixed(2)}, y ${b.minY.toFixed(2)}..${b.maxY.toFixed(2)})`);
                }
            } finally { rig.dispose(); }
        }
    }
});

test('A3 strict input validation rejects every listed violation', () => {
    const throws = (input: unknown) => assert.throws(() => createShotSuite(input), /套件参数无效/, JSON.stringify(input) ?? String(input));
    const dialogue = validInput('two-person-dialogue');
    const enter = validInput('character-enter-exit');
    const standoff = validInput('simple-standoff');
    // 人数
    throws({ suite: 'two-person-dialogue', namespace: NS, roles: ['only-role'], speaker: 'only-role' });
    throws({ suite: 'two-person-dialogue', namespace: NS, roles: ['a-b', 'c-d', 'e-f'], speaker: 'a-b' });
    throws({ suite: 'character-enter-exit', namespace: NS, roles: ['a-b', 'c-d'] });
    throws({ suite: 'push-orbit', namespace: NS, roles: [] });
    throws({ suite: 'simple-standoff', namespace: NS, roles: ['han-mei'], lead: 'han-mei' });
    // 角色重复 / 不合法 / 主角引用错误
    throws({ ...dialogue, roles: ['a-b', 'a-b'] });
    throws({ ...dialogue, roles: ['Bad-role', 'a-b'], speaker: 'a-b' });
    throws({ ...dialogue, roles: ['a', 'b'], speaker: 'a' });
    throws({ ...dialogue, roles: [1, 2], speaker: 'a-b' });
    throws({ ...dialogue, roles: 'lin-xia' });
    throws({ ...standoff, lead: 'missing-role' });
    throws({ suite: 'simple-standoff', namespace: NS, roles: ['han-mei', 'zhou-qi'] });
    // 非法枚举
    throws({ ...enter, direction: 'teleport' });
    throws({ ...enter, side: 'middle' });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], mode: 'zoom' });
    throws({ ...standoff, gesture: 'jump' });
    throws({ ...dialogue, aspect: '21:9' });
    throws({ suite: 'pan-shot', namespace: NS, roles: ['a-b'] });
    // 数值越界
    throws({ suite: 'tracking-follow', namespace: NS, roles: ['zhao-yun'], travel: 8 });
    throws({ suite: 'tracking-follow', namespace: NS, roles: ['zhao-yun'], travel: 1 });
    throws({ ...dialogue, distance: .5 });
    throws({ ...dialogue, distance: 3 });
    throws({ ...standoff, distance: 1 });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], distance: 2 });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], mode: 'orbit', angle: 60 });
    throws({ ...dialogue, durationSeconds: 4.9 });
    throws({ ...dialogue, durationSeconds: 15.5 });
    throws({ ...dialogue, durationSeconds: 10.05 });
    // 错误类型 / 非有限数
    throws({ ...dialogue, distance: '1.6' });
    throws({ ...dialogue, durationSeconds: '10' });
    throws({ ...dialogue, speaker: 7 });
    throws({ ...dialogue, distance: NaN });
    throws({ ...dialogue, distance: Infinity });
    throws({ ...dialogue, distance: -Infinity });
    throws({ suite: 'character-enter-exit', namespace: NS, roles: ['chen-lu'], side: true });
    // namespace
    throws({ ...dialogue, namespace: 'short7z' });
    throws({ ...dialogue, namespace: 'aaaaaaaaaaaaaaaaa' });
    throws({ ...dialogue, namespace: 'UPPERCASE12' });
    throws({ ...dialogue, namespace: 'with-hyphn' });
    throws({ ...dialogue, namespace: '' });
    throws({ ...dialogue, namespace: 12345678 });
    // 未知字段 / 分支无关字段
    throws({ ...dialogue, extra: 1 });
    throws({ ...dialogue, side: 'left' });
    throws({ suite: 'tracking-follow', namespace: NS, roles: ['zhao-yun'], gesture: 'point' });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], angle: 30 });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], mode: 'orbit', angle: 30, distance: 1 });
    throws({ suite: 'push-orbit', namespace: NS, roles: ['li-lei'], mode: 'push', side: 'left' });
    // 非对象输入
    for (const junk of ['suite', null, 42, [], {}, undefined]) throws(junk);
    // parse layer itself throws the same way (no silent defaults for required fields)
    assert.throws(() => parseShotSuiteInput({ suite: 'two-person-dialogue', namespace: NS, roles: ['a-b', 'c-d'] }), /speaker/);
    assert.throws(() => parseShotSuiteInput({ suite: 'simple-standoff', namespace: NS, roles: ['a-b', 'c-d'] }), /lead/);
});

test('A4 identical normalized input reproduces deep-equal output without touching the input', () => {
    const input = validInput('simple-standoff', { durationSeconds: 10, aspect: '16:9' });
    const snapshot = JSON.stringify(input);
    const first = createShotSuite(input);
    const second = createShotSuite(input);
    assert.equal(snapshot, JSON.stringify(input), 'input object unchanged');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
    const frozen = createShotSuite(deepFreezeInput(structuredClone(input)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(frozen)));
    assert.ok(Object.isFrozen(first.params) && Object.isFrozen(first.roleMap), 'returned params/map are frozen snapshots');
    assert.ok(!Object.isFrozen(first.project), 'project stays editable');
});

test('A4 reordering, duration and aspect never change the role mapping; rename keeps stable ids', () => {
    const base = createShotSuite(validInput('simple-standoff', { durationSeconds: 10, aspect: '16:9' }));
    const reordered = createShotSuite({ suite: 'simple-standoff', namespace: NS, roles: ['zhou-qi', 'han-mei'], lead: 'han-mei', durationSeconds: 10, aspect: '16:9' });
    assert.deepStrictEqual(base.roleMap, reordered.roleMap);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(base.project)), JSON.parse(JSON.stringify(reordered.project)));
    const reframed = createShotSuite(validInput('simple-standoff', { durationSeconds: 5, aspect: '9:16' }));
    assert.deepStrictEqual(base.roleMap, reframed.roleMap);
    const renamed = createShotSuite({ suite: 'simple-standoff', namespace: NS, roles: ['han-mei', 'wang-fei'], lead: 'han-mei' });
    assert.equal(renamed.roleMap['han-mei'], base.roleMap['han-mei'], 'surviving role keeps its entity');
    assert.equal(renamed.roleMap['wang-fei'], `s-${NS}-r1`);
    assert.equal(renamed.roleMap['zhou-qi'], undefined, 'renamed-away role has no mapping');
    // Slot ids derive from the current set's sorted order; a swapped-in roleId takes the freed
    // slot. Rename in the approved sense means display name — roleId set changes re-derive slots.
});

test('A4 different namespaces never share ids and no temporary UUID residue remains', () => {
    const idsOf = (project: Project) => project.entities.flatMap(e => [e.id, ...e.clips.map(c => c.id)]).sort();
    const first = createShotSuite(validInput('two-person-dialogue'));
    const second = createShotSuite(validInput('two-person-dialogue', { namespace: 'otherns77' }));
    const a = idsOf(first.project), b = idsOf(second.project);
    assert.ok(a.length > 0 && new Set(a).size === a.length);
    assert.ok(a.every(id => !b.includes(id)), 'namespace id sets are disjoint');
    for (const suite of SHOT_SUITE_IDS) {
        const result = createShotSuite(validInput(suite, { namespace: `nsresidue${SHOT_SUITE_IDS.indexOf(suite)}` }));
        const json = JSON.stringify(result.project);
        assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(json), `no UUID residue in ${suite}`);
    }
});

test('A5 every base project keeps unique compliant ids, resolvable references and cut wiring', () => {
    for (const suite of SHOT_SUITE_IDS) {
        for (const aspect of ASPECTS) {
            const result = createShotSuite(validInput(suite, { aspect, durationSeconds: 10 }));
            assertStaticStructure(result.project, result.roleMap);
            const camera = result.project.entities.find(e => e.kind === 'camera')!;
            assert.ok(camera.camera, 'camera config present');
            for (const cut of result.project.cuts) assert.equal(cut.cameraId, camera.id);
        }
    }
});
