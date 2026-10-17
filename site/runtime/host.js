import * as THREE from "./three.js";
import { gameOrigin } from "../game-source.js";
import { createGameHost as createHost } from "/runtime/core/host.js";
import { getLocale, onLocaleChange, t } from "../i18n.js";

// ?renderer=webgpu or ?renderer=webgl overrides the automatic choice, to compare them on a device.
const requested = new URLSearchParams(window.location.search).get("renderer");
const renderer = ["webgpu", "webgl"].includes(requested) ? requested : "auto";

export function createGameHost(options) {
  const host = createHost({ ...options, THREE, renderer, bundleOrigin: gameOrigin || window.location.origin, locale: getLocale(), canvasLabel: t("canvas") });
  const unsubscribe = onLocaleChange((locale) => host.setLocale(locale, t("canvas")));
  return { ...host, dispose() { unsubscribe(); host.dispose(); } };
}
