import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'node_modules/electron/dist', process.platform === 'win32'
  ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

test('CSV mapping store stays independent of financial storage and network', async () => {
  const source = await readFile(path.join(root, 'desktop/investment/csv-template-store.cjs'), 'utf8');
  assert.match(source, /wealth-atlas-investment-csv-mappings-v1/);
  assert.match(source, /indexedDB\.open\(DATABASE, 1\)/);
  assert.match(source, /createObjectStore\('books', \{keyPath: 'key'\}\)/);
  assert.doesNotMatch(source, /deleteDatabase|localStorage|fetch\(|https?:|supabase|\bBuffer\b|require\(['"](?:\.\/local-space|\.\/store|node:fs)/i);
});

test('CSV mapping templates: isolated real IndexedDB races, fencing, corruption, rollback and process restart', {timeout: 115000}, async () => {
  // Intentionally retained synthetic profile: never delete or inspect user profiles.
  const profile = path.join(os.tmpdir(), 'wa-csv-mapping-store-qa-' + randomUUID());
  const env = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let revision;
  for (const restart of [false, true]) {
    const report = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--disable-gpu', path.join(root, 'scripts/investment-csv-store-test.cjs'),
        '--qa-profile=' + profile, ...(restart ? ['--verify-restart', '--qa-revision=' + revision] : [])],
      {cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '', settled = false;
      const capture = buffer => { output = (output + buffer.toString()).slice(-16000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const finish = (failure, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (failure) reject(failure); else resolve(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(Error('Synthetic CSV mapping fixture timed out.')); }, 50000);
      child.once('error', () => finish(Error('Synthetic CSV mapping fixture could not start.')));
      child.once('close', code => {
        const pass = output.match(/INVESTMENT_CSV_STORE_PASS (\{[^\r\n]+\})/);
        if (code !== 0 || !pass) {
          const failure = output.match(/INVESTMENT_CSV_STORE_FAIL (\{[^\r\n]+\})/);
          // Never relay Electron stderr, environment, paths or user-provided names.
          finish(Error('Synthetic CSV mapping fixture failed: ' + (failure ? failure[1] : 'no fixed report')));
        } else {
          try { finish(null, JSON.parse(pass[1])); }
          catch { finish(Error('Synthetic CSV mapping fixture returned an invalid report.')); }
        }
      });
    });
    assert.equal(report.realBackendRequests, 0);
    assert.equal(report.productionDataAccessed, false);
    assert.ok(report.checks.length >= (restart ? 2 : 10));
    assert.ok(Number.isSafeInteger(report.localRevision));
    if (restart) assert.equal(report.localRevision, revision);
    revision = report.localRevision;
    console.log('INVESTMENT_CSV_STORE_PASS ' + JSON.stringify(report));
  }
});
