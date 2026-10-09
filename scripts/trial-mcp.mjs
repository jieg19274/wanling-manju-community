import path from 'node:path';
import {spawn} from 'node:child_process';
import {trialEnv} from './trial-env.mjs';
import {ensureAgentService} from './agent-service.mjs';
const root=path.resolve(import.meta.dirname,'..');
await ensureAgentService(root);
const child=spawn(process.execPath,[path.join(root,'dist-server/server/mcp.js')],{cwd:root,env:trialEnv(root),windowsHide:true,stdio:'inherit'});
child.once('exit',code=>{process.exitCode=code??1;});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill());
