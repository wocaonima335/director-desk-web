/** File handles still come from Chromium's user-selected file/folder picker.
 * This grants only the app document's File System API, not unrelated permissions
 * or restricted OS paths. Chromium's handle permission checks have no frame,
 * so Electron supplies a null sender and isMainFrame=false for those checks. */
function installFilePermissions(session, contents) {
    const trusted = (permission, origin) => !contents.isDestroyed()
        && contents.getURL() === 'director://app/' && permission === 'fileSystem'
        && (origin === 'director://app' || origin === 'director://app/');
    session.setPermissionCheckHandler((sender, permission, origin) => (sender === null || sender === contents) && trusted(permission, origin));
    session.setPermissionRequestHandler((sender, permission, callback, details) => callback(sender === contents && trusted(permission, details.requestingUrl)));
}
module.exports = { installFilePermissions };
