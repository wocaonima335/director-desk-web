const test=require('node:test'),assert=require('node:assert/strict');
const {installFilePermissions}=require('../desktop/file-permissions.cjs');
test('file picker writes are permitted only for this app document; unrelated permissions remain denied',()=>{
    let check,request,url='director://app/',destroyed=false;
    const contents={getURL:()=>url,isDestroyed:()=>destroyed};
    installFilePermissions({setPermissionCheckHandler:f=>check=f,setPermissionRequestHandler:f=>request=f},contents);
    const requested=(sender,permission,requestingUrl)=>{
        let granted;request(sender,permission,value=>granted=value,{requestingUrl,isMainFrame:false});return granted;
    };
    // Electron invokes FileSystemAccessPermissionGrant::GetStatus without a frame.
    const details={isMainFrame:false,filePath:'C:\\exports\\reference.mp4',isDirectory:false,fileAccessType:'writable'};
    for(const sender of [contents,null]){
        for(const origin of ['director://app','director://app/'])assert.equal(check(sender,'fileSystem',origin,details),true);
        for(const permission of ['media','clipboard-read','geolocation','unknown'])assert.equal(check(sender,permission,'director://app'),false);
        for(const origin of ['https://example.com','director://app.evil/','director://app/other','null',''])assert.equal(check(sender,'fileSystem',origin),false);
    }
    assert.equal(requested(contents,'fileSystem','director://app/'),true);
    for(const sender of [{},undefined])assert.equal(check(sender,'fileSystem','director://app'),false);
    for(const sender of [null,{},undefined])assert.equal(requested(sender,'fileSystem','director://app/'),false);
    for(const permission of ['media','clipboard-read','geolocation','unknown'])assert.equal(requested(contents,permission,'director://app/'),false);
    for(const origin of ['https://example.com','director://app.evil/','director://app/other','null',''])assert.equal(requested(contents,'fileSystem',origin),false);
    url='https://example.com';
    for(const sender of [contents,null])assert.equal(check(sender,'fileSystem','director://app'),false);
    assert.equal(requested(contents,'fileSystem','director://app/'),false);
    url='director://app/';destroyed=true;
    for(const sender of [contents,null])assert.equal(check(sender,'fileSystem','director://app'),false);
    assert.equal(requested(contents,'fileSystem','director://app/'),false);
});
