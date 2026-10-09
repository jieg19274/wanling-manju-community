import test from 'node:test';import assert from 'node:assert/strict';import {compatibleAssetRecoveryInput} from '../dist-server/server/asset-recovery-input.js';
test('paid asset response recovery tolerates only additive library changes and never changed authoritative inputs',()=>{
 const a={kind:'character',name:'actor',identity:'original',states:['standing']},s={task:'asset-extract',projectId:'p',model:'m',beats:[{event:'original'}],existingAssets:[a]},c={...s,existingAssets:[a,{kind:'prop',name:'new paper',identity:'paper',states:[]}]};
 assert.equal(compatibleAssetRecoveryInput(s,c),true);
 for(const changed of [{...c,model:'other'},{...c,projectId:'other'},{...c,beats:[{event:'changed'}]},{...c,existingAssets:[]},{...c,existingAssets:[{...a,identity:'changed'}]},{...c,existingAssets:[{...a,states:['kneeling']}]},{...c,existingAssets:[a,a]}])assert.equal(compatibleAssetRecoveryInput(s,changed),false);
 assert.equal(compatibleAssetRecoveryInput({...s,existingAssets:[a,a]},c),false);
});
