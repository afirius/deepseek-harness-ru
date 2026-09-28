import test from 'node:test';
import assert from 'node:assert/strict';
import { patchMain } from '../tools/shell-patch.mjs';
import { rendererPatches } from '../tools/renderer-patch.mjs';

const ru = { alpha: 'Альфа', beta: 'Бета', removedFromNewVersion: 'Старый ключ' };
const shellFixture = ({ newline = '\n', resolver = null, duplicateFunction = false } = {}) => {
  const baseResolver = resolver ?? `function resolveDesktopLocale ( locale ) {
  return locale.toLowerCase().startsWith('zh')
    ? { id: 'zh-CN', messages: zh }
    : { id: 'en', messages: en };
}`;
  return [
    baseResolver,
    duplicateFunction ? baseResolver : '',
    `const en = {\n  'alpha': 'Alpha', beta : 'Beta', addedByNewVersion: 'New'\n};`,
    `const zh = { alpha: '甲', beta: '乙' };`,
    `function resolveDesktopStartupLocale(selected) {\n  const languages = ['zh-CN', 'en'];\n  for (const language of languages) {\n    const primary = language.toLowerCase().split('-')[0];\n    if (selected === 'zh' || selected === 'en') return resolveDesktopLocale(selected);\n    if (primary === 'zh' || primary === 'en') return resolveDesktopLocale(primary);\n  }\n  return resolveDesktopLocale('en');\n}`,
  ].filter(Boolean).join(newline);
};

function packedRendererFixture(sourceForPath) {
  const parts = ['lib/preload-app.cjs', 'lib/preload-welcome.cjs'].map(sourceForPath);
  const offsets = [];
  let offset = 0;
  for (const text of parts) {
    const bytes = Buffer.from(text);
    offsets.push({ offset, size: bytes.length });
    offset += bytes.length;
  }
  const archive = { buffer: Buffer.concat(parts.map((text) => Buffer.from(text))), dataOffset: 0 };
  const baseline = { files: { lib: { files: {
    'preload-app.cjs': offsets[0], 'preload-welcome.cjs': offsets[1],
  } } } };
  return { archive, baseline };
}

const rendererSource = (newline = '\n', resolver = null) => [
  `const en = { alpha: 'Alpha', beta: 'Beta', addedByNewVersion: 'New' };`,
  `const zh = { alpha: '甲', beta: '乙' };`,
  resolver ?? `function resolveDesktopLocale(locale) {\n  return locale.toLowerCase().startsWith('zh') ? { id: 'zh-CN', messages: zh } : { id: 'en', messages: en };\n}`,
].join(newline);

test('shell patch accepts quote/whitespace/CRLF variants, preserves English fallback and inserts after en', () => {
  const source = shellFixture({ newline: '\r\n' });
  const patched = patchMain(source, ru);
  assert.ok(patched.includes('const ru = { ...en, ...'));
  assert.ok(patched.indexOf('const ru =') > patched.indexOf('const en ='));
  assert.ok(patched.includes('addedByNewVersion: \'New\''));
  assert.ok(patched.includes('selected === \'ru\''));
  assert.ok(patched.includes('primary === \'ru\''));
  assert.ok(!patched.includes('removedFromNewVersion'));
  assert.ok(patched.includes('id: "ru"'));
  // This is our tiny synthetic fixture, never code from the installed app.
  const api = new Function(patched + ';return {resolveDesktopLocale,resolveDesktopStartupLocale};')();
  assert.equal(api.resolveDesktopLocale('ru-RU').messages.alpha, 'Альфа');
  assert.equal(api.resolveDesktopLocale('ru').messages.addedByNewVersion, 'New');
  assert.equal(api.resolveDesktopLocale('en').messages.alpha, 'Alpha');
  assert.equal(api.resolveDesktopStartupLocale('ru').id, 'ru');
});

test('renderer patches both preload assets and filters obsolete dictionary keys', () => {
  const { archive, baseline } = packedRendererFixture(() => rendererSource('\r\n'));
  const patched = rendererPatches(archive, baseline, ru);
  assert.deepEqual(patched.map(([path]) => path), ['lib/preload-app.cjs', 'lib/preload-welcome.cjs']);
  for (const [, source] of patched) {
    assert.ok(source.includes('const ru = { ...en, ...'));
    assert.ok(source.includes('addedByNewVersion: \'New\''));
    assert.ok(source.includes('startsWith("ru")'));
    assert.ok(!source.includes('removedFromNewVersion'));
    const resolve = new Function(source + ';return resolveDesktopLocale;')();
    assert.equal(resolve('ru').messages.beta, 'Бета');
    assert.equal(resolve('ru').messages.addedByNewVersion, 'New');
    assert.equal(resolve('zh-CN').id, 'zh-CN');
  }
});

test('patchers reject an unknown base resolver before producing output', () => {
  const source = shellFixture({ resolver: `function resolveDesktopLocale(locale) { return locale || en; }` });
  assert.throws(() => patchMain(source, ru), /Unsupported|Неподдерживаемый/);
  const { archive, baseline } = packedRendererFixture(() => rendererSource('\n', `function resolveDesktopLocale(locale) { return locale || en; }`));
  assert.throws(() => rendererPatches(archive, baseline, ru), /Unsupported renderer template/);
});

test('patchers reject ambiguous resolver declarations and pre-existing ru bindings', () => {
  assert.throws(() => patchMain(shellFixture({ duplicateFunction: true }), ru), /Unsupported|Неподдерживаемый/);
  assert.throws(() => patchMain(shellFixture().replace('const zh =', 'const ru = {};\nconst zh ='), ru), /ru binding/);
  const { archive, baseline } = packedRendererFixture(() => rendererSource().replace('const zh =', 'let ru = {};\nconst zh ='));
  assert.throws(() => rendererPatches(archive, baseline, ru), /ru binding/);
});

test('shell patch rejects changed startup locale resolver logic', () => {
  const source = shellFixture().replace("if (primary === 'zh' || primary === 'en')", "if (primary === 'zh')");
  assert.throws(() => patchMain(source, ru), /acceptance condition changed/);
});
