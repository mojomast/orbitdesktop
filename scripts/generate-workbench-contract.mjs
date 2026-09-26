import fs from 'node:fs';
import {workbenchSchema,workbenchTypes} from '../contracts/workbench-v1.mjs';
import {contextSchema} from '../server/workbench-context.mjs';
import {executionSchema} from '../server/workbench-execution.mjs';
import {nativeSchema,nativeToolRequests} from '../contracts/workbench-native-v1.mjs';
import {environmentSchema} from '../server/workbench-environments.mjs';
import {workflowSchema} from '../server/workbench-workflow.mjs';
import {resultFrameSchema,resultReceiptSchema,workbenchProvenanceSchema,patchRequestSchema} from '../contracts/workbench-result-v1.mjs';
for(const [name,content] of [['contracts/workbench-v1.json',JSON.stringify(workbenchSchema,null,2)+'\n'],['src/workbench-contract.generated.ts',workbenchTypes],['contracts/workbench-context-v1.json',JSON.stringify(contextSchema,null,2)+'\n'],['contracts/workbench-execution-v1.json',JSON.stringify(executionSchema,null,2)+'\n']]) {
  if(process.argv.includes('--check')) {if(!fs.existsSync(name)||fs.readFileSync(name,'utf8')!==content)throw Error(`Stale generated artifact: ${name}`);}
  else fs.writeFileSync(name,content);
}
{
  const properties={};for(const schema of Object.values(nativeToolRequests))for(const [key,value] of Object.entries(schema.properties))if(key!=='action')properties[key]=value;
  const parameters={type:'object',properties:{action:{type:'string',enum:Object.keys(nativeToolRequests)},...properties},required:['action'],additionalProperties:false};
  const file='hermes-plugin/workbench-tool-schema.json',content=JSON.stringify(parameters,null,2)+'\n';
  if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content)throw Error(`Stale generated artifact: ${file}`);}else fs.writeFileSync(file,content);
}
for(const [name,schema] of Object.entries({'workbench-native-v1':nativeSchema,'workbench-native-tools-v1':nativeToolRequests,'workbench-environments-v1':environmentSchema,'workbench-workflow-v1':workflowSchema,'workbench-result-frame-v1':resultFrameSchema,'workbench-result-receipt-v1':resultReceiptSchema,'workbench-provenance-v1':workbenchProvenanceSchema,'workbench-patch-v1':patchRequestSchema})){
  const file=`contracts/${name}.json`,content=JSON.stringify(schema,null,2)+'\n';
  if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content)throw Error(`Stale generated artifact: ${file}`);}else fs.writeFileSync(file,content);
}
