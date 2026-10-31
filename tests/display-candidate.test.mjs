import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {
  DISPLAY_CANDIDATE_VERSION,
  assertDisplayCandidatePath,
  displayCandidateEnvironment,
} from '../scripts/build-display-candidate.mjs';

// Only this public source file is read. Never invoke the builder, subprocesses,
// network, environment loaders, profile access or filesystem fixtures here.
const source = readFileSync(new URL('../scripts/build-display-candidate.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('build-display-candidate.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const builderBody = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildDisplayCandidate').body;
const publicUrl = 'https://jddkmphdilgjfftsoojl.supabase.co';
const publicKey = 'sb_publishable_synthetic_display_test_only';
const publicEnvironment = Object.freeze({ NEXT_PUBLIC_SUPABASE_URL: publicUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey });
const jwt = payload => `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-signature`;
const text = node => node.getText(tree);
const compact = node => text(node).replace(/\s+/g, '');
function find(predicate, scope = tree) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(scope);
  return found;
}
function variable(name) {
  const matches = find(node => ts.isVariableDeclaration(node) && text(node.name) === name, builderBody);
  assert.equal(matches.length, 1, `Expected exactly one ${name} declaration`);
  return matches[0].initializer;
}
const calls = name => find(node => ts.isCallExpression(node) && text(node.expression) === name);
function property(object, name) {
  assert.ok(ts.isObjectLiteralExpression(object), 'Expected an explicit object, not ambient configuration');
  const matches = object.properties.filter(node => node.name && text(node.name).replace(/^['"]|['"]$/g, '') === name);
  assert.equal(matches.length, 1, `Expected exactly one ${name} property`);
  return matches[0];
}
const value = (object, name) => property(object, name).initializer;
function strings(array) {
  assert.ok(ts.isArrayLiteralExpression(array));
  return array.elements.map(item => { assert.ok(ts.isStringLiteral(item)); return item.text; });
}

test('candidate and fresh profile use only 1.7.7-rc.1, never an old rc.5 profile', () => {
  assert.equal(DISPLAY_CANDIDATE_VERSION, '1.7.7-rc.1');
  const pkg = variable('candidatePackage');
  assert.equal(text(value(pkg, 'version')), 'DISPLAY_CANDIDATE_VERSION');
  assert.equal(text(value(pkg, 'wealthAtlasCandidateProfileVersion')), 'DISPLAY_CANDIDATE_VERSION');
  assert.equal(value(pkg, 'wealthAtlasCandidate').text, 'cloud-sync-test');
  assert.equal(value(pkg, 'main').text, 'desktop/candidate-bootstrap.cjs');
  assert.equal(text(value(variable('report'), 'profileVersion')), 'DISPLAY_CANDIDATE_VERSION');
  assert.match(text(value(variable('report'), 'profile')), /Wealth Atlas Sync Candidate.*\$\{DISPLAY_CANDIDATE_VERSION\}/);
  assert.doesNotMatch(source, /(?:1\.\d+\.\d+-rc\.5|rc[.-]?5)\b/i);
});

test('path helper accepts ordinary staged source, web and desktop paths', () => {
  for (const relative of ['app/page.tsx', 'components/HomeCustomization.tsx', 'lib/display-preferences.ts',
    'public/icon.svg', 'out/index.html', 'out/_next/static/chunks/page.js', 'desktop/main.cjs',
    'desktop/auth-diagnostic-codes.json', 'build/icon.svg', 'site/index.html', 'desktop\\main.cjs',
    'Start-Wealth-Atlas-Test.command', 'TESTING-GUIDE.md', 'resources/app.asar', 'package.json']) {
    assert.doesNotThrow(() => assertDisplayCandidatePath(relative), relative);
  }
});

test('path helper rejects invalid, absolute, drive, UNC and traversal inputs', () => {
  for (const relative of [undefined, null, 0, {}, '', '.', '..', '../fixture', 'out/../fixture',
    'out/./fixture', 'out//fixture', 'out/', '/fixture', 'C:/fixture', 'C:fixture',
    '\\\\synthetic-host\\share\\fixture', '\\fixture', 'out\\..\\fixture', 'out\\\\fixture']) {
    assert.throws(() => assertDisplayCandidatePath(relative), /Unsafe candidate input refused before reading it\./);
  }
});

test('path helper rejects environment, financial, backup and credential inputs without echoing them', () => {
  for (const relative of ['.env', '.env.local', 'app/.ENV.production', 'public/data/synthetic.json',
    'exports/synthetic.xlsx', 'private-vault/note.md', 'backups/synthetic.json', 'outputs/synthetic.json',
    'review/request.json', 'certificates/sign.pfx', 'userprofiles/synthetic/file.json',
    'realfinance/synthetic.json', 'vault/note.md', 'vaults/note.md', 'desktop/update-token.json',
    'desktop\\UPDATE-TOKEN.JSON', 'app/synthetic.p12', 'app/synthetic.pem', 'app/synthetic.key',
    'public/synthetic.CSV', 'public/synthetic.zip', 'app/synthetic.xlsx']) {
    assert.throws(() => assertDisplayCandidatePath(relative), error => {
      assert.equal(error.message, 'Unsafe candidate input refused before reading it.');
      return true;
    });
  }
});

const systemNames = ['SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'PATH', 'Path',
  'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'];
test('child environment is an exact OS/public allowlist with forced safety settings', () => {
  const system = Object.fromEntries(systemNames.map(name => [name, `synthetic-${name}`]));
  const input = Object.freeze({ ...publicEnvironment, ...system, NEXT_TELEMETRY_DISABLED: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'true', CSC_IDENTITY_AUTO_DISCOVERY: 'true' });
  assert.deepEqual(displayCandidateEnvironment(input), { ...system, ...publicEnvironment,
    NEXT_TELEMETRY_DISABLED: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.equal(input.CSC_IDENTITY_AUTO_DISCOVERY, 'true');
  assert.equal(Object.getPrototypeOf(displayCandidateEnvironment(input)), Object.prototype);
});

test('API, publishing, signing, proxy and injected runtime secrets do not survive sanitization', () => {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'API_SECRET', 'GH_TOKEN', 'GITHUB_TOKEN',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD', 'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'NEXT_PUBLIC_UNREVIEWED_SECRET', 'WEALTH_ATLAS_TEST_PROFILE', 'WEALTH_ATLAS_CANDIDATE_FIRST_DOCUMENT',
    'WEALTH_ATLAS_DESKTOP_SMOKE', 'ELECTRON_RUN_AS_NODE', 'WEALTH_ATLAS_PUBLISH', 'WEALTH_ATLAS_EMBED_TOKEN'];
  const input = Object.freeze({ ...publicEnvironment, ...Object.fromEntries(names.map(name => [name, 'SYNTHETIC_PRIVATE_SENTINEL'])) });
  const result = displayCandidateEnvironment(input);
  for (const name of names) assert.equal(Object.hasOwn(result, name), false, name);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_SENTINEL/);
});

test('public publishable and synthetic anon JWT configurations are normalized without file or cloud access', () => {
  for (const key of [publicKey, jwt({ role: 'anon', ref: 'jddkmphdilgjfftsoojl' })]) {
    const result = displayCandidateEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `  ${publicUrl}/  `,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ` ${key} ` });
    assert.equal(result.NEXT_PUBLIC_SUPABASE_URL, publicUrl);
    assert.equal(result.NEXT_PUBLIC_SUPABASE_ANON_KEY, key);
    assert.equal(Object.hasOwn(result, 'NEXT_PUBLIC_APP_URL'), false);
  }
});

test('missing, mismatched or unsafe public cloud configuration fails without disclosing input', () => {
  for (const input of [{}, { NEXT_PUBLIC_SUPABASE_URL: publicUrl },
    { ...publicEnvironment, NEXT_PUBLIC_SUPABASE_URL: '' },
    { ...publicEnvironment, NEXT_PUBLIC_SUPABASE_ANON_KEY: '' },
    ...['https://synthetic-private.invalid', 'http://jddkmphdilgjfftsoojl.supabase.co',
      `${publicUrl}/synthetic-private`, `${publicUrl}?synthetic-private=1`, `${publicUrl}#synthetic-private`,
      'https://synthetic-private:password@jddkmphdilgjfftsoojl.supabase.co', 'not-a-synthetic-private-url']
      .map(address => ({ ...publicEnvironment, NEXT_PUBLIC_SUPABASE_URL: address })),
    ...['sb_secret_SYNTHETIC_PRIVATE_SENTINEL', jwt({ role: 'service_role', marker: 'SYNTHETIC_PRIVATE_SENTINEL' }),
      jwt({ role: 'authenticated' }), 'sb_publishable_synthetic\nprivate', 'SYNTHETIC_PRIVATE_SENTINEL']
      .map(key => ({ ...publicEnvironment, NEXT_PUBLIC_SUPABASE_ANON_KEY: key }))]) {
    assert.throws(() => displayCandidateEnvironment(input), error => {
      assert.match(error.message, /suppressed/);
      assert.doesNotMatch(error.message, /synthetic-private|SYNTHETIC_PRIVATE_SENTINEL|service_role|password/);
      return true;
    });
  }
});

test('candidate refuses publication and credential embedding before accepting any configuration', () => {
  for (const name of ['WEALTH_ATLAS_PUBLISH', 'WEALTH_ATLAS_EMBED_TOKEN']) {
    assert.throws(() => displayCandidateEnvironment({ [name]: '1' }), /cannot publish or embed credentials/);
    assert.throws(() => displayCandidateEnvironment({ ...publicEnvironment, [name]: '1' }), /cannot publish or embed credentials/);
  }
});

test('optional public redirect permits normalized HTTP(S), not credentials or private query fragments', () => {
  for (const address of ['https://synthetic-redirect.invalid', 'http://127.0.0.1:43175/', 'https://synthetic-redirect.invalid/callback']) {
    assert.equal(displayCandidateEnvironment({ ...publicEnvironment, NEXT_PUBLIC_APP_URL: ` ${address} ` }).NEXT_PUBLIC_APP_URL,
      new URL(address).href);
  }
  assert.equal(Object.hasOwn(displayCandidateEnvironment({ ...publicEnvironment, NEXT_PUBLIC_APP_URL: '  ' }), 'NEXT_PUBLIC_APP_URL'), false);
  for (const address of ['not-a-SYNTHETIC_PRIVATE_SENTINEL-url', 'file:///SYNTHETIC_PRIVATE_SENTINEL',
    'javascript:SYNTHETIC_PRIVATE_SENTINEL', 'https://SYNTHETIC_PRIVATE_SENTINEL:password@synthetic-redirect.invalid',
    'https://synthetic-redirect.invalid?token=SYNTHETIC_PRIVATE_SENTINEL', 'https://synthetic-redirect.invalid#SYNTHETIC_PRIVATE_SENTINEL']) {
    assert.throws(() => displayCandidateEnvironment({ ...publicEnvironment, NEXT_PUBLIC_APP_URL: address }), error => {
      assert.equal(error.message, 'Invalid public redirect configuration; value suppressed.');
      return true;
    });
  }
});

test('import is CLI-guarded and has no environment-file loaders, cloud clients or profile operations', () => {
  const guards = tree.statements.filter(ts.isIfStatement);
  assert.equal(guards.length, 1);
  assert.equal(compact(guards[0].expression), 'process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href');
  assert.match(text(guards[0].thenStatement), /await buildDisplayCandidate\(\)/);
  assert.equal(calls('buildDisplayCandidate').length, 1);
  assert.doesNotMatch(source, /\b(?:dotenv|loadEnvConfig|loadEnvFile|fetch|createClient|probeAnonymousPrivileges|setPath|getPath|rm|unlink|rename)\s*\(/);
  assert.match(source, /lstat\(path\.join\(root,'desktop\/update-token\.json'\)\)/);
  assert.doesNotMatch(source, /readFile\(path\.join\(root,['"]desktop\/update-token\.json/);
});

test('source roots and packaged payload are explicit allowlists; unreviewed public files are excluded', () => {
  const loops = find(ts.isForOfStatement, builderBody);
  const folderLoop = loops.find(node => /const folder\b/.test(text(node.initializer)));
  const nameLoops = loops.filter(node => /const name\b/.test(text(node.initializer)) && ts.isArrayLiteralExpression(node.expression));
  assert.deepEqual(strings(folderLoop.expression), ['app', 'components', 'lib', 'public', 'desktop', 'build']);
  assert.deepEqual(nameLoops.map(node => strings(node.expression)), [
    ['next.config.mjs', 'postcss.config.mjs', 'tsconfig.json', 'next-env.d.ts'], ['out', 'desktop', 'build'],
  ]);
  assert.deepEqual(strings(value(variable('config'), 'files')), [
    'out/**/*', 'desktop/*.cjs', 'desktop/auth-diagnostic-codes.json', 'build/icon.svg', 'package.json', '!node_modules/**/*',
  ]);
  assert.match(source, /\['ls-files','-z','--','public'\]/);
  assert.match(source, /\['diff','HEAD','--name-only','--','public'\]/);
  assert.match(source, /if\(relative\.startsWith\('public\/'\).*?!approvedPublic\.has\(relative\).*?\)return;/);
  assert.match(source, /assertDisplayCandidatePath\(relative\);[\s\S]*?const from=path\.join\(root,relative\),info=await lstat\(from\)/);
});

test('copy and archive boundaries refuse source/generated links and key material', () => {
  assert.match(source, /if\(info\.isSymbolicLink\(\)\)throw new Error\('Source links refused\.'/);
  assert.match(source, /if\(info\.isSymbolicLink\(\)\)throw new Error\('Generated links refused\.'/);
  assert.match(source, /info\.isFile\(\)&&info\.nlink===1/);
  assert.match(source, /info\.isSymbolicLink\(\) \|\| info\.nlink !== 1 && !info\.isDirectory\(\)/);
  assert.match(source, /Private key material refused; content suppressed\./);
  assert.match(source, /for\(const file of files\)assertDisplayCandidatePath\(/);
  assert.match(source, /for\(const \[file,expected\]of Object\.entries\(sourceHashes\)\)/);
});

test('desktop and Mac static builds run from isolated source with opposite explicit export flags', () => {
  const runs = calls('run');
  assert.equal(runs.length, 3);
  for (const [call, flags] of [[runs[0], ['1', '1', '0']], [runs[2], ['0', '', '1']]]) {
    assert.equal(compact(call.arguments[0]), "[next,'build']");
    assert.equal(text(call.arguments[1]), 'source');
    const environment = call.arguments[2];
    assert.equal(text(environment.properties[0]), '...env');
    assert.deepEqual(['WEALTH_ATLAS_DESKTOP_BUILD', 'NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP', 'WEALTH_ATLAS_WEB_EXPORT']
      .map(name => value(environment, name).text), flags);
    assert.equal(environment.properties.length, 4);
  }
  assert.equal(text(variable('env')), 'displayCandidateEnvironment(process.env)');
  assert.match(text(variable('scratch')), /path\.join\(path\.dirname\(root\),'wealth-atlas-display-candidate-work',id\)/);
  assert.match(text(variable('destination')), /'desktop-dist','display-candidates'/);
  assert.deepEqual(calls('symlink').map(call => compact(call.arguments[1])), ["path.join(source,'node_modules')"]);
});

test('ALL child processes, including metadata-only Git commands, receive the sanitized environment', () => {
  const spawns = calls('spawn');
  assert.equal(spawns.length, 1);
  const spawnEnvironment = property(spawns[0].arguments[2], 'env');
  assert.equal(text(spawnEnvironment.initializer ?? spawnEnvironment.name), 'env');
  const git = calls('execFileSync');
  assert.equal(git.length, 4);
  // Regression: omitting env inherits every parent API/publishing/signing secret.
  for (const call of git) {
    assert.equal(call.arguments[0].text, 'git');
    const environment = property(call.arguments[2], 'env');
    assert.equal(text(environment.initializer ?? environment.name), 'env');
  }
});

test('report derives dirty status from Git and binds the builder hash before and after packaging', () => {
  const status = calls('execFileSync').filter(call =>
    JSON.stringify(strings(call.arguments[1])) === JSON.stringify(['status', '--porcelain']));
  assert.equal(status.length, 1);
  const dirty = variable('sourceHasUncommittedChanges');
  assert.ok(ts.isCallExpression(dirty));
  assert.equal(text(dirty.expression), 'Boolean');
  assert.equal(dirty.arguments.length, 1);
  assert.equal(compact(dirty.arguments[0]), `${compact(status[0])}.trim()`);
  const initialHash = variable('builderSha256');
  assert.equal(compact(initialHash), 'hash(awaitreadFile(fileURLToPath(import.meta.url)))');
  assert.match(source, /const hash = value => createHash\('sha256'\)/);
  const rechecks = find(node => ts.isIfStatement(node)
    && compact(node.expression) === 'hash(awaitreadFile(fileURLToPath(import.meta.url)))!==builderSha256', builderBody);
  assert.equal(rechecks.length, 1);
  assert.ok(ts.isThrowStatement(rechecks[0].thenStatement));
  const builds = calls('run');
  assert.ok(initialHash.pos < builds[0].pos, 'Hash the builder before packaging starts');
  assert.ok(rechecks[0].pos > builds.at(-1).pos, 'Recheck the builder after both exports');
  assert.ok(rechecks[0].end < variable('report').pos, 'Reject changed builder before declaring success');
  for (const name of ['sourceHasUncommittedChanges', 'builderSha256']) {
    const field = property(variable('report'), name);
    assert.equal(text(field.initializer ?? field.name), name);
  }
});

test('packager is directory-only, unsigned, explicitly unpublished and uses staged app metadata', () => {
  const config = variable('config');
  assert.equal(value(config, 'appId').text, 'com.wealthatlas.display-candidate');
  assert.equal(text(value(config, 'npmRebuild')), 'false');
  assert.equal(text(value(config, 'publish')), 'null');
  const win = value(config, 'win');
  assert.equal(value(win, 'target').text, 'dir');
  assert.equal(text(value(win, 'signExecutable')), 'false');
  assert.equal(text(value(value(config, 'directories'), 'app')), 'appStage');
  assert.equal(compact(value(value(config, 'directories'), 'output')), "path.join(destination,'windows')");
  const builder = calls('run')[1];
  assert.equal(compact(builder.arguments[0]), "[builderCli,'--win','dir','--x64','--publish','never','--config',configPath]");
  assert.equal(text(builder.arguments[2]), 'env');
  assert.equal(text(value(variable('candidatePackage'), 'private')), 'true');
  assert.equal(value(variable('candidatePackage'), 'dependencies').properties.length, 0);
  assert.doesNotMatch(source, /release:publish|npm\s+(?:install|ci)|git\s+(?:tag|push)|--publish['"],['"](?:always|onTag)/);
});

test('all writes are staged/exclusive and never rewrite root package version, source or profiles', () => {
  assert.deepEqual(calls('writeFile').map(call => compact(call.arguments[0])), [
    'target', "path.join(source,'package.json')", "path.join(appStage,'package.json')", 'configPath',
    "path.join(windowsApp,'TESTING-GUIDE.md')", "path.join(destination,'TESTING-GUIDE.md')",
    "path.join(destination,'candidate-check.json')", "path.join(destination,'SHA256SUMS.txt')",
  ]);
  for (const call of calls('writeFile')) assert.equal(value(call.arguments[2], 'flag').text, 'wx');
  assert.deepEqual(calls('copyFile').map(call => text(call.arguments[1])), ['target', 'to']);
  for (const call of calls('copyFile')) assert.equal(text(call.arguments[2]), '1');
  const stagedVersionWrite = calls('writeFile').find(call => compact(call.arguments[0]) === "path.join(source,'package.json')");
  assert.match(compact(stagedVersionWrite.arguments[1]), /\.\.\.pkg,version:DISPLAY_CANDIDATE_VERSION/);
  assert.equal(compact(variable('configPath')), "path.join(scratch,'builder.json')");
  assert.equal(compact(variable('source')), "path.join(scratch,'source')");
  assert.equal(compact(variable('appStage')), "path.join(scratch,'app')");
});

test('packaged identity/bootstrap are checked and report cannot claim runtime verification or distribution readiness', () => {
  assert.match(source, /\['version','main','wealthAtlasCandidate','wealthAtlasCandidateProfileVersion'\]/);
  assert.match(source, /embedded\[key\]!==candidatePackage\[key\]/);
  assert.match(source, /Packaged bootstrap mismatch\./);
  assert.match(source, /Packaged desktop source mismatch\./);
  const report = variable('report');
  assert.equal(value(report, 'status').text, 'BUILT_FOR_MANUAL_TEST');
  assert.equal(value(report, 'signature').text, 'UNSIGNED');
  for (const name of ['distributionReady', 'githubPublished', 'autoUpdatesEnabled', 'windowsRuntimeVerified',
    'macRuntimeVerified', 'hostedTwoDeviceVerified', 'environmentFilesRead', 'financeSchemaChanged']) {
    assert.equal(text(value(report, name)), 'false', name);
  }
  assert.equal(value(report, 'webOrigin').text, 'http://127.0.0.1:43175');
  assert.match(source, /unixPermissions:relative\.endsWith\('\.command'\)\?0o755:0o644/);
});
