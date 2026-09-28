// Small, non-evaluating recognizers for the stable parts of the bundled locale code.
export function codeMask(source) {
  const chars = source.split('');
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'line'; }
      else if (c === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i++; state = 'block'; }
      else if (c === '"' || c === "'" || c === '`') { chars[i] = ' '; state = c; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else if (c !== '\r') chars[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'code'; }
      else if (c !== '\n' && c !== '\r') chars[i] = ' ';
    } else if (c === '\\') {
      chars[i] = ' ';
      if (i + 1 < source.length) { if (source[i + 1] !== '\n' && source[i + 1] !== '\r') chars[i + 1] = ' '; i++; }
    } else if (c === state) {
      chars[i] = ' ';
      state = 'code';
    } else if (c !== '\n' && c !== '\r') chars[i] = ' ';
  }
  return chars.join('');
}

export function stripComments(source) {
  const chars = source.split('');
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'line'; }
      else if (c === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i++; state = 'block'; }
      else if (c === '"' || c === "'" || c === '`') state = c;
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else if (c !== '\r') chars[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'code'; }
      else if (c !== '\n' && c !== '\r') chars[i] = ' ';
    } else if (c === '\\') {
      i++;
    } else if (c === state) state = 'code';
  }
  return chars.join('');
}

function matchingDelimiter(mask, openAt, open, close) {
  if (mask[openAt] !== open) throw new Error(`Expected ${open} at offset ${openAt}`);
  let depth = 0;
  for (let i = openAt; i < mask.length; i++) {
    if (mask[i] === open) depth++;
    else if (mask[i] === close && --depth === 0) return i;
  }
  throw new Error(`Unterminated ${open}${close} structure`);
}

function uniqueMatch(source, mask, expression, label) {
  const matches = [...mask.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`${label} is missing or ambiguous`);
  return matches[0];
}

export function findObjectLiteral(source, name) {
  const mask = codeMask(source);
  const declaration = uniqueMatch(source, mask,
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`, 'g'), `${name} dictionary`);
  const open = declaration.index + declaration[0].lastIndexOf('{');
  const close = matchingDelimiter(mask, open, '{', '}');
  const bodyMask = mask.slice(open + 1, close);
  const body = source.slice(open + 1, close);
  const keys = [];
  let start = 0, braces = 0, brackets = 0, parens = 0;
  for (let i = 0; i <= bodyMask.length; i++) {
    const c = bodyMask[i];
    if (i === bodyMask.length || c === ',' && braces === 0 && brackets === 0 && parens === 0) {
      const segment = body.slice(start, i);
      if (segment.trim()) keys.push(readPropertyKey(segment));
      start = i + 1;
    } else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (c === '(') parens++;
    else if (c === ')') parens--;
  }
  if (keys.length === 0 || keys.some((key) => key === null) || new Set(keys).size !== keys.length) {
    throw new Error(`${name} dictionary keys are unsupported or duplicated`);
  }
  return { start: declaration.index, open, close, end: close + 1, keys };
}

function skipTrivia(text, index) {
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Unterminated comment in dictionary');
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function readQuotedKey(text, index) {
  const quote = text[index];
  let value = '';
  for (let i = index + 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) return { value, end: i + 1 };
    if (c !== '\\') { value += c; continue; }
    if (++i >= text.length) break;
    const escaped = text[i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (Object.hasOwn(simple, escaped)) value += simple[escaped];
    else if (escaped === 'x' || escaped === 'u') {
      const count = escaped === 'x' ? 2 : 4;
      const hex = text.slice(i + 1, i + 1 + count);
      if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) throw new Error('Invalid escaped dictionary key');
      value += String.fromCharCode(parseInt(hex, 16));
      i += count;
    } else value += escaped;
  }
  throw new Error('Unterminated quoted dictionary key');
}

function readPropertyKey(segment) {
  let i = skipTrivia(segment, 0), value;
  if (segment[i] === '"' || segment[i] === "'") {
    const parsed = readQuotedKey(segment, i);
    value = parsed.value;
    i = parsed.end;
  } else {
    const match = /^[A-Za-z_$][\w$]*/.exec(segment.slice(i));
    if (!match) return null;
    value = match[0];
    i += value.length;
  }
  i = skipTrivia(segment, i);
  return segment[i] === ':' ? value : null;
}

export function findFunction(source, name) {
  const mask = codeMask(source);
  const match = uniqueMatch(source, mask,
    new RegExp(`\\bfunction\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g'), `${name} function`);
  const open = match.index + match[0].lastIndexOf('{');
  const close = matchingDelimiter(mask, open, '{', '}');
  return { start: match.index, open, close, end: close + 1, body: source.slice(open + 1, close) };
}

export function hasBinding(source, name) {
  return new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(codeMask(source));
}

export function validateBaseLocaleResolver(fn) {
  const compact = stripComments(fn.body).replace(/\s+/g, '').replaceAll("'", '"');
  const known = /^returnlocale\.toLowerCase\(\)\.startsWith\("zh"\)\?\{id:"zh-CN",messages:zh\}:\{id:"en",messages:en\};?$/;
  if (!known.test(compact)) throw new Error('resolveDesktopLocale no longer has the known zh/en mapping');
}

export function findIfReturning(source, fn, target) {
  const mask = codeMask(source);
  const matches = [];
  const bodyMask = mask.slice(fn.open + 1, fn.close);
  const body = source.slice(fn.open + 1, fn.close);
  for (const match of bodyMask.matchAll(/\bif\s*\(/g)) {
    const open = fn.open + 1 + match.index + match[0].lastIndexOf('(');
    const close = matchingDelimiter(mask, open, '(', ')');
    const tail = mask.slice(close + 1, fn.close);
    const returnMatch = /^\s*return\s+resolveDesktopLocale\s*\(\s*(selected|primary)\s*\)\s*;/.exec(tail);
    if (!returnMatch || returnMatch[1] !== target) continue;
    matches.push({
      condition: source.slice(open + 1, close),
      conditionStart: open + 1,
      conditionEnd: close,
      callStart: close + 1,
      callEnd: close + 1 + returnMatch[0].length,
    });
  }
  if (matches.length !== 1) throw new Error(`${target} locale acceptance is missing or ambiguous`);
  return matches[0];
}

export function normalizeCondition(condition) {
  return condition.replace(/\s+/g, '').replaceAll("'", '"').replace(/[()]/g, '');
}

export function mergeRussian(enKeys, russian) {
  if (russian === null || typeof russian !== 'object' || Array.isArray(russian)) {
    throw new TypeError('Russian dictionary must be an object');
  }
  const known = new Set(enKeys);
  const merged = {};
  for (const [key, value] of Object.entries(russian)) {
    if (!known.has(key)) continue;
    if (typeof value !== 'string') throw new Error(`Russian translation for ${key} is not a string`);
    merged[key] = value;
  }
  if (Object.keys(merged).length === 0) throw new Error('Russian dictionary has no keys supported by this shell');
  return merged;
}

export function applyEdits(source, edits) {
  const ordered = [...edits].sort((a, b) => a.at - b.at || a.from.length - b.from.length);
  let cursor = 0, output = '';
  for (const edit of ordered) {
    if (edit.at < cursor || source.slice(edit.at, edit.at + edit.from.length) !== edit.from) {
      throw new Error('Patch anchors overlap or do not match the source');
    }
    output += source.slice(cursor, edit.at) + edit.to;
    cursor = edit.at + edit.from.length;
  }
  output += source.slice(cursor);

  let originalAt = 0, outputAt = 0;
  for (const edit of ordered) {
    const gap = edit.at - originalAt;
    if (source.slice(originalAt, originalAt + gap) !== output.slice(outputAt, outputAt + gap)) {
      throw new Error('Patch changed bytes outside its anchored edits');
    }
    originalAt += gap + edit.from.length;
    outputAt += gap + edit.to.length;
  }
  if (source.slice(originalAt) !== output.slice(outputAt)) throw new Error('Patch changed bytes after its last anchor');
  return output;
}

export function addRussianResolverGuard(source, fn, indent = '\t', quote = '"') {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const guard = `${nl}${indent}if (locale.toLowerCase().startsWith(${quote}ru${quote})) return {${nl}${indent}\tid: ${quote}ru${quote},${nl}${indent}\tmessages: ru${nl}${indent}};`;
  return { at: fn.open + 1, from: '', to: guard };
}
