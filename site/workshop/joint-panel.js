import { evaluateCommands } from "./document.js";

export function createJointEditor({ panel, store, selected, select, author, preview, stop, writable, t, status }) {
  const section = document.createElement("details");
  section.dataset.section = "joint";
  section.innerHTML = `<summary data-joint-label="edJointEditor"></summary>
    <label><span data-joint-label="edJointName"></span><input data-joint="name" value="joint_detail" maxlength="64"></label>
    <label><span data-joint-label="edJointParent"></span><select data-joint="parent"></select></label>
    <div class="actions"><button data-joint-action="create"></button><button data-joint-action="mark"></button></div>
    <div data-joint="edit"><p class="small muted" data-joint="dependencies"></p>
      <fieldset><legend data-joint-label="edJointPosition"></legend><div class="xyz" data-joint="position"></div></fieldset>
      <fieldset><legend data-joint-label="edJointRotation"></legend><div class="xyz" data-joint="rotation"></div></fieldset>
      <fieldset><legend data-joint-label="edJointScale"></legend><div class="xyz" data-joint="scale"></div></fieldset>
      <div class="actions"><button data-joint-action="preview"></button><button data-joint-action="save"></button><button data-joint-action="restore"></button></div>
    </div><p class="small muted" data-joint-label="edJointHint"></p>`;
  panel.append(section);
  const field = key => section.querySelector(`[data-joint="${key}"]`);
  const button = key => section.querySelector(`[data-joint-action="${key}"]`);
  let nodeId = "";
  for (const key of ["position", "rotation", "scale"]) for (const axis of ["X", "Y", "Z"]) {
    const input = document.createElement("input");
    input.type = "number"; input.step = key === "position" ? ".001" : ".01";
    input.setAttribute("aria-label", axis); field(key).append(input);
  }
  const safe = fn => () => { try { fn(); } catch (e) { status(e.message, true); } };
  const command = () => ({ op: "jointRest", id: selected(), ...Object.fromEntries(
    ["position", "rotation", "scale"].map(key => [key, [...field(key).querySelectorAll("input")].map(el => Number(el.value))])) });
  button("create").onclick = safe(() => {
    const id = field("name").value.trim(), parent = field("parent").value || null;
    if (store.snapshot().nodes.some(n => n.id === id)) throw new Error(t("edJointExists"));
    author([{ op: "create", id, kind: "group", parent }, { op: "joint", id }]);
    if (store.snapshot().nodes.some(n => n.id === id && n.joint)) select(id);
  });
  button("mark").onclick = safe(() => author([{ op: "joint", id: selected() }]));
  button("preview").onclick = safe(() => { stop(); preview(evaluateCommands(store.snapshot(), [command()])); });
  button("save").onclick = safe(() => author([command()]));
  button("restore").onclick = () => stop();
  section.addEventListener("toggle", e => { if (e.target === section && !section.open) stop(); });
  return {
    refresh() {
      const p = store.snapshot(), n = p.nodes.find(n => n.id === selected());
      section.hidden = !n; if (!n) return;
      const previous = nodeId === n.id ? field("parent").value : !n.mesh ? n.id : n.parent;
      nodeId = n.id;
      field("parent").replaceChildren(new Option(t("edJointWorld"), ""),
        ...p.nodes.filter(n => !n.mesh && !n.instanceOf && !n.symmetry).map(n => new Option(n.id, n.id)));
      field("parent").value = previous ?? "";
      field("edit").hidden = !n.joint;
      const rest = p.character?.rest[n.id] ?? n;
      for (const key of ["position", "rotation", "scale"])
        [...field(key).querySelectorAll("input")].forEach((el, i) => { el.value = rest[key][i]; el.disabled = !writable(); });
      const skins = p.nodes.filter(mesh => mesh.skin?.joints.includes(n.id)).map(n => n.id);
      field("dependencies").textContent = `${t("edJointRebind")}: ${skins.join(", ") || "—"}`;
      for (const [action, label] of Object.entries({ create: "edJointCreate", mark: "edJointMark",
        preview: "edJointPreview", save: "edJointSave", restore: "edMorphRestore" })) button(action).textContent = t(label);
      section.querySelectorAll("[data-joint-label]").forEach(el => { el.textContent = t(el.dataset.jointLabel); });
      button("create").disabled = !writable();
      button("mark").disabled = !writable() || !!n.mesh || !!n.joint || !!n.attachment;
      for (const action of ["preview", "save"]) button(action).disabled = !writable() || !n.joint;
    },
  };
}
