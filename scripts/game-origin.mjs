// Build-time origins: a public HTTPS origin, or "" for same-origin.
export function publicOrigin(value = "", name = "FUNDEV_GAME_ORIGIN") {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith(".localhost")) {
    throw new Error(`${name} must be a public HTTPS origin without path, credentials or port.`);
  }
  return url.origin;
}

export const gameOrigin = (value) => publicOrigin(value, "FUNDEV_GAME_ORIGIN");
