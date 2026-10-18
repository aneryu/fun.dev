// Jolt Physics for fun.dev (docs/model-format.md#physics). One world per game; a .fun3d model's
// physics (shapes, bodies, wheeled vehicles, ragdolls) becomes Jolt objects that drive the
// model's Three.js objects. Loaded on first use (about 0.6 MB compressed).
//
//   const physics = await createPhysics({ THREE });
//   const car = physics.add(model);            // model = await fun3d.load(bytes), placed in the scene
//   car.vehicle.drive({ throttle: 1, steer: 0.3 });
//   const person = physics.add(character);
//   person.ragdoll.activate();                 // from the pose the animation left
//   physics.step(dt);                          // then render

const STATIC = 0, MOVING = 1;

export async function createPhysics({ THREE, url = "/vendor/jolt/jolt-physics.wasm.js", gravity = 9.81 } = {}) {
  const Jolt = await (await import(url)).default();
  const settings = new Jolt.JoltSettings();
  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objectFilter.EnableCollision(STATIC, MOVING);
  objectFilter.EnableCollision(MOVING, MOVING);
  const layers = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  layers.MapObjectToBroadPhaseLayer(STATIC, new Jolt.BroadPhaseLayer(0));
  layers.MapObjectToBroadPhaseLayer(MOVING, new Jolt.BroadPhaseLayer(1));
  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = layers;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(layers, 2, objectFilter, 2);
  const jolt = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  const system = jolt.GetPhysicsSystem(), bodies = system.GetBodyInterface();
  system.SetGravity(new Jolt.Vec3(0, -gravity, 0));

  const vec3 = (v) => new Jolt.Vec3(v.x, v.y, v.z), rvec3 = (v) => new Jolt.RVec3(v.x, v.y, v.z);
  const quat = (q) => new Jolt.Quat(q.x, q.y, q.z, q.w);
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), matrix = new THREE.Matrix4();
  const synced = [], updates = [];
  let group = 1;

  function created(shapeSettings) {
    const result = shapeSettings.Create();
    if (result.HasError()) throw new Error(`Jolt shape: ${result.GetError().c_str()}`);
    return result.Get();
  }

  // Shapes are described in the model root's space.
  function shapeOf(desc, model) {
    switch (desc.type) {
      case "box": return created(new Jolt.BoxShapeSettings(new Jolt.Vec3(...desc.halfExtents), Math.min(0.05, ...desc.halfExtents.map((v) => v * 0.2))));
      case "sphere": return created(new Jolt.SphereShapeSettings(desc.radius));
      case "capsule": return created(new Jolt.CapsuleShapeSettings(desc.halfHeight, desc.radius));
      case "cylinder": return created(new Jolt.CylinderShapeSettings(desc.halfHeight, desc.radius, Math.min(0.05, desc.radius * 0.2)));
      case "convex": {
        const hull = new Jolt.ConvexHullShapeSettings();
        for (let i = 0; i < desc.points.length; i += 3) hull.mPoints.push_back(new Jolt.Vec3(desc.points[i], desc.points[i + 1], desc.points[i + 2]));
        return created(hull);
      }
      case "mesh": {
        // Every visible mesh of the model, in the root's space.
        const triangles = new Jolt.TriangleList(), root = model.scene, inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        root.updateMatrixWorld(true);
        root.traverse((o) => {
          if (!o.isMesh || !o.visible) return;
          const m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld), p = o.geometry.getAttribute("position"), ix = o.geometry.index;
          const n = ix ? ix.count : p.count;
          for (let i = 0; i < n; i += 3) {
            const [i0, i1, i2] = [0, 1, 2].map((k) => (ix ? ix.getX(i + k) : i + k));
            a.fromBufferAttribute(p, i0).applyMatrix4(m); b.fromBufferAttribute(p, i1).applyMatrix4(m); c.fromBufferAttribute(p, i2).applyMatrix4(m);
            triangles.push_back(new Jolt.Triangle(vec3(a), vec3(b), vec3(c)));
          }
        });
        return created(new Jolt.MeshShapeSettings(triangles));
      }
      default: throw new Error(`Unknown shape "${desc.type}"`);
    }
  }

  function bodyFor(shape, object, desc) {
    object.updateWorldMatrix(true, false);
    object.matrixWorld.decompose(position, rotation, scale);
    const motion = { static: Jolt.EMotionType_Static, kinematic: Jolt.EMotionType_Kinematic, dynamic: Jolt.EMotionType_Dynamic }[desc.motion ?? "static"];
    const creation = new Jolt.BodyCreationSettings(shape, rvec3(position), quat(rotation), motion, desc.motion === "static" || !desc.motion ? STATIC : MOVING);
    creation.mFriction = desc.friction ?? 0.5;
    creation.mRestitution = desc.restitution ?? 0.1;
    creation.mLinearDamping = desc.linearDamping ?? 0.05;
    creation.mAngularDamping = desc.angularDamping ?? 0.05;
    if (desc.mass) {
      creation.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
      creation.mMassPropertiesOverride.mMass = desc.mass;
    }
    const body = bodies.CreateBody(creation);
    Jolt.destroy(creation);
    bodies.AddBody(body.GetID(), desc.motion === "dynamic" ? Jolt.EActivation_Activate : Jolt.EActivation_DontActivate);
    return body;
  }

  // Dynamic bodies move their object (in world space, whatever its parent).
  function follow(object, body) {
    synced.push({ object, body });
  }

  function vehicleFor(desc, body, model) {
    const settings = new Jolt.VehicleConstraintSettings();
    settings.mUp = new Jolt.Vec3(0, 1, 0);
    settings.mForward = new Jolt.Vec3(0, 0, 1);
    settings.mMaxPitchRollAngle = Math.PI / 3;
    const wheels = desc.wheels.map((w) => {
      const s = new Jolt.WheelSettingsWV();
      const travel = (w.suspension.min + w.suspension.max) / 2;
      s.mPosition = new Jolt.Vec3(w.position[0], w.position[1] + travel, w.position[2]);
      s.mSuspensionMinLength = w.suspension.min;
      s.mSuspensionMaxLength = w.suspension.max;
      s.mSuspensionSpring.mFrequency = w.suspension.frequency;
      s.mSuspensionSpring.mDamping = w.suspension.damping;
      s.mRadius = w.radius;
      s.mWidth = w.width;
      s.mMaxSteerAngle = w.steer ?? 0;
      s.mMaxBrakeTorque = w.brake ?? 1500;
      s.mMaxHandBrakeTorque = w.handbrake ?? 0;
      settings.mWheels.push_back(s);
      return w;
    });
    const controller = new Jolt.WheeledVehicleControllerSettings();
    controller.mEngine.mMaxTorque = desc.engine.maxTorque;
    controller.mEngine.mMinRPM = desc.engine.minRPM;
    controller.mEngine.mMaxRPM = desc.engine.maxRPM;
    controller.mTransmission.mMode = desc.transmission.mode === "manual" ? Jolt.ETransmissionMode_Manual : Jolt.ETransmissionMode_Auto;
    controller.mTransmission.mGearRatios.clear();
    for (const g of desc.transmission.gears) controller.mTransmission.mGearRatios.push_back(g);
    controller.mTransmission.mReverseGearRatios.clear();
    for (const g of desc.transmission.reverse) controller.mTransmission.mReverseGearRatios.push_back(g);
    controller.mDifferentials.resize(desc.differentials.length);
    desc.differentials.forEach((d, i) => {
      const s = controller.mDifferentials.at(i);
      s.mLeftWheel = d.left;
      s.mRightWheel = d.right;
      s.mDifferentialRatio = d.ratio;
      s.mEngineTorqueRatio = d.share;
    });
    settings.mController = controller;
    const constraint = new Jolt.VehicleConstraint(body, settings);
    constraint.SetVehicleCollisionTester(new Jolt.VehicleCollisionTesterCastCylinder(MOVING, 0.05));
    system.AddConstraint(constraint);
    system.AddStepListener(new Jolt.VehicleConstraintStepListener(constraint));
    const drive = Jolt.castObject(constraint.GetController(), Jolt.WheeledVehicleController);
    // Wheels: Jolt's transform (suspension, steering, spin) times the wheel's authored rotation.
    const nodes = wheels.map((w) => {
      const node = typeof w.node === "string" ? model.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(w.node)) : w.node;
      return { node, rest: node.quaternion.clone() };
    });
    const right = new Jolt.Vec3(1, 0, 0), up = new Jolt.Vec3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    updates.push(() => {
      nodes.forEach(({ node, rest }, i) => {
        const t = constraint.GetWheelLocalTransform(i, right, up);
        const translation = t.GetTranslation(), r = t.GetQuaternion();
        p.set(translation.GetX(), translation.GetY(), translation.GetZ());
        q.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
        node.position.copy(p);
        node.quaternion.copy(q).multiply(rest);
        m.compose(p, q, s.set(1, 1, 1));
      });
    });
    return {
      drive({ throttle = 0, brake = 0, steer = 0, handbrake = 0 } = {}) {
        drive.SetDriverInput(throttle, steer, brake, handbrake);
        if (throttle || brake || steer || handbrake) bodies.ActivateBody(body.GetID());
      },
      get speed() { const v = body.GetLinearVelocity(); return Math.hypot(v.GetX(), v.GetY(), v.GetZ()); },
      get rpm() { return drive.GetEngine().GetCurrentRPM(); },
      get gear() { return drive.GetTransmission().GetCurrentGear(); },
    };
  }

  // A ragdoll is built from the pose the skeleton has when it is activated.
  function ragdollFor(desc, model) {
    const named = (value) => (typeof value === "string" ? model.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(value)) : value);
    let ragdoll = null, parts = null;
    function activate({ velocity = [0, 0, 0] } = {}) {
      if (ragdoll) return;
      model.scene.updateMatrixWorld(true);
      const settings = new Jolt.RagdollSettings(), skeleton = settings.GetSkeleton();
      const index = new Map(desc.parts.map((p, i) => [p.name, i]));
      parts = desc.parts.map((p) => {
        const bone = named(p.joint), end = p.to ? named(p.to) : null;
        const head = bone.getWorldPosition(new THREE.Vector3());
        const boneRotation = bone.getWorldQuaternion(new THREE.Quaternion());
        const tail = end ? end.getWorldPosition(new THREE.Vector3()) : head.clone().add(new THREE.Vector3(0, p.length ?? 0.2, 0).applyQuaternion(boneRotation));
        const axis = tail.clone().sub(head), length = Math.max(axis.length(), 0.02);
        axis.normalize();
        // Capsule along the bone, from its joint to the next part's joint.
        const center = head.clone().add(tail).multiplyScalar(0.5);
        const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        const capsuleWorld = new THREE.Matrix4().compose(center, orientation, new THREE.Vector3(1, 1, 1));
        const offset = new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(capsuleWorld);
        return { desc: p, bone, head, axis, length, center, orientation, offset };
      });
      parts.forEach((part, i) => {
        skeleton.AddJoint(new Jolt.JPHString(part.desc.name, part.desc.name.length), part.desc.parent ? index.get(part.desc.parent) : -1);
      });
      settings.mParts.resize(parts.length);
      parts.forEach((part, i) => {
        const s = settings.mParts.at(i), p = part.desc;
        s.SetShape(created(new Jolt.CapsuleShapeSettings(Math.max(0.01, part.length / 2 - p.radius * 0.5), p.radius)));
        s.mPosition = rvec3(part.center);
        s.mRotation = quat(part.orientation);
        s.mMotionType = Jolt.EMotionType_Dynamic;
        s.mObjectLayer = MOVING;
        s.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
        s.mMassPropertiesOverride.mMass = p.mass;
        s.mLinearVelocity = new Jolt.Vec3(...velocity);
        if (p.parent) {
          const c = new Jolt.SwingTwistConstraintSettings();
          c.mSpace = Jolt.EConstraintSpace_WorldSpace;
          c.mPosition1 = c.mPosition2 = rvec3(part.head);
          c.mTwistAxis1 = c.mTwistAxis2 = vec3(part.axis);
          const plane = new THREE.Vector3(1, 0, 0).applyQuaternion(part.orientation);
          c.mPlaneAxis1 = c.mPlaneAxis2 = vec3(plane);
          c.mNormalHalfConeAngle = c.mPlaneHalfConeAngle = p.limits.cone;
          c.mTwistMinAngle = p.limits.twist[0];
          c.mTwistMaxAngle = p.limits.twist[1];
          s.mToParent = c;
        }
      });
      settings.Stabilize();
      settings.DisableParentChildCollisions();
      settings.CalculateBodyIndexToConstraintIndex();
      settings.CalculateConstraintIndexToBodyIdxPair();
      ragdoll = settings.CreateRagdoll(group++, 0, system);
      ragdoll.AddToPhysicsSystem(Jolt.EActivation_Activate);
      updates.push(syncBones);
    }
    // Bones of the parts follow their bodies; bones between parts keep their local pose.
    const world = new THREE.Matrix4(), parentInverse = new THREE.Matrix4(), offsetInverse = new THREE.Matrix4();
    function syncBones() {
      parts.forEach((part, i) => {
        const id = ragdoll.GetBodyID(i), t = bodies.GetPosition(id), r = bodies.GetRotation(id);
        world.compose(position.set(t.GetX(), t.GetY(), t.GetZ()), rotation.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW()), scale.set(1, 1, 1));
        world.multiply(offsetInverse.copy(part.offset).invert());
        part.bone.parent.updateWorldMatrix(true, false);
        parentInverse.copy(part.bone.parent.matrixWorld).invert();
        matrix.multiplyMatrices(parentInverse, world).decompose(part.bone.position, part.bone.quaternion, scale);
        part.bone.updateMatrixWorld(true);
      });
    }
    return { activate, get active() { return !!ragdoll; } };
  }

  return {
    Jolt, system,
    /** Bodies, vehicles and ragdolls for a loaded .fun3d model (its scene placed where it starts). */
    add(model, { motion } = {}) {
      const physics = model.physics ?? {};
      const shapes = (physics.shapes ?? []).map((s) => (s.type === "capsule" && physics.character ? null : shapeOf(s, model)));
      const handle = { bodies: [] };
      for (const desc of physics.bodies ?? []) {
        const object = desc.node?.isObject3D ? desc.node : model.scene;
        const body = bodyFor(shapes[desc.shape], object, { ...desc, ...(motion ? { motion } : {}) });
        handle.bodies.push(body);
        if ((motion ?? desc.motion) === "dynamic") follow(object, body);
      }
      if (physics.vehicles?.length) handle.vehicle = vehicleFor(physics.vehicles[0], handle.bodies[physics.vehicles[0].body], model);
      if (physics.ragdolls?.length) handle.ragdoll = ragdollFor(physics.ragdolls[0], model);
      return handle;
    },
    /** A static box, e.g. the ground. */
    addBox(center, halfExtents, { motion = "static", mass, object } = {}) {
      const shape = shapeOf({ type: "box", halfExtents }, null);
      const holder = object ?? new THREE.Object3D();
      if (!object) holder.position.set(...center);
      const body = bodyFor(shape, holder, { motion, mass, friction: 0.8 });
      if (motion === "dynamic") follow(holder, body);
      return body;
    },
    step(dt) {
      jolt.Step(Math.min(dt, 1 / 30), dt > 1 / 55 ? 2 : 1);
      for (const { object, body } of synced) {
        const t = body.GetPosition(), r = body.GetRotation();
        position.set(t.GetX(), t.GetY(), t.GetZ());
        rotation.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
        if (object.parent && !object.parent.isScene) {
          object.parent.updateWorldMatrix(true, false);
          matrix.compose(position, rotation, scale.set(1, 1, 1)).premultiply(new THREE.Matrix4().copy(object.parent.matrixWorld).invert());
          matrix.decompose(object.position, object.quaternion, scale);
        } else {
          object.position.copy(position);
          object.quaternion.copy(rotation);
        }
      }
      for (const update of updates) update();
    },
  };
}
