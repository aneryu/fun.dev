// Studio interface text in Chinese and English. Block, primitive and swatch names are looked up by
// id here, so the engine's data (and the exported SDF JSON) stay the same in both languages.
import { detectLocale } from "./locale.js";

export const TEXT = {
  zh: {
    pageTitle: "fun.dev · SDF 低模造物台",
    homeAria: "返回首页",
    headerTitle: "SDF 低模造物台",
    headerSub: "澡盆小鸭 · 实时 SDF 积木拼装与网格烘焙工作台",
    canvasAria: "澡盆小鸭 3D 视图",
    dockAria: "SDF 积木编辑器面板",
    assetTitle: "澡盆小鸭",
    reset: "↺ 重置",
    resetTitle: "重置澡盆小鸭",
    exportGltf: "导出 .gltf",
    exportTitle: "导出标准 3D 模型",
    copyJson: "复制 SDF JSON",
    copyTitle: "复制当前 SDF 积木配置 JSON",
    copied: "已复制 ✓",
    viewSource: "</> 源码",
    sourceTitle: "查看 SDF 积木与 WGSL 源码",
    hint: "拖拽八面体移动积木 · 拖动背景或方向键旋转 · 滚轮或 +/− 缩放",
    dialogTitle: "原生 WGSL 着色器源码",
    dialogDesc: "当前物件的实时 WGSL 着色器，由 fun.dev 原生 WebGPU 内核驱动编译运行。",
    close: "关闭",
    unsupported: "不支持",
    modeSmooth: "✨ 丝滑高精",
    modeLowpoly: "💎 晶面低模",
    modeCrowd: "🚀 36实例同屏",
    voxel: "网格粒度 ({v})",
    statsCrowd: "36 实例 · {t} 面",
    stats: "{t} 面 · {v} 顶点",
    layers: "原子积木图层 ({n})",
    tagSubtract: "➖挖孔",
    tagMirror: "↔镜像",
    editing: "编辑：{name}",
    delete: "🗑️ 删除",
    union: "➕ 融合",
    subtract: "➖ 挖孔",
    mirror: "↔ 对称",
    blend: "融合k",
    round: "倒角r",
    posX: "位置X", posY: "位置Y", posZ: "位置Z",
    sizeX: "尺寸X", sizeY: "尺寸Y", sizeZ: "尺寸Z",
    newBlock: "新{type} #{n}",
  },
  en: {
    pageTitle: "fun.dev · SDF Low-Poly Studio",
    homeAria: "Back to the homepage",
    headerTitle: "SDF Low-Poly Studio",
    headerSub: "Bath duck · build with SDF blocks, bake live meshes",
    canvasAria: "Bath duck 3D view",
    dockAria: "SDF block editor",
    assetTitle: "Bath Duck",
    reset: "↺ Reset",
    resetTitle: "Reset the bath duck",
    exportGltf: "Export .gltf",
    exportTitle: "Export a standard 3D model",
    copyJson: "Copy SDF JSON",
    copyTitle: "Copy the current SDF blocks as JSON",
    copied: "Copied ✓",
    viewSource: "</> Source",
    sourceTitle: "View the SDF blocks and WGSL source",
    hint: "Drag the octahedron to move a block · drag or arrow keys to orbit · wheel or +/− to zoom",
    dialogTitle: "WGSL shader source",
    dialogDesc: "The live WGSL shader for this object, compiled and run by fun.dev's native WebGPU kernel.",
    close: "Close",
    unsupported: "Unsupported",
    modeSmooth: "✨ Smooth",
    modeLowpoly: "💎 Low-poly",
    modeCrowd: "🚀 36 ducks",
    voxel: "Grain ({v})",
    statsCrowd: "36 copies · {t} tris",
    stats: "{t} tris · {v} verts",
    layers: "SDF blocks ({n})",
    tagSubtract: "➖cut",
    tagMirror: "↔mirror",
    editing: "Editing: {name}",
    delete: "🗑️ Delete",
    union: "➕ Blend",
    subtract: "➖ Cut",
    mirror: "↔ Mirror",
    blend: "Blend",
    round: "Round",
    posX: "Pos X", posY: "Pos Y", posZ: "Pos Z",
    sizeX: "Size X", sizeY: "Size Y", sizeZ: "Size Z",
    newBlock: "New {type} #{n}",
  },
};

export const NAMES = {
  en: {
    block: {
      duckBody: "Round body",
      duckHead: "Plump head",
      duckBeak: "Orange beak",
      duckEyes: "Shiny eyes",
      duckWings: "Little wings",
      duckTail: "Perky tail",
      waterPool: "Blue water",
      tubOuter: "Ceramic tub wall",
      tubInner: "Tub hollow (cut)",
      tubRim: "Rounded tub rim",
    },
    prim: {
      sphere: "Ball",
      ellipsoid: "Egg",
      roundBox: "Box",
      cylinder: "Can",
      capsule: "Pill",
      torus: "Ring",
    },
    swatch: {
      yellow: "Duck yellow",
      orange: "Beak orange",
      cream: "Ceramic white",
      cyan: "Water blue",
      coral: "Coral",
      navy: "Deep navy",
      ink: "Obsidian",
    },
  },
};

export const locale = detectLocale();

export function t(key, vars = {}) {
  const s = TEXT[locale][key] ?? TEXT.zh[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// Preset blocks have translated names; blocks the user adds were named in the language they were
// added in and keep that name.
export function blockLabel(block) {
  return NAMES[locale]?.block[block.id] ?? block.label;
}

export function primLabel(prim) {
  return NAMES[locale]?.prim[prim.id] ?? prim.label;
}

export function swatchLabel(swatch) {
  return NAMES[locale]?.swatch[swatch.id] ?? swatch.label;
}

// Static markup: data-i18n sets text, data-i18n-aria the aria-label, data-i18n-title the title.
export function applyStaticText(root = document) {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.title = t("pageTitle");
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
}
