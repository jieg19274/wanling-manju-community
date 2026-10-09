import path from 'node:path';
import {checkForUpdate,updateStatus} from './auto-update.mjs';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
console.log(JSON.stringify(process.argv.includes('--check')?await checkForUpdate(root,{force:process.argv.includes('--force')}):updateStatus(root),null,2));
