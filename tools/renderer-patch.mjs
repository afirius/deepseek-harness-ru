import { entryFor, readPacked } from './shell-asar.mjs';
import {
  addRussianResolverGuard, applyEdits, findFunction, findObjectLiteral,
  hasBinding, mergeRussian, validateBaseLocaleResolver,
} from './patch-structure.mjs';

const targets = ['lib/preload-app.cjs', 'lib/preload-welcome.cjs'];
const fail = (path, message) => { throw new Error(`Unsupported renderer template ${path}: ${message}`); };

function patchRenderer(source, path, russian) {
  try {
    const en = findObjectLiteral(source, 'en');
    findObjectLiteral(source, 'zh');
    if (hasBinding(source, 'ru')) fail(path, 'a ru binding already exists');
    const locale = findFunction(source, 'resolveDesktopLocale');
    validateBaseLocaleResolver(locale);
    const overrides = mergeRussian(en.keys, russian);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const dictionary = `${newline}/* dsh-shell-ru: renderer locale */${newline}const ru = { ...en, ...${JSON.stringify(overrides, null, '\t')} };`;
    const declarationEnd = en.end + (source[en.end] === ';' ? 1 : 0);
    return applyEdits(source, [
      { at: declarationEnd, from: '', to: dictionary },
      addRussianResolverGuard(source, locale),
    ]);
  } catch (error) {
    if (error.message.startsWith(`Unsupported renderer template ${path}:`)) throw error;
    fail(path, error.message);
  }
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
