import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {generateKeyPairSync,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {appPath,canonical,hash,compareVersions,UPDATE_SCRIPTS} from './auto-update.mjs';

export function publishUpdate({source,channelDirectory,keyFile,version,notes='软件改进与问题修复',publicUrl}){
  source=fs.realpathSync(source);compareVersions(version,'0.0.0');
  channelDirectory=path.resolve(channelDirectory);keyFile=path.resolve(keyFile);
  if(keyFile.startsWith(channelDirectory+path.sep)||channelDirectory===source)throw Error('签名私钥和更新发布目录必须分开');
  if(publicUrl){const u=new URL(publicUrl);if(u.protocol!=='https:'||u.username||u.password||!u.pathname.endsWith('/update.json'))throw Error('联网更新地址必须是 HTTPS update.json');}
  fs.mkdirSync(path.dirname(keyFile),{recursive:true});
  if(!fs.existsSync(keyFile)){const {privateKey}=generateKeyPairSync('ed25519');fs.writeFileSync(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});}
  const privateKey=createPrivateKey(fs.readFileSync(keyFile)),publicKey=createPublicKey(privateKey).export({type:'spki',format:'pem'});
  const release=path.join(channelDirectory,'releases',version);
  if(fs.existsSync(release))throw Error('该版本已发布；修改代码后请使用新的版本号');
  fs.mkdirSync(path.dirname(release),{recursive:true});fs.mkdirSync(release);
  const temporary=release;fs.mkdirSync(path.join(temporary,'files'));
  const candidates=[];
  function scan(directory){
    for(const entry of fs.readdirSync(path.join(source,directory),{withFileTypes:true})){
      if(entry.isSymbolicLink())throw Error('更新包不能包含符号链接');
      const relative=directory+'/'+entry.name;
      if(entry.isDirectory())scan(relative);else if(entry.isFile())candidates.push(relative);
    }
  }
  for(const folder of ['dist','dist-server','adapters'])scan(folder);
  for(const file of UPDATE_SCRIPTS)if(fs.existsSync(path.join(source,'scripts',file)))candidates.push('scripts/'+file);
  candidates.push('release.json');
  const storageSchema=JSON.parse(fs.readFileSync(path.join(source,'release.json'),'utf8')).storageSchema??6;
  const files=[];
  for(const relative of candidates.sort()){
    if(['adapters/remaining-budget.mjs','adapters/tutorial-budget.mjs'].includes(relative))continue;
    appPath(source,relative);
    let bytes=relative==='release.json'?Buffer.from(JSON.stringify({version,updateProtocol:1,storageSchema},null,2)):fs.readFileSync(path.join(source,relative));
    // Updates retain the public package boundary; producer-only exceptional grants never ship.
    if(relative==='dist-server/server/unknown-retry.js')bytes=Buffer.from('export function approvedUnknownRetry(){return false;}\nexport function approvedAudioTrial(){return false;}\n');
    if(relative==='adapters/batch-budget.mjs')bytes=Buffer.from('export function openBudget(task,profilePath=process.env.MANJU_BATCH_BUDGET_PROFILE){if(profilePath)throw new Error("Public release does not accept production batch grants");return undefined;}\n');
    if(/\.(?:js|mjs|json|html)$/i.test(relative)&&/Sentinel_[0-9a-f]{20,}|PRODUCER_PRIVATE_IDENTIFIER/.test(bytes.toString('utf8')))throw Error('更新文件包含制作人专用授权信息：'+relative);
    const target=path.join(temporary,'files',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    files.push({path:relative,size:bytes.length,sha256:hash(bytes)});
  }
  const sharpVersion=JSON.parse(fs.readFileSync(path.join(source,'node_modules/sharp/package.json'),'utf8')).version;
  const manifest={product:'wanling-manju',protocol:1,version,platform:process.platform,arch:process.arch,minNodeMajor:24,sharpVersion,storageSchema,publishedAt:new Date().toISOString(),notes:String(notes).slice(0,4000),basePath:`releases/${version}/files/`,files};
  if(files.length>1000||files.reduce((n,f)=>n+f.size,0)>256*1024*1024||files.some(f=>f.size>32*1024*1024))throw Error('发布包超过自动更新限制，请改用完整安装包');
  const envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),privateKey).toString('base64')};
  fs.writeFileSync(path.join(temporary,'release-manifest.json'),JSON.stringify(envelope,null,2));
  // Advertise the release only after every payload and its signed manifest exist.
  // Avoid directory renames: Windows scanners may hold newly created files open.
  fs.mkdirSync(channelDirectory,{recursive:true});
  const feed=path.join(channelDirectory,'update.json'),staged=feed+'.tmp';fs.writeFileSync(staged,JSON.stringify(envelope,null,2));fs.renameSync(staged,feed);
  const client={manifestUrl:publicUrl||pathToFileURL(feed).href,publicKey,enabled:true};
  fs.writeFileSync(path.join(channelDirectory,'update-channel.json'),JSON.stringify(client,null,2));
  return {version,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0),feed,client};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const source=path.resolve(value('--source')||'.'),version=value('--version')||JSON.parse(fs.readFileSync(path.join(source,'release.json'),'utf8')).version;
  const defaultProfile=path.join(source,'update-channel.template.json');
  const defaultUrl=fs.existsSync(defaultProfile)?JSON.parse(fs.readFileSync(defaultProfile,'utf8')).manifestUrl:undefined;
  const result=publishUpdate({source,channelDirectory:value('--channel')||path.join(source,'deliverables/update-channel'),keyFile:value('--key')||path.join(source,'.release-keys/update-private.pem'),version,notes:value('--notes'),publicUrl:value('--public-url')||(defaultUrl?.startsWith('https:')?defaultUrl:undefined)});
  const target=value('--configure');
  if(target){const install=fs.realpathSync(target);if(!fs.existsSync(path.join(install,'dist-server/server/index.js')))throw Error('要配置的目录不是万灵漫剧安装目录');fs.writeFileSync(path.join(install,'update-channel.json'),JSON.stringify(result.client,null,2));}
  console.log(JSON.stringify({version:result.version,files:result.files,bytes:result.bytes,manifest:result.feed,configuredInstallation:target||null},null,2));
}
