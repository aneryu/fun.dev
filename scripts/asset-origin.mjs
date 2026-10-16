// With an asset origin, fun.dev itself serves only documents (HTML, the service worker and the
// manifest); every file a page loads comes from the asset origin, the same Pages project on a
// Cloudflare hostname. Module imports are root-relative, so once a page's entry scripts load from
// the asset origin, everything they import does too.

// Stylesheets, icons and scripts referenced by root-relative URLs in a page. The manifest stays
// on the site: its start_url and scope must be same-origin with the pages.
export function assetHTML(html, origin) {
  return html
    .replace(/(<script\b[^>]*?\ssrc=")(\/[^/"][^"]*")/g, `$1${origin}$2`)
    .replace(/<link\b[^>]*>/g, (tag) => /\srel="(?:stylesheet|icon|apple-touch-icon)"/.test(tag) ? tag.replace(/(\shref=")(\/[^/"][^"]*")/, `$1${origin}$2`) : tag);
}

export function assetManifest(source, origin) {
  const manifest = JSON.parse(source);
  for (const icon of manifest.icons ?? []) if (icon.src.startsWith("/")) icon.src = origin + icon.src;
  return JSON.stringify(manifest, null, 2) + "\n";
}

// Module scripts and the service worker's precache fetch these files with CORS.
export function assetHeaders(origin, site) {
  return `\n# Platform files for pages on ${site} (module scripts and the service worker fetch with CORS).\n${origin}/*\n  Access-Control-Allow-Origin: ${site}\n`;
}
