import {
  addRussianResolverGuard, applyEdits, findFunction, findIfReturning,
  findObjectLiteral, hasBinding, mergeRussian, normalizeCondition,
  stripComments, validateBaseLocaleResolver,
} from './patch-structure.mjs';

const fail = (message) => { throw new Error(`Неподдерживаемый шаблон оболочки: ${message}`); };

function conditionTerms(condition, name) {
  const terms = normalizeCondition(condition).split('||');
  const valid = new Set([`${name}==="zh"`, `${name}==="en"`]);
  if (terms.length !== 2 || terms.some((term) => !valid.has(term)) || new Set(terms).size !== 2) {
    fail(`the ${name} acceptance condition changed`);
  }
}

function startupEdits(source, fn) {
  const compact = stripComments(fn.body).replace(/\s+/g, '').replaceAll("'", '"');
  if (!/for\((?:const|let|var)languageoflanguages\)/.test(compact) ||
      !/primary=language\.toLowerCase\(\)\.split\("-"\)\[0\]/.test(compact) ||
      !/returnresolveDesktopLocale\("en"\);/.test(compact)) {
    fail('resolveDesktopStartupLocale loop or fallback changed');
  }
  if (/selected===['"]ru['"]|primary===['"]ru['"]/.test(compact)) {
    fail('resolveDesktopStartupLocale already contains Russian handling');
  }

  const selected = findIfReturning(source, fn, 'selected');
  const primary = findIfReturning(source, fn, 'primary');
  conditionTerms(selected.condition, 'selected');
  conditionTerms(primary.condition, 'primary');
  const quote = selected.condition.includes("'") ? "'" : '"';
  return [
    { at: selected.conditionEnd, from: '', to: ` || selected === ${quote}ru${quote}` },
    { at: primary.conditionEnd, from: '', to: ` || primary === ${quote}ru${quote}` },
  ];
}

/** Build the main-process locale patch without evaluating or writing application code. */
export function patchMain(shippedMain, russian) {
  try {
    const en = findObjectLiteral(shippedMain, 'en');
    findObjectLiteral(shippedMain, 'zh');
    if (hasBinding(shippedMain, 'ru')) fail('a ru binding already exists');
    const locale = findFunction(shippedMain, 'resolveDesktopLocale');
    validateBaseLocaleResolver(locale);
    const startup = findFunction(shippedMain, 'resolveDesktopStartupLocale');
    const overrides = mergeRussian(en.keys, russian);
    const localeGuard = addRussianResolverGuard(shippedMain, locale);
    const dictionary = `${shippedMain.includes('\r\n') ? '\r\n' : '\n'}/* dsh-shell-ru: injected Russian locale */${shippedMain.includes('\r\n') ? '\r\n' : '\n'}const ru = { ...en, ...${JSON.stringify(overrides, null, '\t')} };`;
    const declarationEnd = en.end + (shippedMain[en.end] === ';' ? 1 : 0);
    const edits = [
      { at: declarationEnd, from: '', to: dictionary },
      localeGuard,
      ...startupEdits(shippedMain, startup),
    ];
    return applyEdits(shippedMain, edits);
  } catch (error) {
    if (error.message.startsWith('Неподдерживаемый шаблон оболочки:')) throw error;
    fail(error.message);
  }
}
