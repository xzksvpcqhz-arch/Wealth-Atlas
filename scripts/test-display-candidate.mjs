// Packaged runtime checks, fresh synthetic QA profile, outbound network denied.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage, extractFile } from '@electron/asar';
import { DISPLAY_CANDIDATE_VERSION, assertDisplayCandidatePath } from './build-display-candidate.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.resolve(process.argv[2]??'');
const relative=path.relative(path.join(root,'desktop-dist/display-candidates'),destination);
assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Only a generated display candidate is accepted');
const directoryInfo=await lstat(destination);assert.ok(directoryInfo.isDirectory()&&!directoryInfo.isSymbolicLink(),'Candidate directory must be ordinary');
async function ordinary(file,maxBytes=400_000_000){const info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size>0&&info.size<=maxBytes,'Candidate file must be ordinary and bounded');}
const reportPath=path.join(destination,'candidate-check.json');await ordinary(reportPath,100_000);
const report=JSON.parse(await readFile(reportPath,'utf8'));
assert.equal(report.version,DISPLAY_CANDIDATE_VERSION);assert.equal(report.profileVersion,DISPLAY_CANDIDATE_VERSION);
assert.equal(report.githubPublished,false);assert.equal(report.distributionReady,false);assert.equal(report.autoUpdatesEnabled,false);
assert.equal(report.candidatePurpose,'display-preferences-acceptance');assert.equal(report.cloudConfigured,true);
const appDir=path.join(destination,'windows/win-unpacked'),exe=path.join(appDir,'Wealth Atlas Display Candidate.exe');
const asar=path.join(appDir,'resources/app.asar');
await ordinary(asar);await ordinary(exe);
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const originalAsar=await digest(asar),originalExe=await digest(exe);
assert.equal(originalAsar,report.hashes['windows/win-unpacked/resources/app.asar']);
assert.equal(originalExe,report.hashes['windows/win-unpacked/Wealth Atlas Display Candidate.exe']);
for(const name of listPackage(asar))assertDisplayCandidatePath(name.replace(/^[\\/]+/,''));
const pkg=JSON.parse(extractFile(asar,'package.json').toString('utf8'));
assert.equal(pkg.version,DISPLAY_CANDIDATE_VERSION);assert.equal(pkg.wealthAtlasCandidateProfileVersion,DISPLAY_CANDIDATE_VERSION);
assert.equal(pkg.main,'desktop/candidate-bootstrap.cjs');assert.equal(pkg.wealthAtlasCandidate,'cloud-sync-test');
assert.equal(pkg.wealthAtlasCandidateVisibilityProbeId,undefined,'Old diagnostic probes are not enabled');
const output=path.join(destination,'local-runtime-check.json');
await assert.rejects(access(output),{code:'ENOENT'},'Keep previous verification evidence intact');
const qaSession=randomUUID();
const qaRoot=path.join(process.env.APPDATA,'Wealth Atlas Sync Candidate',DISPLAY_CANDIDATE_VERSION,'isolated-qa',qaSession);
await assert.rejects(access(qaRoot),{code:'ENOENT'},'Never inspect an already-used profile');
const proxy=net.createServer(socket=>socket.destroy());
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
const port=proxy.address().port;
const env={};for(const name of ['SystemRoot','SystemDrive','WINDIR','COMSPEC','ComSpec','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[name])env[name]=process.env[name];
const phases=['empty','startup-diagnostics','asset-audit','layout','seed','verify','edit','verify-edit','soft-delete','verify-soft-delete','restore','verify-restore','account-isolation'];
const passed=[];
try{
  for(const phase of phases){
    await new Promise((resolve,reject)=>{
      const child=spawn(exe,[`--candidate-qa-session=${qaSession}`,`--desktop-smoke=${phase}`,`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>',
        '--disable-gpu','--disable-gpu-compositing','--disable-software-rasterizer','--in-process-gpu','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows'],
        {cwd:appDir,env:{...env,WEALTH_ATLAS_DESKTOP_SMOKE:phase},windowsHide:true,stdio:['ignore','pipe','pipe']});
      let text='';const collect=chunk=>{text=(text+chunk.toString()).slice(-120_000);};
      child.stdout.on('data',collect);child.stderr.on('data',collect);
      const timer=setTimeout(()=>{child.kill();reject(new Error(`Isolated runtime phase timed out: ${phase}`));},45_000);
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not launch packaged QA runtime'));});
      child.once('close',code=>{clearTimeout(timer);const results=text.split(/\r?\n/).filter(line=>line.startsWith('WEALTH_ATLAS_SMOKE ')).map(line=>{try{return JSON.parse(line.slice(19));}catch{return null;}});
        if(code===0&&results.some(value=>value?.pass===true&&value.mode===phase))resolve();else reject(new Error(`Packaged runtime phase failed: ${phase}`));});
    });
    passed.push(phase);console.log(`DISPLAY_PACKAGED_PASS ${phase}`);
  }
  const meta=JSON.parse(await readFile(path.join(qaRoot,'logs/startup.json'),'utf8'));
  assert.equal(meta.appVersion,DISPLAY_CANDIDATE_VERSION);
  assert.equal(meta.mode,'desktop-production');
  assert.equal(await digest(asar),originalAsar);assert.equal(await digest(exe),originalExe);
  const profileInfo=await lstat(qaRoot);assert.ok(profileInfo.isDirectory()&&!profileInfo.isSymbolicLink());
  await writeFile(output,JSON.stringify({status:'PASS',version:DISPLAY_CANDIDATE_VERSION,signature:'UNSIGNED',
    packagedRuntimeVerified:true,installedIntoUserProfile:false,syntheticOnly:true,hostedTwoDeviceVerified:false,macRuntimeVerified:false,
    qaSession,network:'process-local deny proxy',phases:passed,asarSha256:originalAsar,exeSha256:originalExe},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'PASS',version:DISPLAY_CANDIDATE_VERSION,checks:passed.length,report:output,installed:false,hostedTwoDeviceVerified:false}));
}finally{await new Promise(resolve=>proxy.close(resolve));}
