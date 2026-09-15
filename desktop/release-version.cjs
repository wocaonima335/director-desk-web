// Public releases use three or four numeric components. npm/Electron retain a
// valid SemVer transport: 0.4.7.1 <=> 0.4.7+revision.1 (a stable build, not RC).
function parseReleaseVersion(value) {
    if (typeof value !== 'string') return null;
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:(?:\.|\+revision\.)(0|[1-9]\d*))?$/.exec(value);
    if (!match) return null;
    const parts = match.slice(1).map(n => Number(n ?? 0));
    if (parts.some(n => !Number.isSafeInteger(n))) return null;
    return { parts, version: parts.slice(0, match[4] === undefined ? 3 : 4).join('.') };
}
function releaseVersion(value) {
    const parsed = parseReleaseVersion(value);
    if (!parsed) throw Error('Invalid stable release version');
    return parsed.version;
}
function compareReleaseVersions(a, b) {
    const left = parseReleaseVersion(a), right = parseReleaseVersion(b);
    if (!left || !right) throw Error('Invalid stable release version');
    for (let i = 0; i < 4; i++) {
        if (left.parts[i] !== right.parts[i]) return left.parts[i] > right.parts[i] ? 1 : -1;
    }
    return 0;
}
module.exports = { parseReleaseVersion, releaseVersion, compareReleaseVersions };
