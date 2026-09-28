import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readArchive, readPacked, entryFor, verifyPayload, withHeader, atomicWrite } from './shell-asar.mjs';
import { patchMain } from './shell-patch.mjs';
import { rendererPatches } from './renderer-patch.mjs';

export const VERSION = '1.1.0';
const PACKAGE = '@local/dsh-locale-ru';
const TARGETS = ['lib/main.js', 'lib/preload-app.cjs', 'lib/preload-welcome.cjs'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const has = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function locations(install, home) {
  const resources = path.join(path.resolve(install), 'resources');
  const profile = path.join(path.resolve(home), 'profiles', 'desktop');
  return { install: path.resolve(install), home: path.resolve(home), resources, profile,
    asar: path.join(resources, 'app.asar'), work: path.join(resources, 'dsh-ru-patch'),
    state: path.join(resources, 'dsh-ru-patch', 'state.json'),
    manifest: path.join(profile, 'package.json'),
    package: path.join(profile, 'locales', 'ru'),
    module: path.join(profile, 'node_modules', '@local', 'dsh-locale-ru'),
    node: path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe') };
}

export function ensureStopped() {
  if (process.platform !== 'win32') return;
  const tasklist = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
  const result = spawnSync(tasklist, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Не удалось проверить запущенные процессы. Закройте DeepSeek Harness и повторите.');
  if (/DeepSeek Harness\.exe/i.test(result.stdout)) throw new Error('Сначала полностью закройте DeepSeek Harness через меню «Выход», включая значок в трее. Патчер не завершает задачи принудительно.');
}

export function inspect(loc) {
  const archive = readArchive(loc.asar);
  let baseline = structuredClone(archive.header), state = null, updated = false;
  // An updater may replace app.asar while keeping our backup directory. Never
  // apply an old header to new payload bytes. A fresh archive must contain all
  // original packed targets and pass its own checksums before we adopt it.
  const freshArchive = () => TARGETS.every(name => {
    const entry = entryFor(archive.header, name.split('/'));
    return entry && !entry.unpacked && !entry.link && entry.integrity?.algorithm === 'SHA256';
  });
  if (has(loc.state)) {
    state = readJSON(loc.state);
    if (state.schema !== 1 || path.resolve(state.install) !== loc.install || path.resolve(state.home) !== loc.home)
      throw new Error('Резервная копия относится к другому каталогу программы или профилю.');
    if (state.header !== 'original-header.json' || !Array.isArray(state.entries) ||
        state.entries.some(name => !TARGETS.includes(name))) throw new Error('Неизвестный формат состояния патчера.');
    if (state.status === 'installed') {
      const targets = [loc.package, loc.module];
      if (!state.previousProfile || !Array.isArray(state.previousDirectories) ||
          state.previousDirectories.length !== targets.length || new Set(state.previousDirectories.map(item => item.target)).size !== targets.length)
        throw new Error('В состоянии патчера отсутствуют данные для безопасного отката профиля.');
      for (const item of state.previousDirectories) {
        const relative = typeof item.backup === 'string' ? path.relative(path.join(loc.work, 'backups'), path.resolve(item.backup)) : '..';
        if (!targets.includes(item.target) || typeof item.present !== 'boolean' || !relative || relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('Некорректные пути резервной копии плагина.');
      }
    }
    const previous = readJSON(path.join(loc.work, state.header));
    const expected = structuredClone(archive.header);
    for (const name of state.entries) {
      const parts = name.split('/');
      const parent = entryFor(expected, parts.slice(0, -1));
      if (parent?.files) parent.files[parts.at(-1)] = entryFor(previous, parts);
    }
    if (same(expected, previous)) {
      // Same-sized upstream edits may retain the same header shape. Validate
      // against the saved integrity metadata before accepting the old baseline.
      try { verifyPayload(archive, previous); baseline = previous; }
      catch (error) { if (!freshArchive()) throw error; updated = true; }
    } else {
      if (!freshArchive()) throw new Error('Архив изменён и содержит распакованные патчи. Восстановите приложение перед установкой перевода.');
      updated = true;
    }
  } else {
    const legacy = loc.asar + '.unpacked/lib/main.js.header.bak';
    if (has(legacy) && !freshArchive()) {
      const previous = readJSON(legacy);
      const expected = structuredClone(archive.header);
      expected.files.lib.files['main.js'] = previous.files.lib.files['main.js'];
      if (!same(expected, previous)) throw new Error('Старый резервный заголовок не соответствует установленной версии.');
      baseline = previous;
    }
  }
  const count = verifyPayload(archive, baseline);
  const pkg = JSON.parse(readPacked(archive, entryFor(baseline, ['package.json'])).toString('utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-desktop' || typeof pkg.version !== 'string')
    throw new Error('Выбранный архив не является DeepSeek Harness. Файлы не изменены.');
  for (const name of TARGETS) {
    const entry = entryFor(baseline, name.split('/'));
    if (!entry || entry.unpacked || entry.link || entry.integrity?.algorithm !== 'SHA256')
      throw new Error('Не найден исходный файл с контрольной суммой: ' + name);
  }
  const main = readPacked(archive, entryFor(baseline, ['lib', 'main.js']));
  if (!has(loc.node)) throw new Error('Не найден Node.js из комплекта DeepSeek Harness. Восстановите установку приложения.');
  if (!has(loc.manifest)) throw new Error('Профиль desktop ещё не создан. Запустите DeepSeek Harness один раз и закройте его.');
  const manifest = readJSON(loc.manifest);
  if (!Array.isArray(manifest.dsh?.profile?.bundles) || !manifest.dependencies || typeof manifest.dependencies !== 'object')
    throw new Error('Неизвестный формат профиля desktop. Файлы не изменены.');
  return { archive, baseline, state, manifest, count, updated, version: pkg.version, main: main.toString('utf8') };
}

function syntax(node, code, module = true) {
  const result = spawnSync(node, [...(module ? ['--input-type=module'] : []), '--check'],
    { input: code, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Ошибка проверки JavaScript: ' + (result.error ?? result.stderr));
}

// Every original file is saved before replacement. A journal remains on disk
// if the computer loses power; caught errors are rolled back immediately.
export class Transaction {
  constructor(loc) {
    this.loc = loc;
    this.directory = path.join(loc.work, 'backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    fs.mkdirSync(this.directory, { recursive: true });
    this.actions = [];
    this.status = 'pending';
    this.save();
  }
  save() { atomicWrite(path.join(this.directory, 'journal.json'), jsonBytes({ status: this.status, actions: this.actions })); }
  file(target, bytes) {
    if (has(target) && fs.readFileSync(target).equals(Buffer.from(bytes))) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backup = path.join(this.directory, this.actions.length + '.before');
    const present = has(target);
    if (present) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    this.actions.push({ type: 'file', target, backup, present }); this.save();
    atomicWrite(target, bytes);
  }
  directorySwap(target, source) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const next = source ? target + '.ru-new-' + randomUUID() : null;
    if (source) {
      if (fs.lstatSync(source).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), next, process.platform === 'win32' ? 'junction' : 'dir');
      else fs.cpSync(source, next, { recursive: true, dereference: true, errorOnExist: true, force: false });
    }
    const backup = path.join(this.directory, this.actions.length + '.directory');
    const present = has(target);
    this.actions.push({ type: 'directory', target, backup, present, next }); this.save();
    if (present) fs.renameSync(target, backup); // Moves an old junction itself, never its target.
    if (next) fs.renameSync(next, target);
  }
  commit() { this.status = 'complete'; this.save(); }
  rollback() {
    const errors = [];
    for (const action of [...this.actions].reverse()) {
      if (action.restored) continue;
      try {
        if (action.type === 'file') {
          if (action.present) {
            const before = fs.readFileSync(action.backup);
            // A failed ASAR replacement often leaves the original file locked but intact.
            if (!has(action.target) || !fs.readFileSync(action.target).equals(before)) atomicWrite(action.target, before);
          } else if (has(action.target)) fs.unlinkSync(action.target);
        } else if (has(action.backup) || !action.present) {
          if (has(action.target)) fs.renameSync(action.target, path.join(this.directory, 'unused-' + randomUUID()));
          if (action.present) fs.renameSync(action.backup, action.target);
        }
        action.restored = true; this.save();
      } catch (error) { errors.push(action.target + ': ' + error.message); }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    this.status = 'rolled-back'; this.save();
  }
}

function pendingTransactions(loc) {
  const backups = path.join(loc.work, 'backups');
  if (!has(backups)) return [];
  return fs.readdirSync(backups, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(backups, d.name))
    .filter(dir => has(path.join(dir, 'journal.json')) && readJSON(path.join(dir, 'journal.json')).status === 'pending');
}

export function recoverPending(loc) {
  const inside = (file, root) => {
    const rel = path.relative(path.resolve(root), path.resolve(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const directory of pendingTransactions(loc).sort().reverse()) {
    const journal = readJSON(path.join(directory, 'journal.json'));
    for (const action of journal.actions) {
      if (!['file', 'directory'].includes(action.type) ||
          !(inside(action.target, loc.install) || inside(action.target, loc.profile)) || !inside(action.backup, directory))
        throw new Error('Некорректные пути в журнале восстановления: ' + directory);
    }
    const tx = Object.assign(Object.create(Transaction.prototype), { loc, directory, actions: journal.actions, status: 'pending' });
    tx.rollback();
  }
}

function runTransaction(loc, fn) {
  const tx = new Transaction(loc);
  try { fn(tx); tx.commit(); return tx.directory; }
  catch (error) {
    try { tx.rollback(); } catch (rollback) {
      throw new Error(`Не удалось завершить откат: ${rollback.message}. Резервная копия: ${tx.directory}. Исходная ошибка: ${error.message}`);
    }
    throw error;
  }
}

function getTranslations(loc, info) {
  const russian = readJSON(path.join(ROOT, 'payload', 'shell-ru.json'));
  const patches = new Map([['lib/main.js', patchMain(info.main, russian)], ...rendererPatches(info.archive, info.baseline, russian)]);
  for (const [name, code] of patches) syntax(loc.node, code, !name.endsWith('.cjs'));
  syntax(loc.node, fs.readFileSync(path.join(ROOT, 'payload/locale/client.js'), 'utf8'), false);
  const header = structuredClone(info.baseline);
  for (const [name, code] of patches) {
    const entry = entryFor(header, name.split('/'));
    if (!entry || entry.unpacked) throw new Error('Неподдерживаемая запись архива: ' + name);
    entry.size = Buffer.byteLength(code);
    entry.unpacked = true;
    delete entry.integrity;
  }
  return { patches, buffer: withHeader(info.archive, header) };
}

function localePayload(activation) {
  const files = new Map();
  for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'dictionaries.json']) {
    let data = fs.readFileSync(path.join(ROOT, 'payload/locale', name));
    if (name === 'client.js') data = Buffer.from(data.toString('utf8').replaceAll('__DSH_RU_ACTIVATION__', activation));
    files.set(name, data);
  }
  return files;
}

export function operate(action, loc, { stopped = ensureStopped, log = console.log } = {}) {
  if (!['check', 'install', 'uninstall'].includes(action)) throw new Error('Неизвестное действие: ' + action);
  if (action !== 'check') { stopped(); recoverPending(loc); }
  else if (pendingTransactions(loc).length) throw new Error('Найдена незавершённая установка. Закройте Harness и нажмите «Установить русский» или «Удалить перевод»: сначала будет восстановлено прежнее состояние.');
  const info = inspect(loc);
  log(`DeepSeek Harness ${info.version}. Проверены контрольные суммы ${info.count} файлов.`);
  if (info.updated) log('Обнаружен новый архив приложения. Совместимость проверяется заново; старый заголовок не используется.');
  if (action === 'check') {
    const built = getTranslations(loc, info);
    log(`Структура оболочки совместима: ${built.patches.size} файла. В словарях перевода: 138 строк оболочки и 2639 строк веб-интерфейса. Новые ключи используют английский текст.`);
    log(info.state?.status === 'installed' && !info.updated ? 'Перевод установлен.' : 'Можно установить перевод.');
    return;
  }
  if (action === 'uninstall') {
    if (!info.state || info.state.status !== 'installed') { log('Этот русификатор ещё не установлен.'); return; }
    const manifest = structuredClone(info.manifest);
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(x => x !== PACKAGE);
    const previous = info.state.previousProfile;
    if (previous?.bundle) manifest.dsh.profile.bundles.splice(Math.min(previous.bundleIndex, manifest.dsh.profile.bundles.length), 0, PACKAGE);
    if (previous?.dependencyPresent) manifest.dependencies[PACKAGE] = previous.dependency;
    else delete manifest.dependencies[PACKAGE];
    for (const item of info.state.previousDirectories ?? []) if (item.present && !has(item.backup))
      throw new Error('Не найдена резервная копия прежнего плагина: ' + item.backup);
    const archive = withHeader(info.archive, info.baseline);
    const backup = runTransaction(loc, tx => {
      tx.file(loc.asar, archive);
      tx.file(loc.manifest, jsonBytes(manifest));
      for (const item of info.state.previousDirectories ?? []) tx.directorySwap(item.target, item.present ? item.backup : null);
      tx.file(loc.state, jsonBytes({ ...info.state, status: 'uninstalled' }));
    });
    log('Исходный архив и прежнее подключение плагинов восстановлены. Перезапустите DeepSeek Harness.');
    log('Резервные копии сохранены: ' + backup);
    return;
  }
  const built = getTranslations(loc, info);
  const activation = info.state?.status === 'installed' ? info.state.activation : randomUUID();
  const payload = localePayload(activation);
  const manifest = structuredClone(info.manifest);
  manifest.dependencies[PACKAGE] = 'file:./locales/ru';
  if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE);
  const expected = [...built.patches].every(([name, code]) => {
    const target = path.join(loc.asar + '.unpacked', ...name.split('/'));
    return has(target) && fs.readFileSync(target).equals(Buffer.from(code));
  });
  const payloadSame = [loc.package, loc.module].every(dir =>
    [...payload].every(([file, bytes]) =>
      has(path.join(dir, file)) && fs.readFileSync(path.join(dir, file)).equals(bytes)));
  if (info.state?.status === 'installed' && built.buffer.equals(info.archive.buffer) && expected && payloadSame && same(manifest, info.manifest)) {
    log('Русский перевод уже установлен и прошёл проверку. Изменения не требуются.'); return;
  }
  const backup = runTransaction(loc, tx => {
    const originalHeader = path.join(loc.work, 'original-header.json');
    tx.file(originalHeader, jsonBytes(info.baseline));
    for (const [name, code] of built.patches) tx.file(path.join(loc.asar + '.unpacked', ...name.split('/')), Buffer.from(code));
    tx.directorySwap(loc.package, path.join(ROOT, 'payload/locale'));
    tx.directorySwap(loc.module, path.join(ROOT, 'payload/locale'));
    for (const dir of [loc.package, loc.module]) tx.file(path.join(dir, 'client.js'), payload.get('client.js'));
    tx.file(loc.manifest, jsonBytes(manifest));
    const previousProfile = info.state?.status === 'installed' ? info.state.previousProfile : {
      dependencyPresent: Object.hasOwn(info.manifest.dependencies, PACKAGE), dependency: info.manifest.dependencies[PACKAGE],
      bundle: info.manifest.dsh.profile.bundles.includes(PACKAGE), bundleIndex: info.manifest.dsh.profile.bundles.indexOf(PACKAGE) };
    const previousDirectories = info.state?.status === 'installed' ? info.state.previousDirectories
      : tx.actions.filter(a => a.type === 'directory').map(({ target, backup, present }) => ({ target, backup, present }));
    // Make recovery metadata durable before committing the archive header.
    tx.file(loc.state, jsonBytes({ schema: 1, status: 'installed', patchVersion: VERSION,
      appVersion: info.version, install: loc.install, home: loc.home, header: 'original-header.json',
      entries: [...built.patches.keys()], activation, previousProfile, previousDirectories }));
    tx.file(loc.asar, built.buffer);
    verifyPayload(readArchive(loc.asar), info.baseline);
  });
  log('Русская локализация установлена. Запустите DeepSeek Harness.');
  log('Резервные копии: ' + backup);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), action = args.shift();
    const options = {};
    while (args.length) {
      const key = args.shift(), value = args.shift();
      if (!['--install-dir', '--dsh-home'].includes(key) || !value || value.startsWith('--')) throw new Error('Неверные параметры командной строки.');
      options[key] = value;
    }
    const loc = locations(options['--install-dir'] ?? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
      options['--dsh-home'] ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
    operate(action, loc);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
