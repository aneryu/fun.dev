import { evaluateCommands } from "./document.js";
import { isDense } from "./dense.js";

// Local target coordinates are edited before skin/attachment evaluation.
export function createMorphEditor({ panel, store, selected, selection, author, preview, stop, writable, t, status }) {
  const section = document.createElement("details");
  section.dataset.section = "morph";
  section.innerHTML = `<summary data-morph-label="edMorphEditor"></summary>
    <label><span data-morph-label="edMorphTarget"></span><select data-morph="target"></select></label>
    <label><span data-morph-label="edMorphName"></span><input data-morph="name" value="detail" maxlength="64"></label>
    <div class="actions"><button data-morph-action="create"></button><button data-morph-action="copy"></button></div>
    <label class="check"><input type="checkbox" data-morph="whole"><span data-morph-label="edMorphWhole"></span></label>
    <p class="small muted" data-morph="selection"></p>
    <fieldset><legend data-morph-label="edMorphMove"></legend><div class="xyz" data-morph="move"></div></fieldset>
    <fieldset><legend data-morph-label="edMorphScale"></legend><div class="xyz" data-morph="scale"></div></fieldset>
    <div class="actions"><button data-morph-action="preview"></button><button data-morph-action="save"></button><button data-morph-action="restore"></button></div>
    <p class="small muted" data-morph-label="edMorphHint"></p>`;
  panel.append(section);
  const field = key => section.querySelector(`[data-morph="${key}"]`);
  const button = key => section.querySelector(`[data-morph-action="${key}"]`);
  let targetName = "", nodeId = "";
  for (const key of ["move", "scale"]) for (const axis of ["X", "Y", "Z"]) {
    const input = document.createElement("input");
    input.type = "number"; input.step = key === "move" ? ".001" : ".01"; input.value = key === "move" ? 0 : 1;
    if (key === "scale") input.min = ".001";
    input.setAttribute("aria-label", axis);
    field(key).append(input);
  }
  const node = p => p.nodes.find(n => n.id === selected());
  function indices(n) {
    if (field("whole").checked) return n.mesh.vertices.map((_, i) => i);
    const s = selection();
    return s.id === n.id && s.mode === "vertex" ? [...new Set(s.vertices ?? [])] : [];
  }
  function command() {
    const n = node(store.snapshot()), target = n?.morph?.targets.find(t => t.name === targetName);
    if (!target) throw new Error(t("edMorphChoose"));
    const picked = indices(n);
    if (!picked.length) throw new Error(t("edMorphPick"));
    const values = key => [...field(key).querySelectorAll("input")].map(el => Number(el.value));
    const move = values("move"), scale = values("scale");
    if (![...move, ...scale].every(Number.isFinite) || scale.some(v => v <= 0)) throw new Error(t("edMorphNumbers"));
    const positions = picked.map(i => n.morph.base[i].map((v, k) => v + target.deltas[i][k]));
    const center = [0, 1, 2].map(k => positions.reduce((sum, p) => sum + p[k], 0) / positions.length);
    return { op: "morphEdit", id: n.id, name: targetName, changes: positions.map((p, j) => ({
      index: picked[j], position: p.map((v, k) => center[k] + (v - center[k]) * scale[k] + move[k]),
    })) };
  }
  function show(edited = false) {
    stop();
    const p = edited ? evaluateCommands(store.snapshot(), [command()]) : store.snapshot(), n = node(p);
    if (!n?.morph?.targets.some(t => t.name === targetName)) throw new Error(t("edMorphChoose"));
    n.morph.weights = Object.fromEntries(n.morph.targets.map(t => [t.name, t.name === targetName ? 1 : 0]));
    if (p.character) {
      delete p.character.pose;
      p.character.values = Object.fromEntries(p.character.controls.map(c => [c.id, 0]));
      if (p.character.rest[n.id]) p.character.rest[n.id].weights = { ...n.morph.weights };
    }
    preview(p);
  }
  const safe = fn => () => { try { fn(); } catch (e) { status(e.message, true); } };
  field("target").onchange = safe(() => { stop(); targetName = field("target").value; show(); });
  field("whole").onchange = () => { field("selection").textContent = `${t("edMorphSelected")}: ${indices(node(store.snapshot())).length}`; };
  for (const copy of [false, true]) button(copy ? "copy" : "create").onclick = safe(() => {
    const n = node(store.snapshot()), name = field("name").value.trim();
    if (n.morph?.targets.some(t => t.name === name)) throw new Error(t("edMorphExists"));
    const target = n.morph?.targets.find(t => t.name === targetName);
    if (copy && !target) throw new Error(t("edMorphChoose"));
    const changes = copy ? n.morph.base.map((p, index) => ({ index, position: p.map((v, k) => v + target.deltas[index][k]) })) : [];
    targetName = name;
    author([{ op: "morphTarget", id: n.id, name, changes }]);
  });
  button("preview").onclick = safe(() => show(true));
  button("save").onclick = safe(() => { author([command()]); });
  button("restore").onclick = () => stop();
  section.addEventListener("toggle", e => { if (e.target === section && !section.open) stop(); });
  return {
    refresh() {
      const p = store.snapshot(), n = node(p);
      section.hidden = !n?.mesh || isDense(n.mesh) || !!n.instanceOf || !!n.symmetry || n.attachment?.mode === "deform";
      if (section.hidden) return;
      if (nodeId !== n.id) {
        nodeId = n.id; targetName = ""; field("whole").checked = false;
        for (const key of ["move", "scale"]) for (const input of field(key).querySelectorAll("input")) input.value = key === "move" ? 0 : 1;
      }
      section.querySelectorAll("[data-morph-label]").forEach(el => { el.textContent = t(el.dataset.morphLabel); });
      for (const [action, label] of Object.entries({ create: "edMorphCreate", copy: "edMorphCopy", preview: "edMorphPreview",
        save: "edMorphSave", restore: "edMorphRestore" })) button(action).textContent = t(label);
      const targets = n.morph?.targets ?? [];
      if (!targets.some(x => x.name === targetName)) targetName = targets[0]?.name ?? "";
      field("target").replaceChildren(...targets.map(x => new Option(x.name, x.name)));
      field("target").value = targetName;
      field("selection").textContent = `${t("edMorphSelected")}: ${indices(n).length}`;
      for (const action of ["copy", "preview", "save"]) button(action).disabled = !targetName || !writable();
      button("create").disabled = !writable();
    },
  };
}
