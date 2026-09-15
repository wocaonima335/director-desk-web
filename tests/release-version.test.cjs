const test = require('node:test');
const assert = require('node:assert/strict');
const semver = require('semver');
const { parseReleaseVersion, releaseVersion, compareReleaseVersions } = require('../desktop/release-version.cjs');
const { withRevisionVersions } = require('../desktop/revision-updater.cjs');

test('three/four-part stable releases and SemVer transport share numeric ordering', () => {
    const order = ['0.4.7', '0.4.7.1', '0.4.7.2', '0.4.7.10', '0.4.8', '0.5.0', '1.0.0'];
    for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
        assert.equal(compareReleaseVersions(order[i], order[j]), Math.sign(i - j));
    }
    assert.equal(compareReleaseVersions('0.4.7', '0.4.7.0'), 0);
    assert.equal(compareReleaseVersions('v0.4.7.1', '0.4.7+revision.1'), 0);
    assert.equal(releaseVersion('0.4.7+revision.1'), '0.4.7.1');
    for (const bad of ['', '0.4', '0.4.7.1.1', '0.4.7.01', '0.4.7-beta.1', '0.4.7+unknown.1', '1.2.3.9007199254740992', null]) {
        assert.equal(parseReleaseVersion(bad), null);
        assert.throws(() => compareReleaseVersions(bad, '0.4.7'));
    }
});

test('package, native version and public artifact names agree without invalid npm SemVer', () => {
    const metadata = require('../package.json'), config = require('../desktop/builder.cjs');
    assert.ok(semver.valid(metadata.version));
    assert.equal(releaseVersion(metadata.version), metadata.shortVersion);
    assert.equal(config.buildVersion, metadata.shortVersion);
    assert.equal(config.extraMetadata.version, metadata.version);
    assert.equal(Number(config.buildNumber), parseReleaseVersion(metadata.version).parts[3]);
    assert.equal(config.nsis.artifactName, `DirectorDesk-Setup-${metadata.shortVersion}.\${ext}`);
});

test('electron-builder metadata normalization preserves revision through extraMetadata', async () => {
    const fs = require('node:fs/promises'), path = require('node:path');
    const { Packager } = require('app-builder-lib/out/packager');
    const { AppInfo } = require('app-builder-lib/out/appInfo');
    const root = path.resolve('.local'); await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'version-build-test-'));
    try {
        const metadata = { name: 'version-test', version: '1.2.3+revision.4', shortVersion: '1.2.3.4', description: 'Version fixture', author: 'Test' };
        await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(metadata));
        const config = require('../desktop/builder.cjs');
        const packager = new Packager({ projectDir: directory, config: {
            extraMetadata: { ...config.extraMetadata, version: metadata.version },
            buildVersion: metadata.shortVersion, buildNumber: '4',
        } });
        await packager.validateConfig();
        const info = new AppInfo(packager, null);
        assert.equal(info.version, metadata.version, 'version used by generated latest.yml must retain the revision');
        assert.equal(info.channel, null, 'revision releases stay on the stable update channel');
        assert.equal(info.getVersionInWeirdWindowsForm(), '1.2.3.4');
    } finally {
        assert.equal(path.dirname(directory), root);
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('revision updater retains OS and rollout checks and never offers older, equal or prerelease versions', async () => {
    class Base {
        app = { version: '0.4.7+revision.1' };
        supported = true; rollout = true;
        async isUpdateSupported() { return this.supported; }
        async isUserWithinRollout() { return this.rollout; }
    }
    const Updater = withRevisionVersions(Base), updater = new Updater();
    for (const version of ['0.4.7', '0.4.7.1', '0.4.7+revision.1', '0.4.8-beta.1', 'bad']) {
        assert.equal(await updater.isUpdateAvailable({ version }), false);
    }
    for (const version of ['0.4.7.2', '0.4.7+revision.2', '0.4.8']) {
        assert.equal(await updater.isUpdateAvailable({ version }), true);
    }
    updater.supported = false; assert.equal(await updater.isUpdateAvailable({ version: '0.4.7.2' }), false);
    updater.supported = true; updater.rollout = false; assert.equal(await updater.isUpdateAvailable({ version: '0.4.7.2' }), false);
});
