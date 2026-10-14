// The subset of Pages _headers used by this static site: paths, trailing splats,
// host-qualified rules, duplicate values and header detachment. No placeholders.
export function parseHeaders(source) {
  const rules = [];
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('/') || line.startsWith('https://')) rules.push({path:line.trim(),entries:[]});
    else if (line.trimStart().startsWith('! ')) rules.at(-1).entries.push([line.trim().slice(2).toLowerCase(),null]);
    else {
      const colon = line.indexOf(':');
      if (colon < 0 || !rules.length) throw new Error('Invalid _headers line');
      rules.at(-1).entries.push([line.slice(0,colon).trim().toLowerCase(),line.slice(colon+1).trim()]);
    }
  }
  return rules;
}
export function headersFor(rules,path,origin = "http://127.0.0.1:8000") {
  const result = {};
  for (const rule of rules) {
    let pattern = rule.path;
    if (pattern.startsWith('https://')) {
      const url = new URL(pattern);
      if (url.hostname !== new URL(origin).hostname) continue;
      pattern = url.pathname;
    }
    if (pattern !== path && !(pattern.endsWith('*') && path.startsWith(pattern.slice(0,-1)))) continue;
    for (const [key,value] of rule.entries) {
      if (value === null) delete result[key];
      else result[key] = result[key] ? `${result[key]}, ${value}` : value;
    }
  }
  return result;
}
