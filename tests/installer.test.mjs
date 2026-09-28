import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readArchive, withHeader, digest, entryFor } from '../tools/shell-asar.mjs';
import { locations, operate, Transaction, recoverPending } from '../tools/installer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('ASAR header uses UTF-8 byte lengths and preserves payload boundary', () => {
  const buffer = Buffer.alloc(160);
  const dataOffset = 128, pickleSize = dataOffset - 8;
  buffer.writeUInt32LE(4, 0); buffer.writeUInt32LE(pickleSize, 4);
  Buffer.from('{"runtime":true}').copy(buffer, dataOffset);
  const header = { files: { 'русский': { size: 16, offset: '0' } } };
  const updated = withHeader({ buffer, dataOffset, pickleSize }, header);
  assert.equal(updated.readUInt32LE(12), Buffer.byteLength(JSON.stringify(header)));
  assert.equal(updated.readUInt32LE(8), pickleSize - 4);
  assert.deepEqual(updated.subarray(dataOffset), buffer.subarray(dataOffset));
  assert.throws(() => withHeader({ buffer, dataOffset, pickleSize }, { files: { ['я'.repeat(100)]: {} } }), /capacity/);
});

test('web plugin registers Russian dictionaries and activates only once', async () => {
  const code = fs.readFileSync(path.join(root, 'payload/locale/client.js'), 'utf8');
  let factory, changes = 0, registered = 0;
  const values = new Map();
  const context = vm.createContext({ console,
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    window: { __ModuleLoader__: { load: module => { factory = module.factory; } } } });
  new vm.Script(code).runInContext(context);
  const plugin = factory();
  const ctx = { effect: fn => fn(), locale: {
    addLanguage: lang => { assert.equal(lang.id, 'ru'); return () => {}; },
    register: (ns, lang, dictionary) => { assert.equal(lang, 'ru'); assert.ok(Object.keys(dictionary).length); registered++; return () => {}; },
    setLocale: lang => { assert.equal(lang, 'ru'); changes++; }
  } };
  plugin.apply(ctx); await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered, 57); assert.equal(changes, 1);
  plugin.apply(ctx); await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes, 1, 'subsequent manual English selection must be respected');
});

const installed = process.env.DSH_TEST_INSTALL;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ru-test-'));
  const loc = locations(path.join(dir, 'Harness тест'), path.join(dir, 'home тест'));
  const source = path.join(installed, 'resources/app.asar');
  const live = readArchive(source);
  const modern = path.join(installed, 'resources/dsh-ru-patch/original-header.json');
  const legacy = source + '.unpacked/lib/main.js.header.bak';
  const baseline = fs.existsSync(modern) ? JSON.parse(fs.readFileSync(modern))
    : fs.existsSync(legacy) ? JSON.parse(fs.readFileSync(legacy)) : live.header;
  const original = withHeader(live, baseline);
  fs.mkdirSync(loc.resources, { recursive: true }); fs.mkdirSync(loc.profile, { recursive: true });
  fs.writeFileSync(loc.asar, original);
  const profile = { name: 'test-profile', private: true, dependencies: { unrelated: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  fs.writeFileSync(loc.manifest, JSON.stringify(profile));
  loc.node = process.execPath;
  return { loc, original, profile, baseline };
}
const options = { stopped: () => {}, log: () => {} };

test('real archive: dry check, apply, menu locale, idempotence and exact revert', { skip: !installed }, () => {
  const { loc, original, profile } = fixture();
  operate('check', loc, options);
  assert.equal(fs.existsSync(loc.work), false);
  operate('install', loc, options);
  const patched = digest(fs.readFileSync(loc.asar));
  const state = JSON.parse(fs.readFileSync(loc.state));
  assert.ok(state.entries.includes('lib/preload-app.cjs'));
  assert.ok(state.entries.includes('lib/preload-welcome.cjs'));
  for (const name of state.entries) {
    const text = fs.readFileSync(path.join(loc.asar + '.unpacked', name), 'utf8');
    const resolver = text.match(/function resolveDesktopLocale\(locale\) \{[\s\S]*?\n\}/)?.[0];
    if (resolver) {
      const ru = { application: 'Приложение', edit: 'Правка' };
      const resolve = new Function('locale', `const en={},zh={},ru=${JSON.stringify(ru)};${resolver};return resolveDesktopLocale(locale);`);
      assert.equal(resolve('ru-RU').messages.application, 'Приложение');
      assert.equal(resolve('ru').messages.edit, 'Правка');
      assert.equal(resolve('en').id, 'en'); assert.equal(resolve('zh-CN').id, 'zh-CN');
    }
  }
  const backups = fs.readdirSync(path.join(loc.work, 'backups'));
  operate('install', loc, options);
  assert.equal(digest(fs.readFileSync(loc.asar)), patched);
  assert.deepEqual(fs.readdirSync(path.join(loc.work, 'backups')), backups);
  // Later unrelated profile changes must survive uninstall.
  const changed = JSON.parse(fs.readFileSync(loc.manifest)); changed.userAdded = 'keep';
  fs.writeFileSync(loc.manifest, JSON.stringify(changed));
  operate('uninstall', loc, options);
  assert.equal(digest(fs.readFileSync(loc.asar)), digest(original));
  const reverted = JSON.parse(fs.readFileSync(loc.manifest));
  assert.equal(reverted.userAdded, 'keep'); assert.deepEqual(reverted.dependencies, profile.dependencies);
  operate('uninstall', loc, options);
  assert.equal(digest(fs.readFileSync(loc.asar)), digest(original));
  operate('install', loc, options);
  assert.equal(digest(fs.readFileSync(loc.asar)), patched);
});

test('archive replacement failure rolls back profile, overrides and plugin directories', { skip: !installed }, () => {
  const { loc, original } = fixture();
  const before = fs.readFileSync(loc.manifest);
  const rename = fs.renameSync;
  let failed = false;
  fs.renameSync = function(from, to) {
    if (path.resolve(to) === loc.asar) { failed = true; throw new Error('simulated locked archive'); }
    return rename(from, to);
  };
  try { assert.throws(() => operate('install', loc, options), /simulated locked archive/); }
  finally { fs.renameSync = rename; }
  assert.ok(failed);
  assert.equal(digest(fs.readFileSync(loc.asar)), digest(original));
  assert.deepEqual(fs.readFileSync(loc.manifest), before);
  assert.equal(fs.existsSync(loc.state), false);
  assert.equal(fs.existsSync(loc.module), false);
  assert.equal(fs.existsSync(loc.package), false);
  assert.equal(fs.existsSync(loc.asar + '.unpacked/lib/main.js'), false);
});

test('pending journal recovers before trying to parse a damaged archive', { skip: !installed }, () => {
  const { loc, original } = fixture();
  const before = fs.readFileSync(loc.manifest);
  const tx = new Transaction(loc);
  tx.file(loc.manifest, Buffer.from('{"partial":true}'));
  tx.file(loc.asar, Buffer.from('interrupted archive replacement'));
  assert.throws(() => operate('check', loc, options), /незавершённая/);
  recoverPending(loc);
  assert.deepEqual(fs.readFileSync(loc.manifest), before);
  assert.equal(digest(fs.readFileSync(loc.asar)), digest(original));
  recoverPending(loc);
  operate('check', loc, options);
});

test('uninstall restores a pre-existing locale dependency and directory link', { skip: !installed }, () => {
  const { loc, profile } = fixture();
  const previous = path.join(path.dirname(loc.home), 'old locale');
  fs.mkdirSync(previous); fs.writeFileSync(path.join(previous, 'mine.txt'), 'untouched');
  fs.mkdirSync(path.dirname(loc.module), { recursive: true });
  fs.symlinkSync(previous, loc.module, process.platform === 'win32' ? 'junction' : 'dir');
  profile.dependencies['@local/dsh-locale-ru'] = 'file:' + previous;
  profile.dsh.profile.bundles.push('@local/dsh-locale-ru');
  fs.writeFileSync(loc.manifest, JSON.stringify(profile));
  operate('install', loc, options);
  assert.equal(fs.lstatSync(loc.module).isSymbolicLink(), false);
  operate('uninstall', loc, options);
  assert.deepEqual(JSON.parse(fs.readFileSync(loc.manifest)), profile);
  assert.ok(fs.lstatSync(loc.module).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(loc.module, 'mine.txt'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(path.join(previous, 'mine.txt'), 'utf8'), 'untouched');
});

test('corrupt payload and unsupported version are refused before mutation', { skip: !installed }, () => {
  for (const mode of ['corrupt', 'unsupported']) {
    const { loc, baseline } = fixture();
    const archive = readArchive(loc.asar);
    if (mode === 'corrupt') archive.buffer[archive.dataOffset] ^= 1;
    else {
      const entry = entryFor(baseline, ['package.json']);
      const at = archive.dataOffset + Number(entry.offset);
      const bytes = archive.buffer.subarray(at, at + entry.size);
      Buffer.from(bytes.toString('utf8').replace('0.1.7-rc.2', '0.1.7-rc.3')).copy(archive.buffer, at);
    }
    fs.writeFileSync(loc.asar, archive.buffer);
    assert.throws(() => operate('install', loc, options), mode === 'corrupt' ? /checksum/ : /Поддерживается/);
    assert.equal(fs.existsSync(loc.work), false);
    assert.equal(digest(fs.readFileSync(loc.asar)), digest(archive.buffer));
  }
});
