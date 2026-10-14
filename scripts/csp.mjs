// Adds the remote game origin to every Content-Security-Policy in a Pages _headers file.
const sourceDirectives = ["script-src", "connect-src", "img-src", "media-src"];

export function addOriginToPolicy(policy, origin) {
  const directives = policy.split(";").map((part) => part.trim()).filter(Boolean);
  for (const name of sourceDirectives) {
    const index = directives.findIndex((directive) => directive.split(/\s+/)[0] === name);
    if (index === -1) directives.splice(directives.findIndex((directive) => directive.startsWith("base-uri")), 0, `${name} 'self' ${origin}`);
    else if (!directives[index].split(/\s+/).includes(origin)) directives[index] += ` ${origin}`;
  }
  return directives.join("; ");
}

export function addOriginToHeaders(source, origin) {
  return source.replace(/^(\s+Content-Security-Policy:\s*)(.+)$/gm, (_, prefix, policy) => prefix + addOriginToPolicy(policy, origin));
}
