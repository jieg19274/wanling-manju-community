import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// These public, fixed resources travel inside dist-server so existing signed
// update clients can receive them without expanding their writable boundary.
export function buildBundledResources(root=path.resolve(import.meta.dirname,'..')){
  const release=JSON.parse(fs.readFileSync(path.join(root,'release.json'),'utf8'));
  const resources=[
    ['agent/wanling-manju/SKILL.md','wanling-manju/SKILL.md'],
    ['agent/wanling-manju/scripts/run.mjs','wanling-manju/scripts/run.mjs'],
    ['docs/新手制作全流程.md','tutorials/getting-started.md'],
    ['docs/试用版演示教程.md','tutorials/demo.md'],
    ['docs/万灵漫剧宣传教程.md','tutorials/production.md'],
    ['docs/Agent接入说明.md','tutorials/agent.md'],
    ['docs/新手制作全流程.md','wanling-manju/references/workflow-guide.md'],
    ['catalog/effect-library-source.json','catalog/effect-library-source.json'],
    ['catalog/effect-library-frame-local.json','catalog/effect-library-frame-local.json'],
    ['catalog/effect-library-adaptations.json','catalog/effect-library-adaptations.json'],
  ];
  for(const [source,relative] of resources){
    const target=path.join(root,'dist-server','bundled',relative);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(root,source),target);
  }
  fs.writeFileSync(path.join(root,'dist-server/bundled/version.json'),JSON.stringify({version:release.version,resources:resources.map(([,file])=>file)},null,2));
  return {version:release.version,files:resources.length+1};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildBundledResources()));
