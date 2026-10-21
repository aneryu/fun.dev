import { evaluateProject } from "./document.js";
import { sampleKeys } from "./character.js";
import { createMorphEditor } from "./morph-panel.js";
import { createSkinEditor } from "./skin-panel.js";
import { createJointEditor } from "./joint-panel.js";

// Preview frames never mutate history or local project storage. Every authored
// change goes through the same commands as an external agent.
export function createCharacterPanel({ before, store, viewport, apply, prepare, selected, select, selection, writable, t, status }) {
  const panel = document.createElement("details");
  panel.id = "character-tools";
  panel.innerHTML = `<summary></summary><p class="small muted" data-label="edCharacterManual"></p><div class="character-controls"></div>
    <label><span data-label="edCharacterClip"></span><select data-field="clip"></select></label>
    <label><span data-label="edCharacterTime"></span><input data-field="time" type="range" min="0" max="1" step="0.01"></label>
    <output data-field="clock"></output>
    <div class="actions"><button type="button" data-action="play"></button><button type="button" data-action="keep"></button><button type="button" data-action="rest"></button></div>
    <details><summary data-label="edCharacterKeys"></summary>
      <label><span data-label="edCharacterTrack"></span><select data-field="track"></select></label>
      <fieldset><legend data-field="units"></legend><div class="xyz" data-field="values"></div></fieldset>
      <label><span data-label="edCharacterInterpolation"></span><select data-field="interpolation"><option value="linear">Linear</option><option value="step">Step</option><option value="slerp">Slerp</option></select></label>
      <div class="actions"><button type="button" data-action="key"></button><button type="button" data-action="delete-key"></button></div>
      <label><span data-label="edCharacterNewClip"></span><input data-field="name" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" value="action"></label>
      <label><span data-label="edCharacterDuration"></span><input data-field="duration" type="number" min="0.01" max="120" step="0.1" value="2"></label>
      <label><input data-field="loop" type="checkbox" checked><span data-label="edCharacterLoop"></span></label>
      <button type="button" data-action="create"></button>
    </details><p class="small muted" data-field="hint" aria-live="polite"></p>`;
  before.before(panel);
  const field = name => panel.querySelector(`[data-field="${name}"]`);
  const button = name => panel.querySelector(`[data-action="${name}"]`);
  let clipId = "", playhead = 0, playing = false, previewing = false, timer = 0, tracks = [];
  const clip = () => store.snapshot().character?.clips.find(c => c.name === clipId);
  function stop(restore = true) {
    playing = false; clearTimeout(timer);
    if (restore && previewing) {
      viewport.setProject(store.snapshot());
      field("hint").textContent = t("edCharacterRestored");
    }
    previewing = false;
    button("play").textContent = t("edCharacterPlay");
  }
  function preview(project) {
    try {
      viewport.setProject(evaluateProject(project)); previewing = true;
      field("hint").textContent = t("edCharacterPreview");
    } catch (e) { stop(); status(e.message, true); }
  }
  function pose() {
    const p = store.snapshot();
    if (p.character && clipId) p.character.pose = { clip: clipId, time: playhead };
    return p;
  }
  function clock() {
    field("time").value = playhead;
    field("clock").textContent = `${playhead.toFixed(2)} / ${(clip()?.duration ?? 0).toFixed(2)} s`;
  }
  function trackValues() {
    const track = tracks[field("track").selectedIndex], container = field("values");
    container.replaceChildren();
    if (!track) return;
    const p = evaluateProject(pose()), n = p.nodes.find(n => n.id === track.node);
    const c = clip(), existing = c?.tracks.find(x => x.control === track.control && x.node === track.node &&
      x.channel === track.channel && x.target === track.target);
    field("interpolation").value = existing?.interpolation ?? "linear";
    field("interpolation").options[2].disabled = track.channel !== "rotation";
    let value;
    if (track.control) {
      value = p.character.values[track.control] ?? 0;
      // Control tracks are sampled before geometry evaluation; the saved values
      // remain the manual rest controls, so read the active track explicitly.
      if (existing) value = sampleKeys(existing, playhead);
    } else value = track.channel === "morph" ? n.morph.weights[track.target] ?? 0 : n[track.channel];
    field("units").textContent = t(track.channel === "position" ? "edCharacterMetres" :
      track.channel === "rotation" ? "edCharacterDegrees" : "edCharacterValue");
    for (const [i, v] of (Array.isArray(value) ? value : [value]).entries()) {
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.value = Number(v.toFixed(5));
      input.setAttribute("aria-label", Array.isArray(value) ? ["X", "Y", "Z"][i] : t("edCharacterValue"));
      if (["control", "morph"].includes(track.channel)) { input.min = 0; input.max = 1; }
      input.disabled = !writable(); container.append(input);
    }
  }
  function author(commands) { if (!prepare()) return; stop(); if (writable()) apply(commands); }
  field("clip").onchange = () => {
    stop(); clipId = field("clip").value; playhead = 0;
    if (clipId) author([{ op: "characterPose", name: clipId, time: 0 }]);
    else author([{ op: "characterPose" }]);
  };
  field("time").oninput = () => { stop(false); playhead = Number(field("time").value); clock(); preview(pose()); trackValues(); };
  field("time").onchange = () => { if (clipId) author([{ op: "characterPose", name: clipId, time: playhead }]); };
  field("track").onchange = trackValues;
  button("keep").onclick = () => { if (clipId) author([{ op: "characterPose", name: clipId, time: playhead }]); };
  button("rest").onclick = () => { clipId = ""; playhead = 0; author([{ op: "characterPose" }]); };
  button("play").onclick = () => {
    if (playing) { stop(); clock(); return; }
    if (!prepare()) return;
    const c = clip(); if (!c) return;
    playing = true; const start = performance.now() - playhead * 1000;
    button("play").textContent = t("edCharacterStop");
    const tick = () => {
      if (!playing) return;
      const elapsed = (performance.now() - start) / 1000;
      playhead = c.loop ? elapsed % c.duration : Math.min(elapsed, c.duration);
      preview(pose()); clock();
      if (!c.loop && elapsed >= c.duration) { playing = false; button("play").textContent = t("edCharacterPlay"); return; }
      timer = setTimeout(tick, 1000 / 12);
    };
    tick();
  };
  button("create").onclick = () => {
    if (!field("name").reportValidity() || !field("duration").reportValidity()) return;
    const name = field("name").value;
    if (store.snapshot().character?.clips.some(c => c.name === name)) { status(t("edCharacterDuplicate"), true); return; }
    clipId = name; playhead = 0;
    author([{ op: "characterClip", name, duration: Number(field("duration").value), fps: 24,
      loop: field("loop").checked, tracks: [] }, { op: "characterPose", name, time: 0 }]);
  };
  function editKey(remove = false) {
    const c = clip(), target = tracks[field("track").selectedIndex];
    if (!c || !target) return;
    const inputs = [...field("values").querySelectorAll("input")];
    if (!remove && inputs.some(i => !i.reportValidity())) return;
    const value = inputs.length === 1 ? Number(inputs[0].value) : inputs.map(i => Number(i.value));
    const match = x => x.control === target.control && x.node === target.node && x.channel === target.channel && x.target === target.target;
    const previous = c.tracks.find(match);
    const keys = (previous?.keys ?? []).filter(k => Math.abs(k.time - playhead) > 1e-6);
    if (!remove) keys.push({ time: playhead, value });
    keys.sort((a, b) => a.time - b.time);
    author([{ op: "characterClip", ...c, tracks: [...c.tracks.filter(x => !match(x)),
      ...(keys.length ? [{ ...target, interpolation: field("interpolation").value, keys }] : [])] }]);
  }
  button("key").onclick = () => editKey();
  button("delete-key").onclick = () => editKey(true);
  function refresh() {
    stop();
    const p = store.snapshot(), c = p.character, node = p.nodes.find(n => n.id === selected());
    panel.hidden = !p.nodes.length;
    panel.querySelector("summary").textContent = t("edCharacter");
    panel.querySelectorAll("[data-label]").forEach(el => { el.textContent = t(el.dataset.label); });
    field("interpolation").options[0].textContent = t("edCharacterLinear");
    field("interpolation").options[1].textContent = t("edCharacterStep");
    field("interpolation").options[2].textContent = t("edCharacterSlerp");
    for (const [action, key] of Object.entries({ play: "edCharacterPlay", keep: "edCharacterKeep", rest: "edCharacterRest",
      key: "edCharacterRecord", "delete-key": "edCharacterDeleteKey", create: "edCharacterCreate" }))
      button(action).textContent = t(key);
    const controls = panel.querySelector(".character-controls"); controls.replaceChildren();
    panel.querySelector('[data-label="edCharacterManual"]').hidden = !c?.controls.length;
    for (const control of c?.controls ?? []) {
      const label = document.createElement("label"), input = document.createElement("input");
      label.textContent = control.id; input.type = "range"; input.min = 0; input.max = 1; input.step = .01;
      input.value = c.values[control.id] ?? 0; input.disabled = !writable(); input.setAttribute("aria-label", control.id);
      input.oninput = () => { stop(false); const next = store.snapshot(); delete next.character.pose;
        next.character.values[control.id] = Number(input.value); preview(next); };
      input.onchange = () => { clipId = ""; playhead = 0;
        author([{ op: "characterValues", values: { [control.id]: Number(input.value) } }]); };
      label.append(input); controls.append(label);
    }
    if (c?.pose) { clipId = c.pose.clip; playhead = c.pose.time; }
    if (!c?.clips.some(x => x.name === clipId)) clipId = "";
    field("clip").replaceChildren(new Option(t("edCharacterRest"), ""), ...(c?.clips ?? []).map(x => new Option(x.name, x.name)));
    field("clip").value = clipId;
    const duration = clip()?.duration ?? 1; playhead = Math.min(playhead, duration);
    field("time").max = duration; field("time").disabled = !clipId || !writable();
    const previous = field("track").value;
    tracks = (c?.controls ?? []).map(x => ({ control: x.id, channel: "control" }));
    if (node && !node.instanceOf && !node.symmetry) tracks.push(...["position", "rotation", "scale"]
      .filter(channel => !node.attachment || (node.attachment.mode === "position" && channel !== "position"))
      .map(channel => ({ node: node.id, channel })),
      ...(node.attachment?.mode === "deform" ? [] : node.morph?.targets ?? []).map(x => ({ node: node.id, channel: "morph", target: x.name })));
    field("track").replaceChildren(...tracks.map((x, i) => new Option(
      x.control ?? `${x.node} · ${x.target ?? t({ position: "edPosition", rotation: "edRotation", scale: "edSize" }[x.channel])}`, String(i))));
    if ([...field("track").options].some(o => o.value === previous)) field("track").value = previous;
    for (const name of ["key", "delete-key", "keep"])
      button(name).disabled = !clipId || !writable() || (name !== "keep" && !tracks.length);
    button("play").disabled = !clipId;
    for (const name of ["create", "rest"]) button(name).disabled = !writable();
    clock(); trackValues(); field("hint").textContent = t("edCharacterHint");
    morphEditor.refresh();
    skinEditor.refresh();
    jointEditor.refresh();
  }
  const morphEditor = createMorphEditor({ panel, store, selected, selection, author, preview, stop, writable, t, status });
  const skinEditor = createSkinEditor({ panel, store, selected, selection, author, preview, stop, writable, t, status });
  const jointEditor = createJointEditor({ panel, store, selected, select, author, preview, stop, writable, t, status });
  const hide = () => { if (document.hidden) stop(); };
  const escape = e => { if (e.key === "Escape" && previewing) stop(); };
  panel.addEventListener("toggle", e => { if (e.target === panel && !panel.open) stop(); });
  document.addEventListener("visibilitychange", hide);
  document.addEventListener("keydown", escape);
  return { refresh, dispose() { stop(false); document.removeEventListener("visibilitychange", hide);
    document.removeEventListener("keydown", escape); panel.remove(); } };
}
