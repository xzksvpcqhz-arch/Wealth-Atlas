// Local-only DIY acceptance packages. Never installs, signs in, tags or publishes.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { listPackage, extractFile } from '@electron/asar';
import { publicProbeConfig } from './check-cloud-permissions.mjs';

export const DISPLAY_CANDIDATE_VERSION = '1.7.7-rc.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /(^|\/)(?:\.env[^/]*|data|exports|private-vault|backups|outputs|review|certificates|userprofiles|realfinance|vaults?)(?:\/|$)|\.(?:pfx|p12|pem|key|xlsx|csv|zip)$|update-token\.json$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
export function assertDisplayCandidatePath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)
    || relative.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || forbidden.test(relative.replaceAll('\\', '/'))) {
    throw new Error('Unsafe candidate input refused before reading it.');
  }
}
export function displayCandidateEnvironment(environment) {
  if (environment.WEALTH_ATLAS_PUBLISH === '1' || environment.WEALTH_ATLAS_EMBED_TOKEN === '1') throw new Error('Candidate cannot publish or embed credentials.');
  const config = publicProbeConfig(environment);
  if (config.url.hostname !== 'jddkmphdilgjfftsoojl.supabase.co') throw new Error('Public configuration does not match the verified project; values suppressed.');
  const clean = {};
  for (const name of ['SystemRoot','SystemDrive','WINDIR','COMSPEC','ComSpec','PATHEXT','PATH','Path','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','OS']) {
    if (environment[name]) clean[name] = environment[name];
  }
  Object.assign(clean, { NEXT_TELEMETRY_DISABLED:'1', NPM_CONFIG_UPDATE_NOTIFIER:'false', CSC_IDENTITY_AUTO_DISCOVERY:'false',
    NEXT_PUBLIC_SUPABASE_URL:config.url.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY:config.key });
  if (environment.NEXT_PUBLIC_APP_URL?.trim()) {
    let address; try { address = new URL(environment.NEXT_PUBLIC_APP_URL.trim()); } catch { throw new Error('Invalid public redirect configuration; value suppressed.'); }
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('Invalid public redirect configuration; value suppressed.');
    clean.NEXT_PUBLIC_APP_URL = address.href;
  }
  return clean;
}
async function run(args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide:true, stdio:'inherit' });
    child.once('error', () => reject(new Error('Candidate tool could not start; no publication occurred.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Candidate build failed; previous files were preserved.')));
  });
}
async function archive(directory, target) {
  const zip = new JSZip();
  async function visit(folder, prefix='') {
    for (const item of await readdir(folder, { withFileTypes:true })) {
      const relative = path.posix.join(prefix,item.name); assertDisplayCandidatePath(relative);
      const file = path.join(folder,item.name), info = await lstat(file);
      if (info.isSymbolicLink() || info.nlink !== 1 && !info.isDirectory()) throw new Error('Archive refuses links or nonregular input.');
      if (info.isDirectory()) await visit(file,relative);
      else if (info.isFile()) zip.file(relative,await readFile(file),{unixPermissions:relative.endsWith('.command')?0o755:0o644});
      else throw new Error('Archive refuses nonregular input.');
    }
  }
  await visit(directory);
  await writeFile(target,await zip.generateAsync({type:'nodebuffer',platform:'UNIX',compression:'DEFLATE',compressionOptions:{level:3}}),{flag:'wx'});
}
export async function buildDisplayCandidate() {
  if (process.platform !== 'win32') throw new Error('Prepare Windows acceptance packages on Windows.');
  const env = displayCandidateEnvironment(process.env);
  // Only existence is checked. Never read or silently delete an old token file.
  try { await lstat(path.join(root,'desktop/update-token.json')); throw new Error('Legacy token file exists; it was not read.'); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  const id = randomUUID(), stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const scratch = path.join(path.dirname(root),'wealth-atlas-display-candidate-work',id);
  const source = path.join(scratch,'source'), appStage = path.join(scratch,'app');
  const destination = path.join(root,'desktop-dist','display-candidates',`v${DISPLAY_CANDIDATE_VERSION}-${stamp}-${id.slice(0,8)}`);
  const webStage = path.join(destination,'mac-web');
  const sourceHashes = {}, outputHashes = {};
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,env,encoding:'utf8'}).trim();
  const sourceHasUncommittedChanges = Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,env,encoding:'utf8'}).trim());
  const builderSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  const approvedPublic = new Set(execFileSync('git',['ls-files','-z','--','public'],{cwd:root,env}).toString('utf8').split('\0').filter(Boolean));
  if(execFileSync('git',['diff','HEAD','--name-only','--','public'],{cwd:root,env,encoding:'utf8'}).trim()) throw new Error('Public assets require review before candidate packaging.');
  await mkdir(source,{recursive:true}); await mkdir(destination,{recursive:true});
  async function copy(relative, target=path.join(source,relative)) {
    assertDisplayCandidatePath(relative);
    if(relative.startsWith('public/')&&!approvedPublic.has(relative)&&![...approvedPublic].some(file=>file.startsWith(relative+'/')))return;
    const from=path.join(root,relative),info=await lstat(from);
    if(info.isSymbolicLink())throw new Error('Source links refused.');
    if(info.isDirectory()) { await mkdir(target,{recursive:true});for(const item of await readdir(from))await copy(path.posix.join(relative,item),path.join(target,item)); }
    else if(info.isFile()&&info.nlink===1) {
      const bytes=await readFile(from);
      if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8')))throw new Error('Private key material refused; content suppressed.');
      sourceHashes[relative]=hash(bytes); await copyFile(from,target,1);
    } else throw new Error('Nonregular source refused.');
  }
  for(const folder of ['app','components','lib','public','desktop','build'])await copy(folder);
  for(const name of ['next.config.mjs','postcss.config.mjs','tsconfig.json','next-env.d.ts'])await copy(name);
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  sourceHashes['package.json']=hash(await readFile(path.join(root,'package.json')));
  await writeFile(path.join(source,'package.json'),JSON.stringify({...pkg,version:DISPLAY_CANDIDATE_VERSION},null,2)+'\n',{flag:'wx'});
  await symlink(path.join(root,'node_modules'),path.join(source,'node_modules'),'junction');
  const next=path.join(root,'node_modules/next/dist/bin/next');
  console.log(`Preparing unpublished ${DISPLAY_CANDIDATE_VERSION}; isolated profile, no installation or release.`);
  await run([next,'build'],source,{...env,WEALTH_ATLAS_DESKTOP_BUILD:'1',NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP:'1',WEALTH_ATLAS_WEB_EXPORT:'0'});
  await mkdir(appStage);
  async function copyGenerated(from,to,relative) {
    assertDisplayCandidatePath(relative); const info=await lstat(from);
    if(info.isSymbolicLink())throw new Error('Generated links refused.');
    if(info.isDirectory()){await mkdir(to,{recursive:true});for(const name of await readdir(from))await copyGenerated(path.join(from,name),path.join(to,name),path.posix.join(relative,name));}
    else if(info.isFile()&&info.nlink===1)await copyFile(from,to,1);else throw new Error('Nonregular generated input refused.');
  }
  for(const name of ['out','desktop','build'])await copyGenerated(path.join(source,name),path.join(appStage,name),name);
  await copy('scripts/candidate-bootstrap.cjs',path.join(appStage,'desktop/candidate-bootstrap.cjs'));
  const candidatePackage={name:'wealth-atlas-display-candidate',productName:'Wealth Atlas Display Candidate',version:DISPLAY_CANDIDATE_VERSION,
    description:'Unpublished display-preferences acceptance candidate',author:'Wealth Atlas',private:true,main:'desktop/candidate-bootstrap.cjs',
    wealthAtlasCandidate:'cloud-sync-test',wealthAtlasCandidateProfileVersion:DISPLAY_CANDIDATE_VERSION,dependencies:{}};
  await writeFile(path.join(appStage,'package.json'),JSON.stringify(candidatePackage,null,2)+'\n',{flag:'wx'});
  const electronVersion=JSON.parse(await readFile(path.join(root,'node_modules/electron/package.json'),'utf8')).version;
  const config={appId:'com.wealthatlas.display-candidate',productName:'Wealth Atlas Display Candidate',asar:true,npmRebuild:false,
    electronVersion,electronDist:path.join(root,'node_modules/electron/dist'),directories:{app:appStage,output:path.join(destination,'windows')},
    files:['out/**/*','desktop/*.cjs','desktop/auth-diagnostic-codes.json','build/icon.svg','package.json','!node_modules/**/*'],
    win:{target:'dir',icon:path.join(root,'build/icon.svg'),signExecutable:false},publish:null};
  const configPath=path.join(scratch,'builder.json');await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  const require=createRequire(import.meta.url),builderCli=require.resolve('electron-builder/cli.js');
  // Builder runs in a sanitized child process: no GH_TOKEN, signing secrets or
  // arbitrary inherited NEXT_PUBLIC_* values reach the staging build.
  await run([builderCli,'--win','dir','--x64','--publish','never','--config',configPath],root,env);
  const windowsApp=path.join(destination,'windows/win-unpacked'),asar=path.join(windowsApp,'resources/app.asar');
  const files=listPackage(asar);
  for(const file of files)assertDisplayCandidatePath(file.replace(/^[\\/]+/,''));
  const embedded=JSON.parse(extractFile(asar,'package.json').toString('utf8'));
  for(const key of ['version','main','wealthAtlasCandidate','wealthAtlasCandidateProfileVersion'])if(embedded[key]!==candidatePackage[key])throw new Error('Packaged identity/isolation mismatch.');
  if(!extractFile(asar,path.normalize('desktop/candidate-bootstrap.cjs')).equals(await readFile(path.join(root,'scripts/candidate-bootstrap.cjs'))))throw new Error('Packaged bootstrap mismatch.');
  for(const file of Object.keys(sourceHashes).filter(file=>file.startsWith('desktop/'))){if(!extractFile(asar,path.normalize(file)).equals(await readFile(path.join(root,file))))throw new Error('Packaged desktop source mismatch.');}
  await run([next,'build'],source,{...env,WEALTH_ATLAS_DESKTOP_BUILD:'0',NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP:'',WEALTH_ATLAS_WEB_EXPORT:'1'});
  await copyGenerated(path.join(source,'out'),path.join(webStage,'site'),'site');
  await copy('scripts/candidate-web-server.mjs',path.join(webStage,'candidate-web-server.mjs'));
  await copy('scripts/candidate-mac.command',path.join(webStage,'Start-Wealth-Atlas-Test.command'));
  await copy('docs/DISPLAY_CANDIDATE_TEST.md',path.join(webStage,'TESTING-GUIDE.md'));
  const guide=await readFile(path.join(root,'docs/DISPLAY_CANDIDATE_TEST.md'));
  await writeFile(path.join(windowsApp,'TESTING-GUIDE.md'),guide,{flag:'wx'});
  await writeFile(path.join(destination,'TESTING-GUIDE.md'),guide,{flag:'wx'});
  const windowsZip=path.join(destination,`Wealth-Atlas-Display-Test-v${DISPLAY_CANDIDATE_VERSION}-Windows-UNSIGNED.zip`);
  const macZip=path.join(destination,`Wealth-Atlas-Display-Test-v${DISPLAY_CANDIDATE_VERSION}-Mac-Web.zip`);
  await archive(windowsApp,windowsZip);await archive(webStage,macZip);
  for(const file of [windowsZip,macZip,asar,path.join(windowsApp,'Wealth Atlas Display Candidate.exe')])outputHashes[path.relative(destination,file).replaceAll('\\','/')]=hash(await readFile(file));
  for(const [file,expected]of Object.entries(sourceHashes))if(hash(await readFile(path.join(root,file)))!==expected)throw new Error('Source changed during packaging; do not distribute this candidate.');
  if(hash(await readFile(fileURLToPath(import.meta.url)))!==builderSha256)throw new Error('Builder changed during packaging; preserve this output and build again.');
  const report={status:'BUILT_FOR_MANUAL_TEST',version:DISPLAY_CANDIDATE_VERSION,sourceCommit,sourceHasUncommittedChanges,builderSha256,
    candidatePurpose:'display-preferences-acceptance',signature:'UNSIGNED',distributionReady:false,githubPublished:false,autoUpdatesEnabled:false,
    profileVersion:DISPLAY_CANDIDATE_VERSION,profile:`%APPDATA%\\Wealth Atlas Sync Candidate\\${DISPLAY_CANDIDATE_VERSION}`,
    webOrigin:'http://127.0.0.1:43175',cloudConfigured:true,financialDataIncluded:false,financeSchemaChanged:false,
    windowsRuntimeVerified:false,macRuntimeVerified:false,hostedTwoDeviceVerified:false,environmentFilesRead:false,sourceHashes,hashes:outputHashes};
  await writeFile(path.join(destination,'candidate-check.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await writeFile(path.join(destination,'SHA256SUMS.txt'),Object.entries(outputHashes).map(([name,digest])=>`${digest}  ${name}`).join('\n')+'\n',{flag:'wx'});
  console.log(JSON.stringify({version:DISPLAY_CANDIDATE_VERSION,destination,windowsApp,macZip,status:report.status}));
  return {destination,windowsApp,webStage,report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await buildDisplayCandidate();}catch{console.error('Display candidate build stopped. No secrets printed, files deleted, personal profiles changed, installation or publication performed.');process.exitCode=1;}}
