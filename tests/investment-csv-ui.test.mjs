import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
test('broker CSV production UI: templates, protected import, failures, keyboard and four widths',{timeout:100000},async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const profile=path.join(os.tmpdir(),'wa-investment-csv-ui-qa-'+randomUUID());
 const executable=path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
 const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','PATH','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(executable,['--disable-gpu',path.join(root,'scripts/investment-csv-ui-test.cjs'),'--qa-profile='+profile],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';const capture=buffer=>output=(output+buffer.toString()).slice(-18000);child.stdout.on('data',capture);child.stderr.on('data',capture);
  const timer=setTimeout(()=>{child.kill();reject(Error('Synthetic CSV UI timeout'));},85000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('Synthetic CSV UI could not start'));});
  child.once('close',code=>{clearTimeout(timer);const match=output.match(/INVESTMENT_CSV_UI_PASS (\{[^\r\n]+\})/);if(code!==0||!match){const failed=output.match(/INVESTMENT_CSV_UI_FAIL (\{[^\r\n]+\})/);reject(Error('Synthetic CSV UI failed: '+(failed?.[1]??'no fixed report')));}else resolve(JSON.parse(match[1]));});
 });
 assert.equal(result.realBackendRequests,0);assert.equal(result.productionDataAccessed,false);assert.equal(result.sizes.length,4);assert.ok(result.checks.length>=10);console.log('INVESTMENT_CSV_UI_PASS '+JSON.stringify(result));
});
