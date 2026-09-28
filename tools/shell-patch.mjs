// Russian shell code builder; it never writes files.
export function patchMain(shippedMain, russian) {
const MARKER = '/* dsh-shell-ru: injected Russian locale */';
const enKeys = [...shippedMain
  .slice(shippedMain.indexOf('const en = {'), shippedMain.indexOf('\n};', shippedMain.indexOf('const en = {')))
  .matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
const missing = enKeys.filter((key) => !(key in russian));
const extra = Object.keys(russian).filter((key) => !enKeys.includes(key));
if (missing.length || extra.length) {
  console.error(`dictionary mismatch: missing ${missing.length}${missing.length ? ` (${missing.slice(0, 8).join(', ')})` : ''}, extra ${extra.length}${extra.length ? ` (${extra.slice(0, 8).join(', ')})` : ''}`);
  throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
}

// ---- build the patched main.js -------------------------------------------
// A probe, off unless asked for, records which copy the shell loaded — the only
// way to observe that inside a GUI process.
const probe = `/* dsh-shell-ru: startup probe */
if (process.env.DSH_SHELL_LOCALE_PROBE) {
	try {
		(await import("node:fs")).writeFileSync(process.env.DSH_SHELL_LOCALE_PROBE, "loaded: " + fileURLToPath(import.meta.url) + "\\n" + new Date().toISOString() + "\\n");
	} catch {}
}
`;
const dictionaryBlock = `${MARKER}\n${probe}const ru = ${JSON.stringify(russian, null, '\t')};\n`;

// Always rebuild from the shipped copy, never from a previous patch, so running
// this twice cannot stack changes. Edits are recorded as (position, replaced
// text) pairs so the untouched remainder can be proven byte-identical.
const edits = [];
{
  const localeRegion = shippedMain.indexOf('//#region lib/types/locale.js');
  if (localeRegion < 0) { console.error('cannot locate the locale region'); throw new Error('Шаблон оболочки не соответствует поддерживаемой версии'); }
  const nextRegion = shippedMain.indexOf('//#region', shippedMain.indexOf('\n};', shippedMain.indexOf('const zh = {')));
  const at = nextRegion > 0 ? nextRegion : localeRegion;
  edits.push({ at, from: '', to: dictionaryBlock });
}

const replacements = [
  [
    `function resolveDesktopLocale(locale) {
	return locale.toLowerCase().startsWith("zh") ? {
		id: "zh-CN",
		messages: zh
	} : {
		id: "en",
		messages: en
	};
}`,
    `function resolveDesktopLocale(locale) {
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
}`,
  ],
  [
    `	if (selected === "zh" || selected === "en") return resolveDesktopLocale(selected);
	for (const language of languages) {
		const primary = language.toLowerCase().split("-")[0];
		if (primary === "zh" || primary === "en") return resolveDesktopLocale(primary);
	}
	return resolveDesktopLocale("en");`,
    `	if (selected === "zh" || selected === "en" || selected === "ru") return resolveDesktopLocale(selected);
	for (const language of languages) {
		const primary = language.toLowerCase().split("-")[0];
		if (primary === "zh" || primary === "en" || primary === "ru") return resolveDesktopLocale(primary);
	}
	return resolveDesktopLocale("en");`,
  ],
];
for (const [from, to] of replacements) {
  const at = shippedMain.indexOf(from);
  if (at < 0) {
    console.error('the shipped locale resolver does not match the expected shape; the shell may have changed');
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
  if (shippedMain.indexOf(from, at + 1) >= 0) {
    console.error('a resolver pattern matches in more than one place; refusing an ambiguous patch');
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
  edits.push({ at, from, to });
}

// Apply the edits back to front so earlier positions stay valid.
const ordered = [...edits].sort((a, b) => b.at - a.at);
let patched = shippedMain;
for (const edit of ordered) {
  const before = patched.slice(0, edit.at);
  const after = patched.slice(edit.at + edit.from.length);
  patched = before + edit.to + after;
}

// Prove the patch is exactly these edits: walk both texts together, skipping the
// replaced regions, and require everything else to be identical.
{
  const sorted = [...edits].sort((a, b) => a.at - b.at);
  let shippedAt = 0;
  let patchedAt = 0;
  const mismatches = [];
  for (const edit of sorted) {
    const gap = edit.at - shippedAt;
    const shippedChunk = shippedMain.slice(shippedAt, shippedAt + gap);
    const patchedChunk = patched.slice(patchedAt, patchedAt + gap);
    if (shippedChunk !== patchedChunk) mismatches.push({ at: shippedAt, shippedChunk, patchedChunk });
    shippedAt += gap + edit.from.length;
    patchedAt += gap + edit.to.length;
  }
  const tailShipped = shippedMain.slice(shippedAt);
  const tailPatched = patched.slice(patchedAt);
  if (tailShipped !== tailPatched) mismatches.push({ at: shippedAt, shippedChunk: tailShipped.slice(0, 120), patchedChunk: tailPatched.slice(0, 120) });

  if (mismatches.length > 0) {
    console.error(`the patch changed ${mismatches.length} region(s) outside the intended edits; refusing to install`);
    for (const mismatch of mismatches.slice(0, 3)) {
      console.error(`  at ${mismatch.at}`);
      console.error(`    shipped: ${JSON.stringify(mismatch.shippedChunk)}`);
      console.error(`    patched: ${JSON.stringify(mismatch.patchedChunk)}`);
    }
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
  console.log(`edits verified: ${sorted.length} region(s), everything else byte-identical`);
}
if (!patched.includes('const ru = {') || !patched.includes('messages: ru')) {
  console.error('patch validation failed: the Russian dictionary was not wired in');
  throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
}

{
  const literal = /\nconst ru = (\{[\s\S]*?\n\});\n/.exec(patched);
  if (literal === null) { console.error('the Russian dictionary block was not emitted'); throw new Error('Шаблон оболочки не соответствует поддерживаемой версии'); }
  let roundTripped;
  try {
    roundTripped = JSON.parse(literal[1]);
  } catch (error) {
    console.error(`the emitted dictionary is not valid JSON: ${error.message}`);
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
  if (Object.keys(roundTripped).length !== Object.keys(russian).length) {
    console.error('the emitted dictionary lost keys in serialization');
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
  const ruResolvers = (patched.match(/messages: ru/g) ?? []).length;
  const ruAccept = (patched.match(/selected === "ru"/g) ?? []).length;
  if (ruResolvers !== 1 || ruAccept !== 1) {
    console.error(`resolver wiring looks wrong: ${ruResolvers} dictionary references, ${ruAccept} startup acceptances`);
    throw new Error('Шаблон оболочки не соответствует поддерживаемой версии');
  }
}


return patched;
}
