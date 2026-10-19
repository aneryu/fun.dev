// Adds a remote origin to every Content-Security-Policy in a Pages _headers file.
// Game files (the default) are scripts, data, images and media; the platform's own files on the
// asset origin are also stylesheets; the transfer API is only fetched.
const sourceDirectives = ["script-src", "connect-src", "img-src", "media-src"];
export const assetDirectives = ["script-src", "style-src", "connect-src", "img-src", "worker-src"];
export const apiDirectives = ["connect-src"];

export function addOriginToPolicy(policy, origin, names = sourceDirectives) {
  const directives = policy.split(";").map((part) => part.trim()).filter(Boolean);
  for (const name of names) {
    const index = directives.findIndex((directive) => directive.split(/\s+/)[0] === name);
    if (index === -1) directives.splice(directives.findIndex((directive) => directive.startsWith("base-uri")), 0, `${name} 'self' ${origin}`);
    else if (!directives[index].split(/\s+/).includes(origin)) directives[index] += ` ${origin}`;
  }
  return directives.join("; ");
}

export function addOriginToHeaders(source, origin, names = sourceDirectives) {
  return source.replace(/^(\s+Content-Security-Policy:\s*)(.+)$/gm, (_, prefix, policy) => prefix + addOriginToPolicy(policy, origin, names));
}
