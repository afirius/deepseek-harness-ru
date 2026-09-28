import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inventoryPatches, patchInventorySource } from '../tools/inventory-patch.mjs';

const fixture = (separator = '\n') => [
  'function readPluginMeta(specifier, parentURL) {',
  '\tconst manifest = getManifest(specifier);',
  '\tconst dictionaries = getDictionaries(specifier);',
  '\tconst title = localizedText("title", dictionaries, fallbackText(manifest?.name), specifier);',
  '\tconst description = localizedText("description", dictionaries, fallbackText(manifest?.description), "");',
  '\tconst text = {',
  '\t\t...title === void 0 ? {} : { title },',
  '\t\t...description === void 0 ? {} : { description }',
  '\t};',
  '\treturn text;',
  '}',
].join(separator);

test('metadata patch adds only guarded Russian fields and preserves existing locale entries', () => {
  const patched = patchInventorySource(fixture('\r\n'));
  assert.match(patched, /dsh-inventory-meta-ru: description-guarded metadata/);
  assert.match(patched, /fallbackText\(manifest\?\.description\) === __dshInventoryRussianPackages\[specifier\]\.englishDescription/);
  assert.match(patched, /\.\.\.title === void 0 \? \{\} : \{ title: __dshInventoryRussianTitle \}/);
  assert.match(patched, /\.\.\.description === void 0 \? \{\} : \{ description: __dshInventoryRussianDescription \}/);
  assert.match(patched, /\.\.\.title, ru: __dshInventoryRussianMeta\.title/);
  assert.match(patched, /\{ en: title \?\? specifier, ru:/);
  assert.match(patched, /\{ en: description \?\? "", ru:/);
  assert.ok(patched.includes('\r\n'));
});

test('only known packages with the unchanged English description receive Russian fields', () => {
  const original = fixture();
  const common = `
    function fallbackText(value) { return typeof value === 'string' && value.trim() !== '' ? value : void 0; }
    function localizedText(_field, _dictionaries, fallback, finalFallback) { return fallback ?? finalFallback; }
    function getDictionaries() { return new Map(); }
  `;
  const specifier = '@deepseek-ai/dsh-tool-bash';
  const expectedEnglish = 'Model-facing bash tool with optional generic background-job and sandbox-escalation support';
  const runWithDescription = (description) => vm.runInNewContext(`${common}
    function getManifest(name) { return { name, description: ${JSON.stringify(description)} }; }
    ${patchInventorySource(original)}
    readPluginMeta(${JSON.stringify(specifier)}).description;
  `);
  assert.deepEqual(JSON.parse(JSON.stringify(runWithDescription(expectedEnglish))), {
    en: expectedEnglish,
    ru: 'Инструмент bash для модели с поддержкой фоновых задач и повышения уровня песочницы.',
  });
  assert.equal(runWithDescription('Changed upstream description'), 'Changed upstream description');
  assert.equal(runWithDescription(expectedEnglish + ' '), expectedEnglish + ' ');
});

test('metadata patch refuses changed or ambiguous app-boot source', () => {
  assert.throws(() => patchInventorySource(fixture().replace('fallbackText(manifest?.description)', 'fallbackText(manifest?.name)')), /Unsupported plugin metadata template/);
  assert.throws(() => patchInventorySource(fixture() + '\n' + fixture()), /Unsupported plugin metadata template/);
  const once = patchInventorySource(fixture());
  assert.throws(() => patchInventorySource(once), /already present/);
});

test('inventoryPatches returns one packed app-boot replacement', () => {
  const code = fixture();
  const bytes = Buffer.from(code, 'utf8');
  const archive = { buffer: bytes, dataOffset: 0 };
  const baseline = { files: { dsh: { files: { 'node_modules': { files: { '@deepseek-ai': { files: {
    'dsh-app-boot': { files: { lib: { files: { 'index.js': { offset: 0, size: bytes.length } } } } },
  } } } } } } } };
  const patches = inventoryPatches(archive, baseline);
  assert.equal(patches.length, 1);
  assert.equal(patches[0][0], 'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  assert.match(patches[0][1], /description-guarded metadata/);
});
