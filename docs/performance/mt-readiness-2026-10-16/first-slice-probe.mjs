// Reproduce the original failing in-process host: settings warmup, MT load, first cube slice.
// Each invocation gets a fresh process, module instance, heap and default-sized pthread pool.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import os from 'node:os';
if (!process.execArgv.includes('--disallow-code-generation-from-strings')) {
  const child = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio:'inherit', env:{...process.env,ENGINE_TEST_NO_EVAL:'1',ENGINE_TEST_REQUIRE:'1'},
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const OriginalWorker = workerThreads.Worker;
let workers = 0;
workerThreads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args);
    workers++;
    this.on('error', error => console.error('MT_WORKER_ERROR', { threadId:this.threadId,stack:error.stack,freeMemory:os.freemem(),parentMemory:process.memoryUsage() }));
  }
};
syncBuiltinESMExports();
process.on('uncaughtExceptionMonitor', error => console.error('MT_PARENT_ERROR', error.stack));
const root = path.resolve(process.argv[2]);
process.env.ENGINE_VARIANT = 'mt';
const fromRoot = name => import(pathToFileURL(path.join(root,name)));
const { TARGETS } = await fromRoot('test/conformance/targets.ts');
const { SettingsClient } = await fromRoot('packages/protocol/src/connection.ts');
const { m1Presets, cube } = await fromRoot('test/fixtures.ts');
const host = await TARGETS.find(t=>t.name==='in-process').connect();
const presets = await m1Presets();
const refs = { machine:presets.machine,process:presets.process,filament:presets.filaments[0] };
const client = new SettingsClient(host.connection);
await host.connection.open({name:'mt-first-slice-probe',version:'1'});
await client.view({scope:'process',presets:refs});
await client.edit({scope:'process',presets:refs,edit:{set:'layer_height',value:'0'},view:true});
const views = [{scope:'process',env:{mode:'expert'}},{scope:'filament',env:{mode:'advanced'}},{scope:'machine',env:{mode:'expert'}},{scope:'object',object:{wall_loops:'3',layer_height:'0.12'}}];
for (let i=0;i<240;i++) await client.view({...views[i%4],presets:refs,overrides:{process:{wall_loops:String(1+i%5)}},version:i});
assert.equal((await host.connection.request('status',{})).state,'idle');
await host.connection.request('load',{variant:'mt'});
const progress = [];
const params = {configs:presets,objects:[{name:'Cube.stl',mesh:{positions:cube([100,90])}}]};
const result = await host.connection.request('slice',params,{onProgress:p=>progress.push(p)});
assert.equal(result.stats.layers,100);
assert.equal(result.toolpaths.format,1);
assert.ok(result.toolpaths.roles.some(r=>r.name==='Outer wall' && r.lengthMm>0));
assert.ok(result.toolpathExtras && result.toolpathExtras.feedrate.length===result.toolpaths.extrusions.count);
assert.ok(progress.length>0);
for(let i=1;i<progress.length;i++) assert.ok(progress[i].percent>=progress[i-1].percent);
const bare = await host.connection.request('slice',{...params,output:{toolpaths:false}});
assert.equal(bare.toolpaths,null);
await host.close();
process.stdout.write(JSON.stringify({root,variant:'mt',noEval:true,settingsViews:241,settingsEdits:1,slices:2,layers:result.stats.layers,progress:progress.length,workers,freeMemory:os.freemem(),memory:process.memoryUsage()})+'\n',()=>process.exit(0));
