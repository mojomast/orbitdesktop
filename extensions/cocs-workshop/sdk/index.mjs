import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
export function indexSource(repo,ref='feat/fieldwork-plan'){
 const commit=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),modules=[];
 for(const name of fs.readdirSync(path.join(repo,'game')).filter(n=>/^(cocs|lattice|objectives|core|protocol|config|mode-data|net|bots).*\.mjs$/.test(n)&&!n.includes('.test.'))){
 const text=fs.readFileSync(path.join(repo,'game',name),'utf8'),lines=text.split('\n'),exports=[];
 lines.forEach((line,i)=>{const m=line.match(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/);if(m)exports.push({name:m[1],line:i+1});});
 const imports=[...text.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(m=>'game/'+m[1]);
 modules.push({path:'game/'+name,imports,exports,source:text,url:`https://github.com/mojomast/cocs/blob/${commit}/game/${name}`});
 }return {schema:'cocs.source-index/v1',commit,branch:ref,modules};
}
if(process.argv[1]===new URL(import.meta.url).pathname){const [repo,out]=process.argv.slice(2);if(!out)throw Error('Usage: node index.mjs REPO OUTPUT');fs.writeFileSync(out,JSON.stringify(indexSource(repo)));}
