import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import { includePackageContact } from './package-contact.mjs';
import { BUILTIN_MODEL_IDS } from '../dist-server/server/default-models.js';
const noVendor=process.argv.includes('--no-vendor');
const nativeCanvas=process.argv.includes('--canvas');
const portable=process.argv.includes('--portable');
const community=process.argv.includes('--community');
if(community&&!noVendor)throw Error('Community installer obtains native dependencies from upstream on first launch');
const releaseVersion=JSON.parse(fs.readFileSync('release.json','utf8')).version;
const sampleManifest=JSON.parse(fs.readFileSync('examples/promo-demo/manifest.json','utf8'));
if(sampleManifest.version!==1||sampleManifest.files.length!==5)throw Error('Verified public demo is required');
if(portable&&noVendor)throw Error('Portable package requires local dependencies');
const prefix=community?'wanling-manju-community-candidate-':portable?'wanling-manju-portable-candidate-':noVendor?'wanling-manju-install-trial-':nativeCanvas?'wanling-manju-':'manju-clean-candidate-';
const target=path.resolve('deliverables',prefix+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(target,{recursive:true});
includePackageContact(target);
fs.copyFileSync('LICENSE',path.join(target,'LICENSE'));
fs.copyFileSync('NOTICE',path.join(target,'NOTICE'));
fs.copyFileSync('THIRD_PARTY_NOTICES.md',path.join(target,'THIRD_PARTY_NOTICES.md'));
fs.copyFileSync('release.json',path.join(target,'release.json'));
fs.copyFileSync('update-channel.template.json',path.join(target,'update-channel.json'));
fs.copyFileSync('docs/自动更新使用与发布说明.txt',path.join(target,'自动更新使用与发布说明.txt'));
fs.mkdirSync(path.join(target,'dist'));fs.copyFileSync('dist/index.html',path.join(target,'dist/index.html'));fs.cpSync('dist/assets',path.join(target,'dist/assets'),{recursive:true});
for(const file of ['wanling-icon.png','wanling.ico'])fs.copyFileSync(path.join('dist',file),path.join(target,'dist',file));
if(portable)fs.cpSync('portable-tools',path.join(target,'tools'),{recursive:true});
fs.cpSync('dist/style-thumbs',path.join(target,'dist/style-thumbs'),{recursive:true});
fs.cpSync('dist-server',path.join(target,'dist-server'),{recursive:true});
fs.cpSync('extensions/universal-upscaler',path.join(target,'extensions/universal-upscaler'),{recursive:true});
fs.cpSync('examples/promo-demo',path.join(target,'examples/promo-demo'),{recursive:true});
fs.writeFileSync(path.join(target,'dist-server/server/unknown-retry.js'),'// Clean trial does not accept another producer\'s exceptional batch grants.\nexport function approvedUnknownRetry(){return false;}\nexport function approvedAudioTrial(){return false;}\n');
fs.mkdirSync(path.join(target,'adapters'));for(const item of fs.readdirSync('adapters'))if(!['batch-budget.mjs','remaining-budget.mjs','tutorial-budget.mjs'].includes(item))fs.copyFileSync(path.join('adapters',item),path.join(target,'adapters',item));
fs.writeFileSync(path.join(target,'adapters/batch-budget.mjs'),'export function openBudget(task,profilePath=process.env.MANJU_BATCH_BUDGET_PROFILE){if(profilePath)throw new Error("Clean trial does not accept production batch credentials or grants");return undefined;}\n');
fs.mkdirSync(path.join(target,'catalog'));for(const file of['effect-library-source.json','effect-library-frame-local.json','effect-library-frame-adaptations.json','effect-library-adaptations.json','PROVENANCE.md'])fs.copyFileSync(path.join('catalog',file),path.join(target,'catalog',file));
fs.writeFileSync(path.join(target,'catalog/README.md'),'已包含用户确认由本人 AI 生成的风格预览和项目助理编写的特效描述，允许提供给软件用户使用。来源及授权说明见 PROVENANCE.md。\n');
fs.mkdirSync(path.join(target,'scripts'));fs.copyFileSync('scripts/trial-start.mjs',path.join(target,'scripts/trial-start.mjs'));
for(const file of ['trial-env.mjs','network-env.mjs','prepare-upscale.mjs','extract-upscale.ps1','diagnose-login-version.ps1','trial-mcp.mjs','make-trial-shortcut.ps1','storage-maintenance.mjs','agent-service.mjs','agent-cli.mjs','agent-mcp.mjs','install-agent.mjs','auto-update.mjs','update-cli.mjs','check-studio-active.cjs'])fs.copyFileSync(path.join('scripts',file),path.join(target,'scripts',file));
fs.copyFileSync('检查木木登录版本.cmd',path.join(target,'检查木木登录版本.cmd'));
fs.cpSync('agent/wanling-manju',path.join(target,'agent/wanling-manju'),{recursive:true});
fs.copyFileSync('AGENT_START.md',path.join(target,'AGENT_START.md'));
fs.mkdirSync(path.join(target,'agent-exports'));
fs.writeFileSync(path.join(target,'agent-exports','README.md'),'# Agent 接入文件\n\n解压并准备运行环境后，双击“导出Agent接管技能.cmd”。该命令按当前安装目录生成 Codex、WorkBuddy、TRAE 技能 ZIP 和 MCP 配置，再从对应客户端子目录导入。软件移动后重新导出，以更新安装路径。\n');
const agentNode=portable||community?'"%~dp0tools\\node\\node.exe"':'node';
fs.writeFileSync(path.join(target,'安装Codex接管技能.cmd'),'@echo off\r\nchcp 65001 >nul\r\n'+agentNode+' "%~dp0scripts\\install-agent.mjs" codex\r\npause\r\n');
fs.writeFileSync(path.join(target,'导出Agent接管技能.cmd'),'@echo off\r\nchcp 65001 >nul\r\n'+['codex','workbuddy','trae'].map(client=>agentNode+' "%~dp0scripts\\install-agent.mjs" '+client+' "%~dp0agent-exports\\'+client+'"\r\nif errorlevel 1 exit /b 1\r\n').join('')+'echo 已按当前安装目录生成技能 ZIP 与 MCP 配置，见 agent-exports 内的各客户端目录。\r\npause\r\n');
fs.writeFileSync(path.join(target,'创建桌面快捷方式.cmd'),'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\make-trial-shortcut.ps1"\r\npause\r\n');
function include(name){const source=path.resolve('node_modules',name);if(!fs.existsSync(source))throw Error('Missing dependency '+name);if(fs.existsSync(path.join(target,'node_modules',name)))return;const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));fs.cpSync(source,path.join(target,'node_modules',name),{recursive:true});for(const n of Object.keys(pkg.dependencies||{}))include(n);for(const n of Object.keys(pkg.optionalDependencies||{}))if(fs.existsSync(path.resolve('node_modules',n)))include(n);}
if(!noVendor){include('sharp');include('@img/sharp-win32-x64');}
fs.mkdirSync(path.join(target,'third-party'));
fs.cpSync('third-party/infinite-canvas',path.join(target,'third-party/infinite-canvas'),{recursive:true});
fs.cpSync('third-party/local-mini-drama',path.join(target,'third-party/local-mini-drama'),{recursive:true});
for(const name of ['react','react-dom','scheduler'])fs.copyFileSync(path.join('node_modules',name,'LICENSE'),path.join(target,'third-party',name.toUpperCase()+'-LICENSE'));
fs.copyFileSync('docs/Agent接入说明.md',path.join(target,'Agent接入说明.md'));
fs.copyFileSync('docs/试用版演示教程.md',path.join(target,'从文字到成片教程.md'));
fs.copyFileSync('docs/新手制作全流程.md',path.join(target,'新手制作全流程.md'));
if(!noVendor)for(const file of fs.readdirSync('docs/third-party-release'))fs.copyFileSync(path.join('docs/third-party-release',file),path.join(target,'third-party',file));
fs.copyFileSync('node_modules/vite/LICENSE.md',path.join(target,'third-party/VITE-LICENSE.md'));
const packageJson={name:community?'wanling-manju-community':'manju-clean-local-trial',version:releaseVersion,license:'Apache-2.0',repository:'https://github.com/jieg19274/wanling-manju-community',private:true,type:'module',engines:{node:'>=24 <25'},scripts:{start:'node scripts/trial-start.mjs',mcp:'node scripts/agent-mcp.mjs',agent:'node scripts/agent-cli.mjs'},...(noVendor?{dependencies:{sharp:'0.35.5'}}:{})};
fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(packageJson,null,2));
if(noVendor){const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));lock.name=packageJson.name;lock.packages['']={name:packageJson.name,version:packageJson.version,dependencies:packageJson.dependencies,engines:packageJson.engines};for(const[k,v]of Object.entries(lock.packages))if(k&&v.dev)delete lock.packages[k];for(const[k,v]of Object.entries(lock.packages))if(v.resolved&&!v.resolved.startsWith('https://registry.npmjs.org/'))throw Error('Non-official registry '+k);fs.writeFileSync(path.join(target,'package-lock.json'),JSON.stringify(lock,null,2));fs.copyFileSync('docs/开发试用包安装说明.md',path.join(target,'安装与验收.md'));fs.writeFileSync(path.join(target,'third-party/DEPENDENCIES.md'),'No node_modules, native DLLs, sharp/libvips binaries, Node runtime, FFmpeg or Real-ESRGAN are distributed in this package. Users independently obtain locked dependencies from the official npm registry. Vite license notices are retained for generated frontend helpers. This is not a universal legal compliance certification.\n');}
fs.copyFileSync('docs/用户试用说明.md',path.join(target,'用户试用说明.md'));fs.writeFileSync(path.join(target,'启动试用.cmd'),'@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n'+(portable?'"%~dp0tools\\node\\node.exe"':'node')+' scripts\\trial-start.mjs\r\npause\r\n');
if(!noVendor)fs.appendFileSync(path.join(target,'用户试用说明.md'),'\n\n本免安装候选的第三方运行库分发材料尚未完成核验，不能作为此次外发包。请先阅读 third-party/DISTRIBUTION-STATUS.md。\n');
if(portable){fs.copyFileSync('docs/用户试用说明.md',path.join(target,'功能使用说明.md'));fs.copyFileSync('docs/免安装候选使用说明.md',path.join(target,'用户试用说明.md'));}
if(noVendor){fs.copyFileSync('docs/用户试用说明.md',path.join(target,'功能使用说明.md'));fs.copyFileSync('docs/开发试用包安装说明.md',path.join(target,'用户试用说明.md'));}
if(noVendor)fs.writeFileSync(path.join(target,'准备试用环境.cmd'),'@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (echo 请先安装 Node.js 24：https://nodejs.org/ & pause & exit /b 1)\r\nnode -e "if(Number(process.versions.node.split(\'.\')[0])!==24)process.exit(1)"\r\nif errorlevel 1 (echo 需要 Node.js 24。 & pause & exit /b 1)\r\ncall npm ci --omit=dev --include=optional --registry=https://registry.npmjs.org/\r\nif errorlevel 1 (echo 依赖安装失败，请按报错检查网络及权限。 & pause & exit /b 1)\r\nwhere ffmpeg >nul 2>nul\r\nif errorlevel 1 echo 视频制作与导出还需要 FFmpeg，安装步骤见安装与验收.md。\r\necho 准备完成，双击启动试用.cmd。\r\npause\r\n');
if(community){
 for(const file of ['community-runtime.json','verify-community-runtime.mjs','prepare-community-runtime.ps1','launch-community.ps1','make-community-shortcut.ps1'])fs.copyFileSync(path.join('scripts',file),path.join(target,'scripts',file));
 const launch='@echo off\r\nchcp 65001 >nul\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\launch-community.ps1"\r\n';
 for(const name of ['启动社区版.cmd','启动试用.cmd'])fs.writeFileSync(path.join(target,name),launch);
 fs.writeFileSync(path.join(target,'准备试用环境.cmd'),launch.trimEnd()+' -PrepareOnly\r\npause\r\n');
 const shortcut='@echo off\r\nchcp 65001 >nul\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\make-community-shortcut.ps1"\r\npause\r\n';
 for(const name of ['创建社区版快捷方式.cmd','创建桌面快捷方式.cmd'])fs.writeFileSync(path.join(target,name),shortcut);
 for(const name of ['安装与验收.md','用户试用说明.md'])fs.copyFileSync('docs/社区版安装说明.md',path.join(target,name));
}
const files=[];function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,item.name);if(item.isDirectory())walk(f);else{const relative=path.relative(target,f);if(/\.(js|mjs|json|md|html|cmd)$/i.test(f)&&/Sentinel_[0-9a-f]{20,}|PRODUCER_PRIVATE_IDENTIFIER|(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(f,'utf8')))throw Error('Production identifier/credential detected in '+relative);files.push({file:relative,sha256:createHash('sha256').update(fs.readFileSync(f)).digest('hex')});}}}walk(target);
if(files.some(f=>/\.db$|\.sqlite|\.log$|\.env$|direct-provider\.json|provider-account\.json|budget-profile|^runtime/i.test(f.file)))throw Error('Excluded private data present');
fs.writeFileSync(path.join(target,'package-manifest.json'),JSON.stringify({at:new Date().toISOString(),cleanCandidate:true,shareReady:false,packageKind:community?'Windows community app with verified upstream dependency preparation':noVendor?'dependency-install local trial':portable?'portable runtime candidate':'bundled-native candidate',license:'Apache-2.0',community,sourceRepository:'https://github.com/jieg19274/wanling-manju-community',demoIncluded:true,demoProjectId:'a5bc6fb8-75ae-47f8-837c-d3f46396b3bb',defaultModels:BUILTIN_MODEL_IDS,demoGenerationModels:sampleManifest.models,bundledNativeDependencies:!noVendor,bundledRuntime:portable,userAssetsAuthorized:true,userAssetAuthorizationDate:'2026-10-01',releaseBlocker:noVendor?'independent installation and UI checks pending':'native dependency corresponding-source/distribution materials require final verification',excluded:['producer credentials and grants','private projects and account data',...(noVendor?['node_modules','all third-party binaries']:[])],licenseDeclaration:'Third-party components retain their licenses; not a complete rights certification',files},null,2));console.log(target);
