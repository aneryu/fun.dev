// Profile edits are a dialog-local transaction. Pointer coordinates use SVG's
// actual screen matrix, including viewBox letterboxing and border offsets.
export function profileEditor(
  svg,
  textarea,
  { onChange = () => {}, step = () => 0.01 } = {},
) {
  const ns = "http://www.w3.org/2000/svg";
  let points = [],
    range,
    drag = null,
    selected = 0,
    past = [],
    future = [];
  const read = () =>
    textarea.value
      .trim()
      .split(/\n+/)
      .map((l) =>
        l
          .trim()
          .split(/[,\s]+/)
          .map(Number),
      );
  const valid = (p) =>
    p.length >= 2 && p.every((v) => v.length === 2 && v.every(Number.isFinite));
  const project = ([x, y]) => [
    20 + ((x - range.x) / range.w) * 240,
    170 - ((y - range.y) / range.h) * 150,
  ];
  const coordinate = (e) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      svg.getScreenCTM().inverse(),
    );
    return [
      range.x + ((p.x - 20) / 240) * range.w,
      range.y + ((170 - p.y) / 150) * range.h,
    ];
  };
  const remember = () => {
    past.push(textarea.value);
    if (past.length > 50) past.shift();
    future = [];
  };
  function readout() {
    const label = document.querySelector("#profile-point");
    if (!label) return;
    label.textContent = `#${selected}`;
    for (const [i, id] of ["profile-x", "profile-y"].entries())
      document.querySelector("#" + id).value = points[selected]?.[i] ?? 0;
    document.querySelector("#profile-undo").disabled = !past.length;
    document.querySelector("#profile-redo").disabled = !future.length;
  }
  function write() {
    textarea.value = points
      .map((v) => v.map((n) => Number(n.toFixed(5))).join(", "))
      .join("\n");
    readout();
    onChange();
  }
  function draw(fit = true) {
    const next = read();
    if (!valid(next)) return;
    points = next;
    selected = Math.min(selected, points.length - 1);
    if (fit || !range) {
      const xs = points.map((p) => p[0]),
        ys = points.map((p) => p[1]);
      const w = Math.max(0.1, Math.max(...xs) - Math.min(0, ...xs)),
        h = Math.max(0.1, Math.max(...ys) - Math.min(0, ...ys));
      range = {
        x: Math.min(0, ...xs) - w * 0.1,
        y: Math.min(0, ...ys) - h * 0.1,
        w: w * 1.2,
        h: h * 1.2,
      };
    }
    svg.replaceChildren();
    const make = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    const [x0, y0] = project([0, 0]);
    make("path", {
      d: `M ${x0} 10 V 180 M 10 ${y0} H 270`,
      class: "profile-axes",
    });
    make("polyline", {
      points: points
        .map(project)
        .map((p) => p.join(","))
        .join(" "),
      class: "profile-line",
    });
    points.forEach((p, i) => {
      const [cx, cy] = project(p),
        c = make("circle", {
          cx,
          cy,
          r: 5,
          tabindex: 0,
          "data-point": i,
          role: "button",
          "aria-label": `${i}: ${p.join(", ")}`,
          "aria-pressed": String(selected === i),
        });
      c.addEventListener("keydown", (e) => {
        const delta = {
          ArrowLeft: [-step(), 0],
          ArrowRight: [step(), 0],
          ArrowDown: [0, -step()],
          ArrowUp: [0, step()],
        }[e.key];
        if (delta) {
          e.preventDefault();
          remember();
          selected = i;
          points[i] = p.map((v, k) => v + delta[k] * (e.shiftKey ? 10 : 1));
          write();
          draw(false);
          svg.querySelector(`[data-point="${i}"]`)?.focus();
        } else if (
          ["Delete", "Backspace"].includes(e.key) &&
          points.length > 2
        ) {
          e.preventDefault();
          remember();
          points.splice(i, 1);
          selected = Math.min(i, points.length - 1);
          write();
          draw(false);
          svg.querySelector(`[data-point="${selected}"]`)?.focus();
        }
      });
    });
    readout();
  }
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.dataset.point === undefined) return;
    selected = Number(e.target.dataset.point);
    remember();
    drag = {
      index: selected,
      start: coordinate(e),
      original: [...points[selected]],
      snapshot: textarea.value,
    };
    e.target.focus();
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    readout();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = coordinate(e),
      axis = document.querySelector("#profile-constraint")?.value ?? "free";
    const delta = p.map((v, k) => v - drag.start[k]);
    const constraint = e.shiftKey
      ? Math.abs(delta[0]) > Math.abs(delta[1])
        ? "x"
        : "y"
      : axis;
    points[drag.index] = drag.original.map(
      (v, k) =>
        v +
        ((constraint === "x" && k === 1) || (constraint === "y" && k === 0)
          ? 0
          : delta[k]),
    );
    write();
    draw(false);
  });
  svg.addEventListener("pointerup", () => {
    if (drag) {
      drag = null;
      svg.querySelector(`[data-point="${selected}"]`)?.focus();
    }
  });
  svg.addEventListener("pointercancel", () => {
    if (drag) {
      textarea.value = drag.snapshot;
      drag = null;
      draw(false);
      onChange();
    }
  });
  svg.addEventListener("dblclick", (e) => {
    if (e.target.dataset.point !== undefined) return;
    const p = coordinate(e);
    let index = 1,
      best = Infinity;
    for (let i = 1; i < points.length; i++) {
      const a = project(points[i - 1]),
        b = project(points[i]),
        q = project(p),
        v = b.map((n, k) => n - a[k]),
        t = Math.max(
          0,
          Math.min(
            1,
            v.reduce((s, n, k) => s + n * (q[k] - a[k]), 0) /
              (v[0] ** 2 + v[1] ** 2),
          ),
        );
      const d = Math.hypot(...q.map((n, k) => n - a[k] - t * v[k]));
      if (d < best) {
        best = d;
        index = i;
      }
    }
    if (best > 12) return;
    remember();
    points.splice(index, 0, p);
    selected = index;
    write();
    draw(false);
  });
  textarea.addEventListener("beforeinput", remember);
  textarea.addEventListener("change", () => {
    draw(false);
    onChange();
  });
  for (const [i, id] of ["profile-x", "profile-y"].entries())
    document.querySelector("#" + id)?.addEventListener("change", (e) => {
      if (!e.target.reportValidity()) return;
      remember();
      points[selected][i] = Number(e.target.value);
      write();
      draw(false);
    });
  function history(redo = false) {
    const from = redo ? future : past,
      to = redo ? past : future;
    if (!from.length) return;
    to.push(textarea.value);
    textarea.value = from.pop();
    drag = null;
    draw(false);
    onChange();
  }
  document
    .querySelector("#profile-undo")
    ?.addEventListener("click", () => history());
  document
    .querySelector("#profile-redo")
    ?.addEventListener("click", () => history(true));
  svg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      history(e.shiftKey);
    }
    if (e.key === "Escape" && drag) {
      e.preventDefault();
      history();
    }
  });
  return {
    draw,
    reset() {
      past = [];
      future = [];
      selected = 0;
      draw();
    },
  };
}
