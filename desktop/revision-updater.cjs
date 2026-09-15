const { parseReleaseVersion, compareReleaseVersions } = require('./release-version.cjs');

// Override only version ordering. Transport, OS/rollout eligibility, download
// checksums, signature validation and installation stay with electron-updater.
function withRevisionVersions(BaseUpdater) {
    return class RevisionUpdater extends BaseUpdater {
        async isUpdateAvailable(info) {
            if (!parseReleaseVersion(info.version)) return false;
            if (compareReleaseVersions(info.version, this.app.version) <= 0) return false;
            if (!await this.isUpdateSupported(info)) return false;
            return Boolean(await this.isUserWithinRollout(info));
        }
    };
}
module.exports = { withRevisionVersions };
