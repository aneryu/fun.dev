// The slapping hand: one right-hand mesh, mirrored for the left. It swings in from the
// side the stroke came from, meets the cheek, pauses for a hit-stop, and follows through
// towards the camera so it never passes through the head.
import { loadPack } from "./head.js";

const APPROACH = 0.07, FOLLOW = 0.16;

export async function createHands(context) {
  const { THREE, asset, signal, track } = context;
  const [{ meta, arrays }, map] = await Promise.all([
    loadPack(asset, "hand", signal),
    new THREE.TextureLoader().loadAsync(asset("assets/hand.jpg")),
  ]);
  signal.throwIfAborted();
  track(map);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  const source = arrays.renderSource;
  const positions = new Float32Array(source.length * 3);
  for (let r = 0; r < source.length; r++) positions.set(arrays.position.subarray(source[r] * 3, source[r] * 3 + 3), r * 3);
  const geometry = track(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(arrays.renderUv, 2));
  geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));
  geometry.computeVertexNormals();
  const material = track(new THREE.MeshStandardMaterial({ map, roughness: 0.62, metalness: 0 }));
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);
  root.visible = false;
  const lights = new THREE.Group();
  const key = new THREE.DirectionalLight(0xfff1e6, 2.2);
  key.position.set(0.4, 0.6, 1);
  lights.add(key, new THREE.HemisphereLight(0xe8eefc, 0x2a2420, 1.1));

  let swing = null;
  const basis = new THREE.Matrix4(), axisX = new THREE.Vector3(), axisY = new THREE.Vector3(), axisZ = new THREE.Vector3();
  const bezier = (a, b, c, t, out) => out.copy(a).multiplyScalar((1 - t) ** 2).addScaledVector(b, 2 * (1 - t) * t).addScaledVector(c, t * t);

  return {
    object: root, lights, meta,
    get busy() { return swing !== null && swing.time < APPROACH; },
    // contact: world point on the cheek; direction: unit world vector of the stroke; towardCamera: unit
    // vector; surface: the cheek's outward world normal at the contact, if known.
    start(contact, direction, towardCamera, onContact, surface = null) {
      const leftHand = direction.x > 0;
      mesh.scale.set(leftHand ? -1 : 1, 1, 1);
      const palm = contact.clone().addScaledVector(direction, -0.012);
      swing = {
        time: 0, contacted: false, onContact, leftHand,
        start: palm.clone().addScaledVector(direction, -0.32).addScaledVector(towardCamera, 0.08).add(new THREE.Vector3(0, -0.05, 0)),
        contact: palm,
        end: palm.clone().addScaledVector(direction, 0.22).addScaledVector(towardCamera, 0.2).add(new THREE.Vector3(0, 0.03, 0)),
        direction: direction.clone(), toward: towardCamera.clone(),
        // The palm meets the cheek: local +Z (the back of the hand) follows the cheek's normal.
        back: (surface ? surface.clone() : towardCamera.clone()).multiplyScalar(0.75).addScaledVector(direction, -0.45).normalize(),
        control1: null, control2: null,
      };
      swing.control1 = swing.start.clone().lerp(palm, 0.6).addScaledVector(towardCamera, 0.03);
      swing.control2 = palm.clone().lerp(swing.end, 0.5).addScaledVector(towardCamera, -0.02);
      root.visible = true;
    },
    // Returns true while the hand is on screen.
    update(delta) {
      if (!swing) return false;
      swing.time += delta;
      const s = swing;
      const p = new THREE.Vector3();
      let roll;
      if (s.time < APPROACH) {
        const t = (s.time / APPROACH) ** 1.6;
        bezier(s.start, s.control1, s.contact, t, p);
        roll = (1 - t) * 0.5;
      } else {
        if (!s.contacted) { s.contacted = true; s.onContact?.(); }
        const t = Math.min(1, (s.time - APPROACH) / FOLLOW);
        bezier(s.contact, s.control2, s.end, 1 - (1 - t) ** 2, p);
        roll = -t * 0.6;
        if (t >= 1) { swing = null; root.visible = false; return false; }
      }
      // Palm (local -Z) on the cheek, fingers (local +Y) up and leaning into the swing; the forearm
      // comes from the slapper (the camera), so fingers lean away from it.
      axisZ.copy(s.back);
      axisY.set(0, 0.85, 0).addScaledVector(s.direction, 0.3).addScaledVector(s.toward, -0.45);
      axisY.addScaledVector(axisZ, -axisY.dot(axisZ)).normalize();
      axisX.crossVectors(axisY, axisZ);
      basis.makeBasis(axisX, axisY, axisZ);
      root.quaternion.setFromRotationMatrix(basis);
      root.rotateZ(roll * (s.leftHand ? -1 : 1));
      root.position.copy(p);
      return true;
    },
    cancel() { swing = null; root.visible = false; },
    dispose() { root.removeFromParent(); lights.removeFromParent(); },
  };
}
