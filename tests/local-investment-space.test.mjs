import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
test('local investment space: real isolated IndexedDB, concurrency, quota rollback, account fencing and process restart',{timeout:90000},async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const profile=path.join(os.tmpdir(),'wa-investment-local-qa-'+randomUUID());
 const executable=path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
 const env={};for(const k of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','PATH','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR'])if(process.env[k]!==undefined)env[k]=process.env[k];
 for(const restart of [false,true]){
  const report=await new Promise((resolve,reject)=>{
   const child=spawn(executable,['--disable-gpu',path.join(root,'scripts/local-investment-space-test.cjs'),'--qa-profile='+profile,...(restart?['--verify-restart']:[])],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
   let output='';const capture=b=>output=(output+b.toString()).slice(-10000);child.stdout.on('data',capture);child.stderr.on('data',capture);
   const timer=setTimeout(()=>{child.kill();reject(Error('Synthetic investment test timeout'));},40000);
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);const match=output.match(/LOCAL_INVESTMENT_PASS (\{[^\r\n]+\})/);if(code!==0||!match)reject(Error(output.slice(-3000)||'Isolated investment fixture failed'));else resolve(JSON.parse(match[1]));});
  });
  assert.equal(report.realBackendRequests,0);assert.equal(report.productionDataAccessed,false);assert.ok(report.checks.length>0);console.log('LOCAL_INVESTMENT_PASS '+JSON.stringify(report));
 }
});
