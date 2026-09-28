import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entryFor, readPacked } from './shell-asar.mjs';
import { applyEdits, codeMask, findFunction, hasBinding, stripComments } from './patch-structure.mjs';

const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
const MARKER = 'dsh-inventory-meta-ru: description-guarded metadata';
const META = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../payload/plugin-meta-ru.json', import.meta.url)), 'utf8'));
const fail = (reason) => { throw new Error(`Unsupported plugin metadata template: ${reason}`); };

function unique(regex, text, label) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`);
  return matches[0];
}

/** Patch only a synthetic or bundled readPluginMeta function; never evaluates its source. */
export function patchInventorySource(source, meta = META) {
  try {
    if (source.includes(MARKER)) fail('Russian metadata patch is already present');
    const fn = findFunction(source, 'readPluginMeta');
    if (hasBinding(source, '__dshInventoryRussianPackages')) fail('translation map binding already exists');
    const live = source.slice(fn.open + 1, fn.close);
    const liveNoComments = stripComments(live);
    const bodyOffset = fn.open + 1;
    const titleDecl = unique(/\bconst\s+title\s*=\s*localizedText\s*\(\s*["']title["']\s*,\s*dictionaries\s*,\s*fallbackText\s*\(\s*manifest\s*\?\.name\s*\)\s*,\s*specifier\s*\)\s*;/g, liveNoComments, 'title fallback');
    const descriptionDecl = unique(/\bconst\s+description\s*=\s*localizedText\s*\(\s*["']description["']\s*,\s*dictionaries\s*,\s*fallbackText\s*\(\s*manifest\s*\?\.description\s*\)\s*,\s*["']["']\s*\)\s*;/g, liveNoComments, 'description fallback');
    if (titleDecl.index >= descriptionDecl.index) fail('metadata fallback order changed');

    const code = codeMask(source);
    const textDecl = unique(/\bconst\s+text\s*=\s*\{/g, code.slice(bodyOffset, fn.close), 'metadata result object');
    const textAt = bodyOffset + textDecl.index;
    const titleProperty = unique(/\.\.\.title\s*===\s*void\s+0\s*\?\s*\{\s*\}\s*:\s*\{\s*title\s*\}/g, liveNoComments.slice(textDecl.index), 'localized title result');
    const descriptionProperty = unique(/\.\.\.description\s*===\s*void\s+0\s*\?\s*\{\s*\}\s*:\s*\{\s*description\s*\}/g, liveNoComments.slice(textDecl.index), 'localized description result');
    if (titleProperty.index >= descriptionProperty.index) fail('metadata result field order changed');

    for (const [name, item] of Object.entries(meta)) {
      if (!/^@deepseek-ai\/[a-z0-9-]+$/.test(name) || !item || typeof item !== 'object' ||
          typeof item.englishDescription !== 'string' || typeof item.title !== 'string' ||
          typeof item.description !== 'string') fail(`invalid translation record for ${name}`);
    }

    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const indent = /^\s*/.exec(source.slice(0, bodyOffset + titleDecl.index).split(/\r?\n/).at(-1))[0];
    const insertedMap = `/* ${MARKER} */${newline}const __dshInventoryRussianPackages = ${JSON.stringify(meta, null, '\t')};${newline}`;
    const localCode = [
      `const __dshInventoryRussianMeta = Object.hasOwn(__dshInventoryRussianPackages, specifier) && fallbackText(manifest?.description) === __dshInventoryRussianPackages[specifier].englishDescription ? __dshInventoryRussianPackages[specifier] : void 0;`,
      `const __dshInventoryRussianTitle = __dshInventoryRussianMeta?.title === void 0 ? title : typeof title === "object" && title !== null ? { ...title, ru: __dshInventoryRussianMeta.title } : { en: title ?? specifier, ru: __dshInventoryRussianMeta.title };`,
      `const __dshInventoryRussianDescription = __dshInventoryRussianMeta?.description === void 0 ? description : typeof description === "object" && description !== null ? { ...description, ru: __dshInventoryRussianMeta.description } : { en: description ?? "", ru: __dshInventoryRussianMeta.description };`,
    ].map((line) => indent + line).join(newline) + newline;

    const titleFrom = titleProperty[0];
    const descriptionFrom = descriptionProperty[0];
    const edits = [
      { at: fn.start, from: '', to: insertedMap },
      { at: bodyOffset + textDecl.index, from: '', to: localCode },
      {
        at: bodyOffset + textDecl.index + titleProperty.index,
        from: titleFrom,
        to: titleFrom.replace(/\{\s*title\s*\}$/, '{ title: __dshInventoryRussianTitle }'),
      },
      {
        at: bodyOffset + textDecl.index + descriptionProperty.index,
        from: descriptionFrom,
        to: descriptionFrom.replace(/\{\s*description\s*\}$/, '{ description: __dshInventoryRussianDescription }'),
      },
    ];
    return applyEdits(source, edits);
  } catch (error) {
    if (error.message.startsWith('Unsupported plugin metadata template:')) throw error;
    fail(error.message);
  }
}

/** Return the guarded app-boot metadata patch expected by the installer. */
export function inventoryPatches(archive, baseline) {
  const entry = entryFor(baseline, TARGET.split('/'));
  if (!entry || entry.unpacked) throw new Error(`Missing packed plugin metadata source: ${TARGET}`);
  const source = readPacked(archive, entry).toString('utf8');
  return [[TARGET, patchInventorySource(source)]];
}
