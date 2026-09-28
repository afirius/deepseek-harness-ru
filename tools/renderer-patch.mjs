import { entryFor, readPacked } from './shell-asar.mjs';

const targets = [
  'lib/preload-app.cjs',
  'lib/preload-welcome.cjs',
];

function keySet(source, name) {
  const anchor = `const ${name} = {`;
  if (source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error(`Renderer template has an ambiguous ${name} dictionary`);
  }
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`Renderer template has no ${name} dictionary`);
  const end = source.indexOf('\n};', start + anchor.length);
  if (end < 0) throw new Error(`Renderer ${name} dictionary is unterminated`);
  const matches = [...source.slice(start + anchor.length, end)
    .matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)];
  const keys = matches.map((match) => match[1]);
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error(`Renderer ${name} dictionary keys are invalid`);
  }
  return keys;
}

function patchRenderer(source, path, russian) {
  const enKeys = keySet(source, 'en');
  const missing = enKeys.filter((key) => !Object.hasOwn(russian, key));
  const extra = Object.keys(russian).filter((key) => !enKeys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${path} Russian dictionary mismatch: missing ${missing.length}, extra ${extra.length}`);
  }
  if (Object.values(russian).some((value) => typeof value !== 'string')) {
    throw new Error(`${path} Russian dictionary values must be strings`);
  }

  const anchor = 'function resolveDesktopLocale(locale) {';
  if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error(`${path} locale resolver anchor is missing or ambiguous`);
  }
  if (source.includes('const ru = {') || /messages:\s*ru\b/.test(source)) {
    throw new Error(`${path} already contains a Russian locale patch`);
  }

  const from = `function resolveDesktopLocale(locale) {
	return locale.toLowerCase().startsWith("zh") ? {
		id: "zh-CN",
		messages: zh
	} : {
		id: "en",
		messages: en
	};
}`;
  const to = `function resolveDesktopLocale(locale) {
	if (locale.toLowerCase().startsWith("ru")) return {
		id: "ru",
		messages: ru
	};
	return locale.toLowerCase().startsWith("zh") ? {
		id: "zh-CN",
		messages: zh
	} : {
		id: "en",
		messages: en
	};
}`;
  if (source.indexOf(from) < 0 || source.indexOf(from) !== source.lastIndexOf(from)) {
    throw new Error(`${path} locale resolver shape is unsupported`);
  }

  const dictionary = `/* dsh-shell-ru: renderer locale */\nconst ru = ${JSON.stringify(russian, null, '\t')};\n`;
  let patched = source.replace(from, to);
  const insertAt = patched.indexOf(anchor);
  patched = patched.slice(0, insertAt) + dictionary + patched.slice(insertAt);

  const emitted = /\/\* dsh-shell-ru: renderer locale \*\/\nconst ru = (\{[\s\S]*?\n\});\n/.exec(patched);
  if (!emitted || JSON.stringify(JSON.parse(emitted[1])) !== JSON.stringify(russian)) {
    throw new Error(`${path} Russian dictionary serialization did not round-trip`);
  }
  if ((patched.match(/messages: ru\b/g) ?? []).length !== 1 ||
      (patched.match(/if \(locale\.toLowerCase\(\)\.startsWith\("ru"\)\)/g) ?? []).length !== 1) {
    throw new Error(`${path} Russian resolver wiring is invalid`);
  }
  return patched;
}

/** Return renderer-side locale patches from packed baseline ASAR entries. */
export function rendererPatches(archive, baseline, russian) {
  if (russian === null || typeof russian !== 'object' || Array.isArray(russian)) {
    throw new TypeError('Russian dictionary must be a JSON object');
  }
  return targets.map((path) => {
    const entry = entryFor(baseline, path.split('/'));
    if (!entry || entry.unpacked) throw new Error(`Missing packed renderer asset: ${path}`);
    const source = readPacked(archive, entry).toString('utf8');
    return [path, patchRenderer(source, path, russian)];
  });
}
