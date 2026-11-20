import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('local account investment UI: actual components, real isolated persistence and four widths',{timeout:45000},async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),executable=path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
 const env={};for(const k of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','PATH','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR'])if(process.env[k]!==undefined)env[k]=process.env[k];
 const output=await new Promise((resolve,reject)=>{const child=spawn(executable,['--disable-gpu',path.join(root,'scripts/local-investment-ui-test.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const capture=b=>text=(text+b.toString()).slice(-15000);child.stdout.on('data',capture);child.stderr.on('data',capture);const timer=setTimeout(()=>{child.kill();reject(Error('Isolated UI timeout'));},40000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(code)reject(Error(text.slice(-5000)));else resolve(text);});});
 const match=output.match(/LOCAL_INVESTMENT_UI_PASS (\{[^\r\n]+\})/);assert.ok(match,'UI check marker');const report=JSON.parse(match[1]);assert.equal(report.realBackendRequests,0);assert.equal(report.productionDataAccessed,false);assert.equal(report.sizes.length,4);console.log('LOCAL_INVESTMENT_UI_PASS '+JSON.stringify(report));
});
