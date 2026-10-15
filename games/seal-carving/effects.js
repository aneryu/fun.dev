// Flakes of stone that spring off the knife, and the powder that a breath carries away.
// One instanced mesh of tiny shards, simulated in the stone's space: they hop, land on the
// face or the mat, rest, and fly off when blown.
const COUNT = 220;

// Flakes are flat chips (a squashed tetrahedron, each with its own proportions): most are pale
// powdery stone from the groove, some carry the stone's own colour from its lip.
export function createEffects({ THREE, track, color, stoneColor = color, faceHalf, floor, reducedMotion }) {
  const geometry = track(new THREE.TetrahedronGeometry(1, 0));
  const material = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
  const pale = new THREE.Color(color), tinted = new THREE.Color(stoneColor).lerp(pale, 0.35);
  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.setColorAt(0, pale); // creates the per-chip colours before the first frame
  mesh.count = 0;
  const particles = Array.from({ length: COUNT }, () => ({ alive: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), spin: new THREE.Vector3(), rotation: new THREE.Euler(), shape: new THREE.Vector3(1, 1, 1), color: pale, size: 0, life: 0, resting: false }));
  let cursor = 0;
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();

  function spawn(position, velocity, size, life) {
    const particle = particles[cursor];
    cursor = (cursor + 1) % COUNT;
    particle.alive = true;
    particle.resting = false;
    particle.position.copy(position);
    particle.velocity.copy(velocity);
    particle.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
    particle.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    particle.size = size;
    particle.life = life;
    // Flat and irregular: one thin axis, the others uneven.
    particle.shape.set(0.7 + Math.random() * 0.8, 0.18 + Math.random() * 0.2, 0.6 + Math.random() * 0.9);
    particle.color = Math.random() < 0.28 ? tinted : pale;
  }

  const velocity = new THREE.Vector3();
  return {
    mesh,
    // A flake breaking off at `at`, thrown sideways from the cut and a little ahead of the knife.
    flake(at, sideways, ahead, strength = 1, size = 1) {
      if (reducedMotion && Math.random() < 0.6) return;
      const side = Math.random() < 0.5 ? -1 : 1;
      velocity.set(sideways.x * side, 0, sideways.z * side).multiplyScalar(0.25 + Math.random() * 0.35)
        .addScaledVector(ahead, 0.15 + Math.random() * 0.2);
      velocity.y = (0.35 + Math.random() * 0.5) * strength;
      spawn(at, velocity, (0.002 + Math.random() * 0.003) * size, 4 + Math.random() * 3);
    },
    // Powder shoved ahead of the edge: crumbs that barely hop and settle in a little heap.
    crumb(at, ahead) {
      if (reducedMotion) return;
      velocity.copy(ahead).multiplyScalar(0.05 + Math.random() * 0.12);
      velocity.x += (Math.random() - 0.5) * 0.06;
      velocity.z += (Math.random() - 0.5) * 0.06;
      velocity.y = 0.05 + Math.random() * 0.12;
      spawn(at, velocity, 0.0012 + Math.random() * 0.0016, 3 + Math.random() * 3);
    },
    // A breath from the viewer's side: everything resting on the face lifts and flies away,
    // and a puff of powder rises from where `points` (face positions) had dust.
    blow(direction, points, strength = 1) {
      for (const particle of particles) {
        if (!particle.alive) continue;
        if (Math.abs(particle.position.x) > faceHalf + 0.05 || Math.abs(particle.position.z) > faceHalf + 0.05 || particle.position.y < -0.05) continue;
        particle.resting = false;
        particle.velocity.set(direction.x, 0, direction.z).multiplyScalar((1.2 + Math.random()) * strength);
        particle.velocity.y = 0.3 + Math.random() * 0.6;
        particle.life = Math.min(particle.life, 1.5);
      }
      if (reducedMotion) return;
      for (const point of points) {
        velocity.set(direction.x, 0, direction.z).multiplyScalar((0.8 + Math.random() * 1.2) * strength);
        velocity.x += (Math.random() - 0.5) * 0.6;
        velocity.y = 0.2 + Math.random() * 0.5;
        spawn(point, velocity, 0.002 + Math.random() * 0.003, 0.9 + Math.random() * 0.6);
      }
    },
    // Returns true while anything moves.
    update(delta) {
      let moving = false, count = 0;
      for (const particle of particles) {
        if (!particle.alive) continue;
        particle.life -= delta;
        if (particle.life <= 0) { particle.alive = false; continue; }
        if (!particle.resting) {
          moving = true;
          particle.velocity.y -= 4.5 * delta;
          particle.velocity.multiplyScalar(Math.exp(-delta * (particle.size < 0.004 ? 2.5 : 0.6)));
          particle.position.addScaledVector(particle.velocity, delta);
          particle.rotation.x += particle.spin.x * delta;
          particle.rotation.y += particle.spin.y * delta;
          particle.rotation.z += particle.spin.z * delta;
          // Land on the face while over it, else on the mat.
          const overFace = Math.abs(particle.position.x) < faceHalf && Math.abs(particle.position.z) < faceHalf;
          const ground = overFace ? particle.size * 0.5 : floor + particle.size * 0.5;
          if (particle.position.y < ground && (overFace || particle.position.y < floor + 0.1)) {
            particle.position.y = ground;
            if (Math.abs(particle.velocity.y) < 0.25) { particle.resting = true; particle.velocity.set(0, 0, 0); }
            else { particle.velocity.y *= -0.3; particle.velocity.x *= 0.5; particle.velocity.z *= 0.5; }
          }
        }
        // Shrinks away in its last half second.
        const fade = Math.min(1, particle.life / 0.5);
        quaternion.setFromEuler(particle.rotation);
        scale.copy(particle.shape).multiplyScalar(particle.size * fade);
        matrix.compose(particle.position, quaternion, scale);
        mesh.setColorAt(count, particle.color);
        mesh.setMatrixAt(count++, matrix);
        if (particle.life < 0.5) moving = true;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      return moving;
    },
    clear() { for (const particle of particles) particle.alive = false; mesh.count = 0; },
  };
}
