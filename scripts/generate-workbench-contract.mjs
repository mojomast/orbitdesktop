import fs from 'node:fs';
import {workbenchSchema,workbenchTypes} from '../contracts/workbench-v1.mjs';
import {contextSchema} from '../server/workbench-context.mjs';
import {executionSchema} from '../server/workbench-execution.mjs';
for(const [name,content] of [['contracts/workbench-v1.json',JSON.stringify(workbenchSchema,null,2)+'\n'],['src/workbench-contract.generated.ts',workbenchTypes],['contracts/workbench-context-v1.json',JSON.stringify(contextSchema,null,2)+'\n'],['contracts/workbench-execution-v1.json',JSON.stringify(executionSchema,null,2)+'\n']]) {
  if(process.argv.includes('--check')) {if(!fs.existsSync(name)||fs.readFileSync(name,'utf8')!==content)throw Error(`Stale generated artifact: ${name}`);}
  else fs.writeFileSync(name,content);
}
