import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readArchive, withHeader, digest, entryFor, readPacked } from '../tools/shell-asar.mjs';
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
const fixtureDirectories = [];
after(() => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  for (const directory of fixtureDirectories) {
    const actual = fs.realpathSync(directory);
    if (path.dirname(actual) !== temporaryRoot || !path.basename(actual).startsWith('dsh-ru-test-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(actual, {recursive:true, force:true});
  }
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ru-test-'));
  fixtureDirectories.push(dir);
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

test('corrupt payload and unknown resolver are refused before mutation', { skip: !installed }, () => {
  for (const mode of ['corrupt', 'resolver']) {
    const { loc, baseline } = fixture();
    const archive = readArchive(loc.asar);
    if (mode === 'corrupt') archive.buffer[archive.dataOffset] ^= 1;
    else {
      rewriteArchive(loc, { 'lib/main.js': code => code.replaceAll('resolveDesktopLocale', 'unknownDesktopLocale') });
    }
    if (mode === 'corrupt') fs.writeFileSync(loc.asar, archive.buffer);
    const before = fs.readFileSync(loc.asar);
    assert.throws(() => operate('install', loc, options));
    assert.equal(fs.existsSync(loc.work), false);
    assert.equal(digest(fs.readFileSync(loc.asar)), digest(before));
  }
});

// Model an upstream rebuild: changed contents, offsets, sizes, hashes and version.
// These fixtures are compatibility simulations, not additional released builds.
function rewriteArchive(loc, replacements) {
  const archive = readArchive(loc.asar);
  const header = structuredClone(archive.header);
  const payloads = [archive.buffer.subarray(archive.dataOffset)];
  let offset = payloads[0].length;
  for (const [name, transform] of Object.entries(replacements)) {
    const entry = entryFor(header, name.split('/'));
    const bytes = Buffer.from(transform(readPacked(archive, entry).toString('utf8')));
    entry.offset = String(offset); entry.size = bytes.length;
    entry.integrity = { algorithm: 'SHA256', hash: digest(bytes), blockSize: 4194304,
      blocks: Array.from({length: Math.ceil(bytes.length / 4194304)}, (_, i) => digest(bytes.subarray(i*4194304,(i+1)*4194304))) };
    delete entry.unpacked;
    offset += bytes.length; payloads.push(bytes);
  }
  const capacity = Buffer.byteLength(JSON.stringify(header)) + 1024;
  const dataOffset = Math.ceil((capacity + 16) / 4) * 4;
  const buffer = Buffer.concat([Buffer.alloc(dataOffset), ...payloads]);
  buffer.writeUInt32LE(4, 0); buffer.writeUInt32LE(dataOffset - 8, 4);
  fs.writeFileSync(loc.asar, withHeader({buffer, dataOffset, pickleSize: dataOffset - 8}, header));
  return fs.readFileSync(loc.asar);
}

test('different version and changed main hash pass structural validation and exact revert', { skip: !installed }, () => {
  const {loc} = fixture();
  const original = rewriteArchive(loc, {
    'package.json': code => JSON.stringify({...JSON.parse(code), version: '9.42.0-test'}),
    'lib/main.js': code => '// upstream rebuild\n' + code
  });
  operate('check', loc, options);
  assert.equal(fs.existsSync(loc.work), false);
  operate('install', loc, options);
  assert.equal(JSON.parse(fs.readFileSync(loc.state)).appVersion, '9.42.0-test');
  operate('uninstall', loc, options);
  assert.deepEqual(fs.readFileSync(loc.asar), original);
});

test('upstream update with stale patch state is repatched and reverts to NEW archive', { skip: !installed }, () => {
  const {loc, original, profile} = fixture();
  operate('install', loc, options);
  const activation = JSON.parse(fs.readFileSync(loc.state)).activation;
  fs.writeFileSync(loc.asar, original); // updater replaces archive, retains patch backups and profile
  const updated = rewriteArchive(loc, {
    'package.json': code => JSON.stringify({...JSON.parse(code), version: '9.43.0-test'}),
    'lib/main.js': code => '// next upstream rebuild\n' + code
  });
  operate('check', loc, options);
  assert.deepEqual(fs.readFileSync(loc.asar), updated);
  operate('install', loc, options);
  const state = JSON.parse(fs.readFileSync(loc.state));
  assert.equal(state.appVersion, '9.43.0-test');
  assert.equal(state.activation, activation);
  operate('uninstall', loc, options);
  assert.deepEqual(fs.readFileSync(loc.asar), updated);
  assert.deepEqual(JSON.parse(fs.readFileSync(loc.manifest)), profile);
});

test('stale legacy header is ignored only for a clean packed upstream archive', { skip: !installed }, () => {
  const {loc, baseline} = fixture();
  const legacy = loc.asar + '.unpacked/lib/main.js.header.bak';
  fs.mkdirSync(path.dirname(legacy), {recursive:true});
  fs.writeFileSync(legacy, JSON.stringify(baseline));
  const original = rewriteArchive(loc, {'package.json': code => JSON.stringify({...JSON.parse(code), version:'10.0.0-test'})});
  operate('install', loc, options); operate('uninstall', loc, options);
  assert.deepEqual(fs.readFileSync(loc.asar), original);
});

test('changed locale API leaves plugin inactive without throwing', () => {
  let factory;
  const context = vm.createContext({ console: {warn: () => {}}, window: {__ModuleLoader__: {load: module => {factory=module.factory;}}}});
  new vm.Script(fs.readFileSync(path.join(root,'payload/locale/client.js'),'utf8')).runInContext(context);
  assert.doesNotThrow(() => factory().apply({locale: {}}));
});


test('failed reapply after upstream update restores NEW archive and previous patch state', { skip: !installed }, () => {
  const {loc, original} = fixture(); operate('install',loc,options);
  const beforeState=fs.readFileSync(loc.state);
  const beforeHeader=fs.readFileSync(path.join(loc.work,'original-header.json'));
  fs.writeFileSync(loc.asar,original);
  const updated=rewriteArchive(loc,{'package.json': code => JSON.stringify({...JSON.parse(code),version:'11.0.0-test'})});
  const rename=fs.renameSync;
  fs.renameSync=function(from,to) {if(path.resolve(to)===loc.asar) throw new Error('updated archive locked'); return rename(from,to);};
  try {assert.throws(()=>operate('install',loc,options),/updated archive locked/);} finally {fs.renameSync=rename;}
  assert.deepEqual(fs.readFileSync(loc.asar),updated);
  assert.deepEqual(fs.readFileSync(loc.state),beforeState);
  assert.deepEqual(fs.readFileSync(path.join(loc.work,'original-header.json')),beforeHeader);
  operate('install',loc,options);operate('uninstall',loc,options);
  assert.deepEqual(fs.readFileSync(loc.asar),updated);
});

test('uninstall directly after upstream update preserves NEW archive', { skip: !installed }, () => {
  const {loc,original,profile}=fixture();operate('install',loc,options);
  fs.writeFileSync(loc.asar,original);
  const updated=rewriteArchive(loc,{'package.json': code=>JSON.stringify({...JSON.parse(code),version:'12.0.0-test'})});
  operate('uninstall',loc,options);
  assert.deepEqual(fs.readFileSync(loc.asar),updated);
  assert.deepEqual(JSON.parse(fs.readFileSync(loc.manifest)),profile);
});


test('new shell dictionary keys keep upstream English values after patch', { skip: !installed }, () => {
  const {loc}=fixture();
  const transforms=Object.fromEntries(['lib/main.js','lib/preload-app.cjs','lib/preload-welcome.cjs'].map(name=>[name,code=>code.replace('const en = {','const en = {\n futureCommand: "Future command",')]));
  const original=rewriteArchive(loc,transforms);
  operate('install',loc,options);
  for(const name of Object.keys(transforms)) {
    const code=fs.readFileSync(path.join(loc.asar+'.unpacked',name),'utf8');
    assert.match(code,/futureCommand: "Future command"/);
    assert.match(code,/const ru = \{ \.\.\.en,/);
  }
  operate('uninstall',loc,options); assert.deepEqual(fs.readFileSync(loc.asar),original);
});


test('uninstall rejects backup targets outside the locale directories before mutation', {skip:!installed},()=>{
  const {loc}=fixture();operate('install',loc,options);
  const state=JSON.parse(fs.readFileSync(loc.state));
  state.previousDirectories[0].target=path.join(loc.home,'unrelated');
  fs.writeFileSync(loc.state,JSON.stringify(state));
  const before=fs.readFileSync(loc.asar);
  assert.throws(()=>operate('uninstall',loc,options),/пути резервной/);
  assert.deepEqual(fs.readFileSync(loc.asar),before);
});
