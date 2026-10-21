import { evaluateCommands } from "./document.js";
import { isDense } from "./dense.js";

// The same skin commands serve numeric manual edits and external agents.
export function createSkinEditor({ panel, store, selected, selection, author, preview, stop, writable, t, status }) {
  const section = document.createElement("details");
  section.dataset.section = "skin";
  section.innerHTML = `<summary data-skin-label="edSkinEditor"></summary>
    <label><span data-skin-label="edSkinJoints"></span><select data-skin="joints" multiple size="4"></select></label>
    <p class="small muted" data-skin="state"></p>
    <fieldset><legend data-skin-label="edSkinInfluences"></legend><div data-skin="weights"></div></fieldset>
    <button data-skin-action="normalize"></button>
    <label class="check"><input type="checkbox" data-skin="whole"><span data-skin-label="edSkinWhole"></span></label>
    <p class="small muted" data-skin="selection"></p>
    <div class="actions"><button data-skin-action="preview"></button><button data-skin-action="save"></button><button data-skin-action="restore"></button></div>
    <div class="actions"><button data-skin-action="bind"></button><button data-skin-action="unbind"></button></div>
    <p class="small muted" data-skin-label="edSkinHint"></p>`;
  panel.append(section);
  const field = name => section.querySelector(`[data-skin="${name}"]`);
  const button = name => section.querySelector(`[data-skin-action="${name}"]`);
  let nodeId = "";
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("label"), select = document.createElement("select"), input = document.createElement("input");
    select.setAttribute("aria-label", `Joint ${i + 1}`);
    input.setAttribute("aria-label", `Weight ${i + 1}`);
    input.type = "number"; input.min = 0; input.max = 1; input.step = ".01";
    row.append(select, input); field("weights").append(row); rows.push({ select, input });
  }
  const node = () => store.snapshot().nodes.find(n => n.id === selected());
  const indices = n => field("whole").checked ? n.mesh.vertices.map((_, i) => i) :
    selection().id === n.id && selection().mode === "vertex" ? [...new Set(selection().vertices ?? [])] : [];
  const safe = fn => () => { try { fn(); } catch (e) { status(e.message, true); } };
  function influences() {
    const values = rows.filter(r => r.select.value && Number(r.input.value) !== 0)
      .map(r => ({ joint: r.select.value, weight: Number(r.input.value) }));
    const sum = values.reduce((s, w) => s + w.weight, 0);
    if (!values.length || new Set(values.map(w => w.joint)).size !== values.length ||
        values.some(w => !Number.isFinite(w.weight) || w.weight <= 0 || w.weight > 1) || Math.abs(sum - 1) > 1e-6)
      throw new Error(`${t("edSkinSum")}: ${sum}`);
    return values;
  }
  function command(bind = false) {
    const n = node();
    if (bind) {
      const joints = [...field("joints").selectedOptions].map(o => o.value);
      if (!joints.length) throw new Error(t("edSkinPickJoints"));
      const initial = n.skin ? null : influences();
      const weights = n.skin ? n.skin.weights.map((ws, index) => ({
        index, influences: ws.map(w => ({ joint: n.skin.joints[w.joint], weight: w.weight })),
      })) : n.mesh.vertices.map((_, index) => ({ index, influences: initial }));
      return { op: "skinBind", id: n.id, joints, weights };
    }
    const picked = indices(n);
    if (!picked.length) throw new Error(t("edMorphPick"));
    const ws = influences();
    return { op: "skinWeights", id: n.id, weights: picked.map(index => ({ index, influences: ws })) };
  }
  button("normalize").onclick = safe(() => {
    const active = rows.filter(r => r.select.value), sum = active.reduce((s, r) => s + Number(r.input.value), 0);
    if (!Number.isFinite(sum) || sum <= 0 || active.some(r => Number(r.input.value) < 0)) throw new Error(t("edSkinSum"));
    for (const r of active) r.input.value = Number(r.input.value) / sum;
  });
  button("preview").onclick = safe(() => { stop(); preview(evaluateCommands(store.snapshot(), [command()])); });
  button("save").onclick = safe(() => author([command()]));
  button("bind").onclick = safe(() => author([command(true)]));
  button("unbind").onclick = safe(() => author([{ op: "skinUnbind", id: node().id }]));
  button("restore").onclick = () => stop();
  field("whole").onchange = () => { field("selection").textContent = `${t("edMorphSelected")}: ${indices(node()).length}`; };
  section.addEventListener("toggle", e => { if (e.target === section && !section.open) stop(); });
  return {
    refresh() {
      const p = store.snapshot(), n = node();
      section.hidden = !n?.mesh || isDense(n.mesh) || !!n.instanceOf || !!n.symmetry || !!n.attachment;
      if (section.hidden) return;
      if (nodeId !== n.id) { nodeId = n.id; field("whole").checked = false; }
      const joints = p.nodes.filter(n => n.joint).map(n => n.id);
      field("joints").replaceChildren(...joints.map(id => new Option(id, id, false, n.skin?.joints.includes(id))));
      const picked = indices(n), first = n.skin?.weights[picked[0] ?? 0] ?? [];
      for (const [i, row] of rows.entries()) {
        row.select.replaceChildren(new Option("—", ""), ...joints.map(id => new Option(id, id)));
        row.select.value = first[i] ? n.skin.joints[first[i].joint] : "";
        row.input.value = first[i]?.weight ?? 0;
        row.select.disabled = row.input.disabled = !writable();
      }
      field("state").textContent = n.skin ? `${t("edSkinBound")}: ${n.skin.joints.join(", ")}` : t("edSkinUnbound");
      field("selection").textContent = `${t("edMorphSelected")}: ${picked.length}`;
      section.querySelectorAll("[data-skin-label]").forEach(el => { el.textContent = t(el.dataset.skinLabel); });
      for (const [action, label] of Object.entries({ normalize: "edSkinNormalize", preview: "edSkinPreview", save: "edSkinSave",
        restore: "edMorphRestore", bind: n.skin ? "edSkinRebind" : "edSkinBind", unbind: "edSkinUnbind" }))
        button(action).textContent = t(label);
      for (const action of ["preview", "save", "unbind"]) button(action).disabled = !n.skin || !writable();
      for (const action of ["bind", "normalize"]) button(action).disabled = !joints.length || !writable();
    },
  };
}
