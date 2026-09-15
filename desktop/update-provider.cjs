/** Keep discovery events separate from the selected download's UI state. */
function configureUpdater(makeUpdater, feed) {
    const updater = makeUpdater(feed);
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false; updater.allowPrerelease = false;
    updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
    updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    return updater;
}
async function probeUpdater(updater) {
    let info, available = false, error, timer;
    const onAvailable = value => { info = value; available = true; };
    const onCurrent = value => { info = value; available = false; };
    const onError = value => { error = value; };
    updater.on('update-available', onAvailable); updater.on('update-not-available', onCurrent); updater.on('error', onError);
    const check = Promise.resolve().then(() => updater.checkForUpdates());
    try {
        const result = await Promise.race([check, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Update check timed out')), 15000);
        })]);
        if (error) throw error;
        info ??= result?.updateInfo;
        if (!info) throw Error('Missing update information');
        return { info, available };
    } finally {
        clearTimeout(timer);
        // A timed-out request may finish later. Its events must not change UI or throw unhandled errors.
        void check.catch(() => {}).finally(() => {
            updater.removeListener('update-available', onAvailable);
            updater.removeListener('update-not-available', onCurrent);
            updater.removeListener('error', onError);
        });
    }
}
const releaseNotes = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(n => n.note || '').join('\n') : '';
module.exports = { configureUpdater, probeUpdater, releaseNotes };
