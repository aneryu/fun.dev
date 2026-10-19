// Jolt Physics for fun.dev games (docs/model-format.md §4.7 and §7): one world per game. The
// physics section of a loaded .fun3d model (shapes, bodies, wheeled vehicles) becomes Jolt
// objects that drive the model's nodes. Jolt is served like the vision runtime: the build hashes
// it into /runtime/physics/<hash>/ and the browser loads it on first use (about 0.6 MB).
//
//   const physics = await createPhysics({ THREE, scene });
//   const car = physics.add(model);                       // model = await fun3d.load(bytes), or models.place(...)
//   car.vehicles.get("car").drive({ throttle: 1, steer: 0.3 });
//   physics.addStatic({ type: "box", halfExtents: [50, 0.5, 50] }, { position: [0, -0.5, 0] });
//   physics.step(dt);                                     // fixed steps inside, interpolated transforms out
//   context.onCleanup(() => physics.dispose());
//
// Release 1 (§10) builds static and dynamic bodies and wheeled vehicles; kinematic bodies,
// constraints, ragdolls and characters are reported through `warn` and skipped.

// The build replaces this line with the content hash of the physics runtime.
const VERSION = "source";

export const LAYERS = Object.freeze({ static: 0, moving: 1, debris: 2, sensor: 3 });
const PAIRS = [["static", "moving"], ["moving", "moving"], ["debris", "static"], ["sensor", "moving"]];
const BROADPHASE = { static: 0, moving: 1, debris: 1, sensor: 1 };
const SUSPENSION = { min: 0.05, max: 0.25, frequency: 1.5, damping: 0.5 };
const ENGINE = { maxTorque: 300, minRPM: 1000, maxRPM: 6000 };
const GEARS = [2.66, 1.78, 1.3, 1.0, 0.74], REVERSE = [-2.9];

/** The platform's Jolt build, fetched by URL: the web host's loader. Other hosts pass `loadJolt` (docs/hosts.md). */
const loadPlatformJolt = async () => (await import(new URL(`../physics/${VERSION}/jolt-physics.wasm.js`, import.meta.url).href)).default();

/** Loads Jolt through `loadJolt` (the platform build by default) unless a module is given (tests, workers). */
export async function createPhysics({ THREE, Jolt = null, loadJolt = loadPlatformJolt, scene = null, gravity = 9.81, step = 1 / 60, maxSteps = 4, warn = (message) => console.warn(message) } = {}) {
  if (!Jolt) Jolt = await loadJolt();
  const settings = new Jolt.JoltSettings();
  const pairs = new Jolt.ObjectLayerPairFilterTable(4);
  for (const [a, b] of PAIRS) pairs.EnableCollision(LAYERS[a], LAYERS[b]);
  const broadphase = new Jolt.BroadPhaseLayerInterfaceTable(4, 2);
  for (const [name, layer] of Object.entries(LAYERS)) broadphase.MapObjectToBroadPhaseLayer(layer, new Jolt.BroadPhaseLayer(BROADPHASE[name]));
  settings.mObjectLayerPairFilter = pairs;
  settings.mBroadPhaseLayerInterface = broadphase;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(broadphase, 2, pairs, 4);
  const jolt = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  const system = jolt.GetPhysicsSystem(), bodies = system.GetBodyInterface();
  system.SetGravity(new Jolt.Vec3(0, -gravity, 0));

  // Temporaries, allocated once.
  const v3 = new Jolt.Vec3(0, 0, 0), v3b = new Jolt.Vec3(0, 0, 0), v3c = new Jolt.Vec3(0, 0, 0), rv3 = new Jolt.RVec3(0, 0, 0), q4 = new Jolt.Quat(0, 0, 0, 1);
  const right = new Jolt.Vec3(1, 0, 0), up = new Jolt.Vec3(0, 1, 0);
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), matrix = new THREE.Matrix4(), matrix2 = new THREE.Matrix4();
  const previous = new THREE.Vector3(), current = new THREE.Vector3(), previousRotation = new THREE.Quaternion(), currentRotation = new THREE.Quaternion();
  const vec = (x, y, z) => { v3.Set(x, y, z); return v3; };
  const handles = new Set();
  let accumulator = 0, disposed = false;

  function created(shapeSettings) {
    const result = shapeSettings.Create();
    if (result.HasError()) { const message = result.GetError().c_str(); Jolt.destroy(shapeSettings); throw new Error(`Jolt shape: ${message}`); }
    const shape = result.Get();
    Jolt.destroy(shapeSettings);
    return shape;
  }

  // Shapes are built once per loaded file and shared by its copies (Jolt shapes are immutable
  // and reference counted); scale and centre of mass wrap them per body.
  const shapeCache = new WeakMap();
  function shapesFor(file) {
    let shapes = shapeCache.get(file);
    if (!shapes) shapeCache.set(file, (shapes = new Map()));
    const descriptors = new Map((file.manifest.physics?.shapes ?? []).map((s) => [s.id, s]));
    return (id, depth = 0) => {
      if (shapes.has(id)) return shapes.get(id);
      const desc = descriptors.get(id);
      if (!desc) throw new Error(`unknown shape "${id}"`);
      let shape;
      switch (desc.type) {
        case "box": { const [x, y, z] = desc.halfExtents; shape = created(new Jolt.BoxShapeSettings(vec(x, y, z), Math.min(0.05, x * 0.2, y * 0.2, z * 0.2))); break; }
        case "sphere": shape = created(new Jolt.SphereShapeSettings(desc.radius)); break;
        case "capsule": shape = created(new Jolt.CapsuleShapeSettings(desc.halfHeight, desc.radius)); break;
        case "cylinder": shape = created(new Jolt.CylinderShapeSettings(desc.halfHeight, desc.radius, Math.min(0.05, desc.radius * 0.2))); break;
        case "convex": {
          const hull = new Jolt.ConvexHullShapeSettings(), points = file.physicsData.points.get(id);
          for (let i = 0; i < points.length; i += 3) hull.mPoints.push_back(vec(points[i], points[i + 1], points[i + 2]));
          shape = created(hull);
          break;
        }
        case "mesh": {
          const geometry = file.geometries.get(desc.geometry), positions = geometry.positions(), index = geometry.index;
          const list = new Jolt.TriangleList();
          for (let i = 0; i < index.length; i += 3) {
            const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
            v3.Set(positions[a], positions[a + 1], positions[a + 2]); v3b.Set(positions[b], positions[b + 1], positions[b + 2]); v3c.Set(positions[c], positions[c + 1], positions[c + 2]);
            const triangle = new Jolt.Triangle(v3, v3b, v3c);
            list.push_back(triangle);
            Jolt.destroy(triangle);
          }
          shape = created(new Jolt.MeshShapeSettings(list));
          Jolt.destroy(list);
          break;
        }
        case "compound": {
          if (depth) throw new Error("compound shapes do not nest");
          const compound = new Jolt.StaticCompoundShapeSettings();
          for (const child of desc.children) {
            const [x, y, z] = child.position ?? [0, 0, 0], [qx, qy, qz, qw] = child.rotation ?? [0, 0, 0, 1];
            q4.Set(qx, qy, qz, qw);
            compound.AddShapeShape(vec(x, y, z), q4, shapes.get(child.shape) ?? shapesFor(file)(child.shape, depth + 1), 0);
          }
          shape = created(compound);
          break;
        }
        default: throw new Error(`shape type "${desc.type}" is not in this release`);
      }
      shapes.set(id, shape);
      return shape;
    };
  }

  function createBody(baseShape, desc, worldPosition, worldRotation, worldScale) {
    let shape = baseShape;
    if (Math.abs(worldScale - 1) > 1e-6) shape = new Jolt.ScaledShape(shape, vec(worldScale, worldScale, worldScale));
    if (desc.centerOfMass) { const [x, y, z] = desc.centerOfMass; shape = new Jolt.OffsetCenterOfMassShape(shape, vec(x * worldScale, y * worldScale, z * worldScale)); }
    const motionName = desc.motion ?? "static";
    const motion = { static: Jolt.EMotionType_Static, kinematic: Jolt.EMotionType_Kinematic, dynamic: Jolt.EMotionType_Dynamic }[motionName];
    const layer = LAYERS[desc.layer ?? (motionName === "static" ? "static" : "moving")];
    rv3.Set(worldPosition.x, worldPosition.y, worldPosition.z);
    q4.Set(worldRotation.x, worldRotation.y, worldRotation.z, worldRotation.w);
    const creation = new Jolt.BodyCreationSettings(shape, rv3, q4, motion, layer);
    creation.mFriction = desc.friction ?? 0.5;
    creation.mRestitution = desc.restitution ?? 0;
    creation.mLinearDamping = desc.damping?.linear ?? 0.05;
    creation.mAngularDamping = desc.damping?.angular ?? 0.05;
    creation.mGravityFactor = desc.gravity ?? 1;
    creation.mMotionQuality = desc.ccd ? Jolt.EMotionQuality_LinearCast : Jolt.EMotionQuality_Discrete;
    creation.mIsSensor = !!desc.sensor;
    creation.mAllowSleeping = desc.sleep ?? true;
    creation.mAllowDynamicOrKinematic = !!desc.switchable;
    if (desc.mass !== undefined && motionName !== "static") {
      creation.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
      creation.mMassPropertiesOverride.mMass = desc.mass;
    }
    const body = bodies.CreateBody(creation);
    Jolt.destroy(creation);
    bodies.AddBody(body.GetID(), desc.active === false || motionName === "static" ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate);
    return body;
  }

  // A body entry: the Jolt body, the node it drives and its last two states for interpolation.
  function entryFor(id, body, node, desc) {
    const state = new Float64Array(14);
    const entry = { id, body, node, desc, state, dynamic: (desc.motion ?? "static") === "dynamic" };
    readState(entry, 0); readState(entry, 7);
    const api = {
      id, node, body,
      get active() { return body.IsActive(); },
      activate() { bodies.ActivateBody(body.GetID()); },
      /** Linear velocity in m/s, as [x, y, z]. */
      get velocity() { const v = body.GetLinearVelocity(); return [v.GetX(), v.GetY(), v.GetZ()]; },
      set velocity([x, y, z]) { bodies.SetLinearVelocity(body.GetID(), vec(x, y, z)); },
      impulse([x, y, z]) { bodies.AddImpulse(body.GetID(), vec(x, y, z)); },
      /** Switchable static bodies may become kinematic or dynamic (destructibles). */
      setMotion(motion) {
        if (!desc.switchable && (desc.motion ?? "static") === "static") throw new Error(`body "${id}" is not switchable`);
        const type = { static: Jolt.EMotionType_Static, kinematic: Jolt.EMotionType_Kinematic, dynamic: Jolt.EMotionType_Dynamic }[motion];
        bodies.SetMotionType(body.GetID(), type, motion === "static" ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate);
        bodies.SetObjectLayer(body.GetID(), LAYERS[motion === "static" ? "static" : desc.layer ?? "moving"]);
        entry.dynamic = motion === "dynamic";
        if (entry.dynamic) { readState(entry, 0); readState(entry, 7); }
      },
    };
    entry.api = api;
    return entry;
  }

  function readState(entry, offset) {
    const p = entry.body.GetPosition(), r = entry.body.GetRotation(), s = entry.state;
    s[offset] = p.GetX(); s[offset + 1] = p.GetY(); s[offset + 2] = p.GetZ();
    s[offset + 3] = r.GetX(); s[offset + 4] = r.GetY(); s[offset + 5] = r.GetZ(); s[offset + 6] = r.GetW();
  }

  // The node takes the interpolated world transform of its body, in its parent's space.
  function writeNode(entry, alpha) {
    const s = entry.state, node = entry.node;
    previous.set(s[0], s[1], s[2]); current.set(s[7], s[8], s[9]);
    previousRotation.set(s[3], s[4], s[5], s[6]); currentRotation.set(s[10], s[11], s[12], s[13]);
    position.lerpVectors(previous, current, alpha);
    rotation.slerpQuaternions(previousRotation, currentRotation, alpha);
    const parent = node.parent;
    if (parent && !parent.isScene) {
      parent.updateWorldMatrix(true, false);
      matrix.compose(position, rotation, scale.set(1, 1, 1)).premultiply(matrix2.copy(parent.matrixWorld).invert()).decompose(node.position, node.quaternion, scale);
    } else {
      node.position.copy(position);
      node.quaternion.copy(rotation);
    }
    node.updateMatrixWorld(true);
  }

  function createVehicle(desc, bodyEntry, model) {
    const settings = new Jolt.VehicleConstraintSettings();
    settings.mUp = new Jolt.Vec3(0, 1, 0);
    settings.mForward = new Jolt.Vec3(0, 0, 1);
    settings.mMaxPitchRollAngle = Math.PI / 3;
    const bodyNode = bodyEntry.node, inverse = new THREE.Matrix4().copy(bodyNode.matrixWorld).invert();
    const wheels = desc.wheels.map((w) => {
      const node = model.nodes.get(w.node);
      if (!node) throw new Error(`vehicle "${desc.id}" names unknown wheel node "${w.node}"`);
      matrix.multiplyMatrices(inverse, node.matrixWorld).decompose(position, rotation, scale);
      const suspension = { ...SUSPENSION, ...w.suspension }, rest = suspension.rest ?? suspension.max;
      const s = new Jolt.WheelSettingsWV();
      s.mPosition = new Jolt.Vec3(position.x, position.y + rest, position.z);
      s.mSuspensionMinLength = suspension.min;
      s.mSuspensionMaxLength = suspension.max;
      s.mSuspensionSpring.mFrequency = suspension.frequency;
      s.mSuspensionSpring.mDamping = suspension.damping;
      s.mRadius = w.radius;
      s.mWidth = w.width;
      s.mMaxSteerAngle = w.steer ?? 0;
      s.mMaxBrakeTorque = w.brake ?? 1500;
      s.mMaxHandBrakeTorque = w.handbrake ?? 0;
      settings.mWheels.push_back(s);
      return { id: w.id, node, rest: rotation.clone() };
    });
    const indexOf = (id) => { const i = wheels.findIndex((w) => w.id === id); if (i < 0) throw new Error(`vehicle "${desc.id}" names unknown wheel "${id}"`); return i; };
    for (const bar of desc.antiRoll ?? []) {
      const s = new Jolt.VehicleAntiRollBar();
      s.mLeftWheel = indexOf(bar.wheels[0]); s.mRightWheel = indexOf(bar.wheels[1]); s.mStiffness = bar.stiffness ?? 1000;
      settings.mAntiRollBars.push_back(s);
    }
    const controller = new Jolt.WheeledVehicleControllerSettings();
    const engine = { ...ENGINE, ...desc.engine };
    controller.mEngine.mMaxTorque = engine.maxTorque; controller.mEngine.mMinRPM = engine.minRPM; controller.mEngine.mMaxRPM = engine.maxRPM;
    controller.mTransmission.mMode = Jolt.ETransmissionMode_Auto;
    controller.mTransmission.mGearRatios.clear();
    for (const g of desc.transmission?.gears ?? GEARS) controller.mTransmission.mGearRatios.push_back(g);
    controller.mTransmission.mReverseGearRatios.clear();
    for (const g of desc.transmission?.reverse ?? REVERSE) controller.mTransmission.mReverseGearRatios.push_back(g);
    const differentials = desc.differentials ?? [];
    controller.mDifferentials.resize(differentials.length);
    differentials.forEach((d, i) => {
      const s = controller.mDifferentials.at(i);
      s.mLeftWheel = indexOf(d.wheels[0]); s.mRightWheel = indexOf(d.wheels[1]);
      s.mDifferentialRatio = d.ratio ?? 3.42; s.mLeftRightSplit = d.split ?? 0.5; s.mEngineTorqueRatio = d.engineShare ?? 1; s.mLimitedSlipRatio = d.limitedSlip ?? 1.4;
    });
    settings.mController = controller;
    const constraint = new Jolt.VehicleConstraint(bodyEntry.body, settings);
    const tester = new Jolt.VehicleCollisionTesterCastCylinder(LAYERS.moving, 0.05);
    constraint.SetVehicleCollisionTester(tester);
    system.AddConstraint(constraint);
    const listener = new Jolt.VehicleConstraintStepListener(constraint);
    system.AddStepListener(listener);
    const drive = Jolt.castObject(constraint.GetController(), Jolt.WheeledVehicleController);
    const body = bodyEntry.body;
    // Wheel nodes: Jolt's wheel transform (suspension, steering, spin) in the body's space,
    // times the wheel's authored rotation, written into each node's own parent space.
    function sync() {
      wheels.forEach(({ node, rest }, i) => {
        const t = constraint.GetWheelLocalTransform(i, right, up), p = t.GetTranslation(), r = t.GetQuaternion();
        position.set(p.GetX(), p.GetY(), p.GetZ());
        rotation.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW()).multiply(rest);
        matrix.compose(position, rotation, scale.set(1, 1, 1)).premultiply(bodyNode.matrixWorld);
        if (node.parent !== bodyNode) { node.parent.updateWorldMatrix(true, false); matrix.premultiply(matrix2.copy(node.parent.matrixWorld).invert()); }
        else matrix.premultiply(matrix2.copy(bodyNode.matrixWorld).invert());
        matrix.decompose(node.position, node.quaternion, scale);
      });
    }
    const api = {
      id: desc.id, body: bodyEntry.api,
      /** throttle, brake and handbrake 0–1; steer −1…1 (left negative). */
      drive({ throttle = 0, steer = 0, brake = 0, handbrake = 0 } = {}) {
        drive.SetDriverInput(throttle, steer, brake, handbrake);
        if (throttle || brake || steer || handbrake) bodies.ActivateBody(body.GetID());
      },
      get speed() { const v = body.GetLinearVelocity(); return Math.hypot(v.GetX(), v.GetY(), v.GetZ()); },
      get rpm() { return drive.GetEngine().GetCurrentRPM(); },
      get gear() { return drive.GetTransmission().GetCurrentGear(); },
      wheel(id) { const i = indexOf(id); const w = constraint.GetWheel(i); return { contact: w.HasContact(), suspension: w.GetSuspensionLength(), angularVelocity: w.GetAngularVelocity() }; },
    };
    return { api, sync, remove() { system.RemoveStepListener(listener); system.RemoveConstraint(constraint); Jolt.destroy(listener); } };
  }

  return {
    Jolt, system,
    /** Bodies and vehicles for a loaded model or a placed copy ({ root, nodes, manifest, geometries }). */
    add(model, { scene: world = scene } = {}) {
      const file = model.file ?? model, physics = file.manifest.physics ?? {};
      const handle = { bodies: new Map(), vehicles: new Map(), entries: [], vehicleEntries: [], remove: () => removeHandle(handle) };
      if (disposed) throw new Error("physics is disposed");
      model.root.updateWorldMatrix(true, true);
      const shapeOf = shapesFor(file);
      const problem = (what, error) => warn(`physics: ${what}: ${error.message ?? error}`);
      for (const desc of physics.bodies ?? []) {
        const node = model.nodes.get(desc.node);
        if (!node) { problem(`body "${desc.id}"`, "its node is not in the model"); continue; }
        if ((desc.motion ?? "static") === "kinematic") { problem(`body "${desc.id}"`, "kinematic bodies are not in this release"); continue; }
        let shape;
        try { shape = shapeOf(desc.shape); } catch (error) { problem(`body "${desc.id}"`, error); continue; }
        const placements = node.userData.placements;
        if (placements) {
          // One static body per copy, each copy's matrix in the node's parent space.
          const parent = node.parent?.matrixWorld ?? matrix2.identity();
          for (let i = 0; i < placements.count; i++) {
            matrix.fromArray(placements.transforms, i * 16).premultiply(parent).decompose(position, rotation, scale);
            const entry = entryFor(`${desc.id}@${i}`, createBody(shape, { ...desc, motion: "static" }, position, rotation, scale.x), node, { ...desc, motion: "static" });
            handle.entries.push(entry);
          }
          continue;
        }
        node.matrixWorld.decompose(position, rotation, scale);
        const entry = entryFor(desc.id, createBody(shape, desc, position, rotation, scale.x), node, desc);
        handle.entries.push(entry);
        handle.bodies.set(desc.id, entry.api);
        // A dynamic body owns its node: the node leaves the hierarchy so the body's world
        // transform is its own, children (wheels, lights) following it.
        if (entry.dynamic && world && node.parent !== world) world.attach(node);
      }
      for (const desc of physics.vehicles ?? []) {
        const bodyEntry = handle.entries.find((e) => e.id === desc.body);
        if (!bodyEntry) { problem(`vehicle "${desc.id}"`, "its body was not built"); continue; }
        try {
          const vehicle = createVehicle(desc, bodyEntry, model);
          handle.vehicleEntries.push(vehicle);
          handle.vehicles.set(desc.id, vehicle.api);
        } catch (error) { problem(`vehicle "${desc.id}"`, error); }
      }
      for (const [key, label] of [["constraints", "constraints"], ["ragdolls", "ragdolls"], ["characters", "characters"]]) {
        if (physics[key]?.length) problem(label, "not in this release; skipped");
      }
      handles.add(handle);
      return handle;
    },
    /** A body with no model, e.g. the ground: shape as in a file, placed at `position`/`rotation`. */
    addStatic(shapeDesc, { position: at = [0, 0, 0], rotation: turn = [0, 0, 0, 1], motion = "static", object = null, ...desc } = {}) {
      const file = { manifest: { physics: { shapes: [{ ...shapeDesc, id: "shape" }] } }, physicsData: { points: new Map([["shape", shapeDesc.points ?? null]]) } };
      const node = object ?? new THREE.Object3D();
      if (!object) { node.position.fromArray(at); node.quaternion.fromArray(turn); }
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(position, rotation, scale);
      const entry = entryFor("static", createBody(shapesFor(file)("shape"), { ...desc, motion }, position, rotation, scale.x), node, { ...desc, motion });
      const handle = { bodies: new Map([["static", entry.api]]), vehicles: new Map(), entries: [entry], vehicleEntries: [], remove: () => removeHandle(handle) };
      handles.add(handle);
      return entry.api;
    },
    /** Advances the world by `dt` seconds in fixed steps and writes the nodes of dynamic bodies. */
    step(dt) {
      if (disposed) return;
      accumulator = Math.min(accumulator + Math.max(0, dt), step * maxSteps);
      let steps = 0;
      while (accumulator >= step && steps < maxSteps) {
        for (const handle of handles) for (const entry of handle.entries) if (entry.dynamic) entry.state.copyWithin(0, 7, 14);
        jolt.Step(step, 1);
        for (const handle of handles) for (const entry of handle.entries) if (entry.dynamic) readState(entry, 7);
        accumulator -= step;
        steps++;
      }
      const alpha = accumulator / step;
      for (const handle of handles) {
        for (const entry of handle.entries) if (entry.dynamic) writeNode(entry, alpha);
        for (const vehicle of handle.vehicleEntries) vehicle.sync();
      }
    },
    dispose() {
      if (disposed) return;
      for (const handle of [...handles]) removeHandle(handle);
      disposed = true;
      Jolt.destroy(jolt);
    },
  };

  function removeHandle(handle) {
    if (!handles.delete(handle)) return;
    for (const vehicle of handle.vehicleEntries) vehicle.remove();
    for (const entry of handle.entries) { const id = entry.body.GetID(); bodies.RemoveBody(id); bodies.DestroyBody(id); }
    handle.entries.length = 0;
    handle.vehicleEntries.length = 0;
  }
}
