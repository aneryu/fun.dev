"""Builds the Slap head, hand and default-face assets from CC0 MakeHuman data.

Run through dev/build-assets.sh (Blender 5.2 with the MPFB 2 extension and the
MakeHuman system asset pack linked into MPFB's user data directory).

Outputs into dev/out/:
  head.json/.bin   welded physics mesh, render mesh, morph targets, accessories
  head.png         lighting baked into the head texture (Cycles)
  hand.json/.bin, hand.png
  front.png        frontal render of the rest pose, used to register photo UVs
  front.json       image-space position and visibility of every physics vertex
"""

import bpy, bmesh, json, math, os, struct, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from bpy_extras.object_utils import world_to_camera_view

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out")
os.makedirs(OUT, exist_ok=True)
MPFB = os.path.dirname(os.path.dirname(os.path.abspath(sys.modules[HumanService.__module__].__file__)))
UNITS = os.path.join(MPFB, "data", "targets", "expression", "units", "asian")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW = "preview" in ARGS
BAKE_SIZE = 2048

# A middle-aged, slightly well-fed man: the boss who replies "收到" and nothing else.
PHENOTYPE = {"gender": 1.0, "age": 0.72, "weight": 0.7, "muscle": 0.4, "proportions": 0.5, "height": 0.5,
             "race": {"asian": 1.0, "caucasian": 0.0, "african": 0.0}}
DETAILS = {  # MakeHuman modifier targets: file -> weight
    "head/head-fat-incr": 0.5, "head/head-age-incr": 0.4,
    "cheek/l-cheek-volume-incr": 0.6, "cheek/r-cheek-volume-incr": 0.6,
    "chin/chin-width-incr": 0.3, "chin/chin-prominent-decr": 0.3,
    "nose/nose-scale-horiz-incr": 0.25,
}
# Expression units (FACS-like, symmetric unless suffixed @L / @R for one side of the face).
SMUG = {"mouth-corner-puller@L": 1.0, "mouth-upward-retraction@L": 0.15, "mouth-compression": 0.25, "eyebrows-left-up": 1.0, "eyebrows-right-down": 0.45,
        "eye-left-slit": 0.15, "eye-right-slit": 0.35, "nose-left-elevation": 0.25}
# Expressions relative to a neutral face; "neutral" undoes the smug rest pose (photos, and
# whenever another expression takes over).
MORPHS = {
    "neutral": {name: -weight for name, weight in SMUG.items()},
    "shock": {"eyebrows-left-up": 1.0, "eyebrows-right-up": 1.0, "eye-left-opened-up": 0.9, "eye-right-opened-up": 0.9, "mouth-open": 0.55},
    "sad": {"eyebrows-left-inner-up": 1.0, "eyebrows-right-inner-up": 1.0, "eyebrows-left-up": 0.2, "mouth-depression": 0.8, "mouth-pursing": 0.3,
            "eye-left-slit": 0.4, "eye-right-slit": 0.45, "neck-platysma": 0.3},
    "wince": {"eye-left-closure": 0.9, "eye-right-closure": 0.9, "nose-compression": 0.6, "mouth-retraction": 0.6, "eyebrows-left-down": 0.4, "eyebrows-right-down": 0.4},
}


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def create_human():
    info = HumanService._create_default_human_info_dict()
    info["phenotype"].update(PHENOTYPE)
    info["eyes"] = "eyes/low-poly/low-poly.mhclo"
    info["eyebrows"] = "eyebrows/eyebrow009/eyebrow009.mhclo"
    info["eyelashes"] = "eyelashes/eyelashes01/eyelashes01.mhclo"
    info["skin_mhmat"] = "skins/middleage_asian_male/middleage_asian_male.mhmat"
    info["skin_material_type"] = "ENHANCED_SSS"
    settings = HumanService.get_default_deserialization_settings()
    settings["subdiv_levels"] = 0
    body = HumanService.deserialize_from_dict(info, settings)
    for name, weight in DETAILS.items():
        TargetService.load_target(body, os.path.join(MPFB, "data", "targets", name + ".target.gz"), weight=weight, name="d_" + name.replace("/", "_"))
    return body


def coords(obj):
    out = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", out)
    return out.reshape(-1, 3)


def unit_delta(body, name):
    """Offset of one expression unit at weight 1, optionally masked to one side of the face."""
    side = None
    if name.endswith("@L") or name.endswith("@R"):
        name, side = name[:-2], name[-1]
    TargetService.load_target(body, os.path.join(UNITS, name + ".target.gz"), weight=1.0, name="u_" + name)
    block = body.data.shape_keys.key_blocks["u_" + name]
    basis = body.data.shape_keys.key_blocks[0]
    a = np.empty(len(block.data) * 3); block.data.foreach_get("co", a)
    b = np.empty(len(basis.data) * 3); basis.data.foreach_get("co", b)
    body.shape_key_remove(block)
    delta = (a - b).reshape(-1, 3)
    if side:
        x = coords(body)[:, 0]
        # MakeHuman's +X is the character's left.
        w = np.clip(0.5 + (x if side == "L" else -x) * 40, 0, 1)
        delta *= w[:, None]
    return delta


def mix(body, units, cache):
    total = np.zeros((len(body.data.vertices), 3))
    for name, weight in units.items():
        if name not in cache:
            cache[name] = unit_delta(body, name)
        total += cache[name] * weight
    return total


def set_coords(obj, co):
    obj.data.vertices.foreach_set("co", co.astype(np.float32).ravel())
    obj.data.update()


def build_character():
    clear()
    body = create_human()
    TargetService.bake_targets(body)
    body.shape_key_add(name="Basis")
    cache = {}
    rest = coords(body) + mix(body, SMUG, cache)
    morphs = {name: mix(body, units, cache) for name, units in MORPHS.items()}
    body.shape_key_clear()
    set_coords(body, rest)
    for obj in list(bpy.data.objects):
        if obj is not body and obj.type == "MESH":
            HumanService.refit(obj)
            break
    return body, morphs


def accessories(body):
    found = {}
    for obj in bpy.data.objects:
        if obj is body or obj.type != "MESH":
            continue
        for key in ("eyebrow", "eyelashes", "low-poly"):
            if key in obj.name:
                found[{"low-poly": "eyes", "eyebrow": "brows", "eyelashes": "lashes"}[key]] = obj
    return found


JOINTS = {}


def joint(body, group):
    if group in JOINTS:
        return JOINTS[group].copy()
    g = body.vertex_groups[group].index
    pts = [body.matrix_world @ v.co for v in body.data.vertices if any(e.group == g for e in v.groups)]
    return sum(pts, Vector()) / len(pts)


def cut_portrait(body, morphs):
    """Keeps head, neck and shoulders; drops MakeHuman helper geometry and everything below the chest."""
    neck = joint(body, "joint-neck")
    drop_groups = {body.vertex_groups[g].index for g in ("HelperGeometry", "JointCubes") if g in body.vertex_groups}
    keep = np.array([v.co.z > neck.z - 0.16 and not any(e.group in drop_groups and e.weight > 0.5 for e in v.groups) for v in body.data.vertices])
    bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context="VERTS")
    bm.to_mesh(body.data); bm.free()
    for mod in list(body.modifiers):
        body.modifiers.remove(mod)
    return {k: v[keep] for k, v in morphs.items()}


def pack_bake_uv(body):
    """A second UV map that packs only the kept islands, so the bake uses the whole texture."""
    src = body.data.uv_layers[0]
    source_name = src.name
    bake = body.data.uv_layers.new(name="bake")
    for i, d in enumerate(src.data):
        bake.data[i].uv = d.uv
    body.data.uv_layers.active = bake
    bpy.context.view_layer.objects.active = body
    for o in bpy.context.view_layer.objects: o.select_set(o is body)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin=0.003, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    # Edit mode rebuilds the layers, so look the source map up again by name.
    body.data.uv_layers.active = body.data.uv_layers[source_name]


def hires_copy(body, levels=3):
    copy = body.copy(); copy.data = body.data.copy(); copy.name = "bake_hi"
    bpy.context.scene.collection.objects.link(copy)
    mod = copy.modifiers.new("sub", "SUBSURF"); mod.levels = mod.render_levels = levels
    mod.uv_smooth = "PRESERVE_BOUNDARIES"
    bpy.context.view_layer.objects.active = copy
    bpy.ops.object.modifier_apply(modifier="sub")
    for v in copy.vertex_groups: pass
    return copy


def pose_fingers(body, together=0.75, thumb=0.3):
    """Closes the A-pose finger fan into a flat slapping hand (right hand), then removes the rig."""
    rig = HumanService.add_builtin_rig(body, "default")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bones = rig.pose.bones
    middle = (bones["finger3-1.R"].bone.matrix_local.to_3x3() @ Vector((0, 1, 0))).normalized()
    for name, amount in (("finger2-1.R", together), ("finger4-1.R", together), ("finger5-1.R", together), ("finger1-1.R", thumb)):
        bone = bones[name]
        basis = bone.bone.matrix_local.to_3x3()
        own = (basis @ Vector((0, 1, 0))).normalized()
        target = own.lerp(middle, amount).normalized()
        world = own.rotation_difference(target)
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = (basis.inverted() @ world.to_matrix() @ basis).to_quaternion()
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.objects.active = body
    for mod in body.modifiers:
        if mod.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=mod.name)
    body.parent = None
    for obj in list(bpy.data.objects):
        if obj.type == "ARMATURE":
            bpy.data.objects.remove(obj)


def extract_hand(body):
    """The character's right hand with half a forearm, as its own object (made before the portrait cut)."""
    elbow, wrist = JOINTS["joint-r-elbow"], JOINTS["joint-r-hand"]
    axis = (wrist - elbow).normalized()
    length = (wrist - elbow).length
    drop = {body.vertex_groups[g].index for g in ("HelperGeometry", "JointCubes") if g in body.vertex_groups}
    keep = []
    for v in body.data.vertices:
        d = v.co - elbow
        along = d.dot(axis)
        radial = (d - axis * along).length
        keep.append(along > 0.8 * length and radial < 0.09 and not any(e.group in drop and e.weight > 0.5 for e in v.groups))
    hand = body.copy(); hand.data = body.data.copy(); hand.name = "hand"
    bpy.context.scene.collection.objects.link(hand)
    if hand.data.shape_keys:
        hand.shape_key_clear()
    bm = bmesh.new(); bm.from_mesh(hand.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context="VERTS")
    # Close the cut forearm so its end never shows as an open tube.
    filled = bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)["faces"]
    # New cap faces have no UVs; borrow each corner's UV from an existing face.
    for layer in bm.loops.layers.uv.values():
        for face in filled:
            for loop in face.loops:
                other = next((l for l in loop.vert.link_loops if l.face not in filled), None)
                if other:
                    loop[layer].uv = other[layer].uv
    # Give the cap its own vertices so its normals don't darken the wrist.
    cap_edges = {e for f in filled for e in f.edges if any(lf not in filled for lf in e.link_faces)}
    bmesh.ops.split_edges(bm, edges=list(cap_edges))
    bm.to_mesh(hand.data); bm.free()
    for mod in list(hand.modifiers):
        hand.modifiers.remove(mod)
    masks = hand.data.color_attributes.new("masks", "FLOAT_COLOR", "POINT")
    masks.data.foreach_set("color", np.tile([0.0, 0.0, 0.0, 1.0], len(hand.data.vertices)).astype(np.float32))
    return hand


def hand_frame():
    """Palm centre and axes: Y along the fingers, Z out of the palm, X towards the thumb side."""
    wrist, middle = JOINTS["joint-r-hand"], JOINTS["joint-r-finger-3-1"]
    index, little = JOINTS["joint-r-finger-2-1"], JOINTS["joint-r-finger-5-1"]
    y = (middle - wrist).normalized()
    across = (index - little).normalized()
    z = across.cross(y).normalized()
    x = y.cross(z).normalized()
    centre = wrist.lerp(middle, 0.55)
    return centre, x, y, z


def export_hand(hand):
    centre, x, y, z = hand_frame()
    co = world(hand) - np.array(centre)
    local = np.stack([co @ np.array(x), co @ np.array(y), co @ np.array(z)], 1)
    # The palm should face +Z (towards the face it slaps); flip if the mesh says otherwise.
    blob = Blob()
    source, uvs, tris = split_render_vertices(hand, "bake")
    blob.add("position", local, np.float32)
    blob.add("renderSource", source, np.uint16)
    blob.add("renderUv", uvs, np.float32)
    blob.add("index", tris, np.uint16)
    blob.save("hand", {"vertices": len(local), "renderVertices": len(source)})


def bake_albedo(obj, image_name, size):
    image = bpy.data.images.new(image_name, size, size, alpha=False)
    for mat in obj.data.materials:
        node = mat.node_tree.nodes.new("ShaderNodeTexImage"); node.image = image
        mat.node_tree.nodes.active = node
    obj.data.uv_layers.active = obj.data.uv_layers["bake"]
    for o in bpy.context.view_layer.objects: o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    scene = bpy.context.scene
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.margin = 8
    bpy.ops.object.bake(type="DIFFUSE")
    scene.view_settings.view_transform = "Standard"
    image.save_render(os.path.join(OUT, image_name + ".png"), scene=scene)
    scene.view_settings.view_transform = "AgX"


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def paint_masks(body):
    """R: buzz-cut scalp, G: crew-neck T-shirt, B: lips (vertex colour, used by the bake material)."""
    co = coords(body)
    eye = (joint(body, "joint-l-eye") + joint(body, "joint-r-eye")) / 2
    centre_y = joint(body, "joint-head").y + 0.01
    theta = np.abs(np.degrees(np.arctan2(co[:, 0], -(co[:, 1] - centre_y))))
    # Hairline height above the eyes by angle around the head (0 = forehead, 180 = nape).
    hairline = np.interp(theta, [0, 35, 60, 85, 110, 140, 180], [0.06, 0.057, 0.044, 0.034, 0.018, -0.03, -0.07])
    jitter = 0.0015 * np.sin(co[:, 0] * 260 + 1.3) * np.cos(co[:, 1] * 210)
    hair = smoothstep(hairline - 0.008, hairline + 0.014, co[:, 2] - eye.z + jitter)
    ears = np.zeros(len(co))
    g = body.vertex_groups["ears"].index
    for v in body.data.vertices:
        if any(e.group == g and e.weight > 0.1 for e in v.groups):
            ears[v.index] = 1
    hair *= 1 - ears
    neck = joint(body, "joint-neck")
    neckline = neck.z + np.interp(theta, [0, 45, 90, 135, 180], [-0.055, -0.05, -0.035, -0.02, -0.015])
    radius = np.hypot(co[:, 0], co[:, 1] - neck.y)
    shirt = 1 - smoothstep(neckline - 0.004, neckline + 0.004, co[:, 2])
    shirt = np.maximum(shirt, smoothstep(0.082, 0.098, radius) * (1 - smoothstep(neck.z - 0.012, neck.z, co[:, 2])))
    attr = body.data.color_attributes.new("masks", "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", np.stack([hair, shirt, np.zeros(len(co)), np.ones(len(co))], 1).astype(np.float32).ravel())
    return eye


def skin_material(body):
    tex_path = [i.filepath for i in bpy.data.images if "diffuse" in i.name.lower() or "skin" in i.filepath.lower()]
    mat = bpy.data.materials.new("slap_skin")
    nt = mat.node_tree
    nt.nodes.clear()
    n = nt.nodes.new
    out = n("ShaderNodeOutputMaterial")
    bsdf = n("ShaderNodeBsdfPrincipled")
    img = n("ShaderNodeTexImage")
    img.image = bpy.data.images.load(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../sources/makehuman/skins/middleage_asian_male/middleage_lightskinned_male_diffuse2.png"))
    uv = n("ShaderNodeUVMap"); uv.uv_map = body.data.uv_layers[0].name
    masks = n("ShaderNodeAttribute"); masks.attribute_name = "masks"
    sep = n("ShaderNodeSeparateColor")
    noise = n("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 1400; noise.inputs["Detail"].default_value = 2
    fabric = n("ShaderNodeTexNoise"); fabric.inputs["Scale"].default_value = 400; fabric.inputs["Detail"].default_value = 6
    tone = n("ShaderNodeHueSaturation"); tone.inputs["Saturation"].default_value = 1.08; tone.inputs["Value"].default_value = 0.92
    stubble = n("ShaderNodeMath"); stubble.operation = "MULTIPLY_ADD"
    hair_mix = n("ShaderNodeMix"); hair_mix.data_type = "RGBA"; hair_mix.inputs["B"].default_value = (0.035, 0.03, 0.027, 1)
    shirt_col = n("ShaderNodeMix"); shirt_col.data_type = "RGBA"
    shirt_col.inputs["A"].default_value = (0.022, 0.024, 0.03, 1); shirt_col.inputs["B"].default_value = (0.04, 0.042, 0.05, 1)
    shirt_mix = n("ShaderNodeMix"); shirt_mix.data_type = "RGBA"
    rough = n("ShaderNodeMix"); rough.inputs["A"].default_value = 0.48; rough.inputs["B"].default_value = 0.9
    L = nt.links.new
    L(uv.outputs[0], img.inputs[0]); L(img.outputs[0], tone.inputs["Color"])
    L(masks.outputs["Color"], sep.inputs[0])
    L(noise.outputs["Fac"], stubble.inputs[0]); stubble.inputs[1].default_value = 0.35; L(sep.outputs["Red"], stubble.inputs[2])
    hair_amt = n("ShaderNodeMath"); hair_amt.operation = "MULTIPLY"; L(sep.outputs["Red"], hair_amt.inputs[0]); L(stubble.outputs[0], hair_amt.inputs[1])
    clamp = n("ShaderNodeClamp"); L(hair_amt.outputs[0], clamp.inputs[0])
    L(clamp.outputs[0], hair_mix.inputs["Factor"]); L(tone.outputs[0], hair_mix.inputs["A"])
    L(fabric.outputs["Fac"], shirt_col.inputs["Factor"])
    L(sep.outputs["Green"], shirt_mix.inputs["Factor"]); L(hair_mix.outputs["Result"], shirt_mix.inputs["A"]); L(shirt_col.outputs["Result"], shirt_mix.inputs["B"])
    L(sep.outputs["Green"], rough.inputs["Factor"])
    L(shirt_mix.outputs["Result"], bsdf.inputs["Base Color"])
    L(rough.outputs["Result"], bsdf.inputs["Roughness"])
    bsdf.inputs["Subsurface Weight"].default_value = 0.12
    bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
    bsdf.inputs["Subsurface Scale"].default_value = 0.012
    L(bsdf.outputs[0], out.inputs[0])
    body.data.materials.clear(); body.data.materials.append(mat)
    return mat


def studio(target_z):
    """Soft frontal studio light (photos already carry their own lighting)."""
    scene = bpy.context.scene
    for name, loc, energy, size in [("key", (0.35, -1.2, target_z + 0.35), 16, 1.4), ("fill", (-0.7, -1.0, target_z), 7, 2.0),
                                    ("rim", (-0.45, 0.9, target_z + 0.5), 22, 0.8), ("rim2", (0.5, 0.8, target_z + 0.2), 10, 0.8)]:
        light = bpy.data.lights.new(name, "AREA"); light.energy = energy; light.size = size
        obj = bpy.data.objects.new(name, light); obj.location = loc
        scene.collection.objects.link(obj)
        obj.rotation_euler = (Vector((0, 0, target_z)) - obj.location).to_track_quat("-Z", "Y").to_euler()
    scene.world = bpy.data.worlds.new("studio")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.06, 0.06, 0.065, 1)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 128
    scene.cycles.use_denoising = True
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            for d in prefs.devices: d.use = True
            scene.cycles.device = "GPU"
            break
        except Exception:
            pass
    scene.view_settings.view_transform = "AgX"


def front_camera(eye, distance=0.95):
    scene = bpy.context.scene
    data = bpy.data.cameras.new("front"); data.lens = 85
    cam = bpy.data.objects.new("front", data)
    scene.collection.objects.link(cam)
    cam.location = (0, eye.y - distance, eye.z - 0.035)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = 768, 1024
    return cam


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


class Blob:
    """Typed arrays packed into one .bin with a JSON index (offsets are 4-byte aligned)."""

    def __init__(self):
        self.parts, self.index, self.size = [], {}, 0

    def add(self, name, array, kind):
        data = np.ascontiguousarray(array, dtype=kind).tobytes()
        pad = (-self.size) % 4
        if pad:
            self.parts.append(b"\0" * pad); self.size += pad
        self.index[name] = {"offset": self.size, "length": int(np.asarray(array).size), "type": np.dtype(kind).name}
        self.parts.append(data); self.size += len(data)

    def save(self, name, meta):
        with open(os.path.join(OUT, name + ".bin"), "wb") as f:
            f.write(b"".join(self.parts))
        with open(os.path.join(OUT, name + ".json"), "w") as f:
            json.dump({**meta, "arrays": self.index}, f, separators=(",", ":"))


def split_render_vertices(obj, uv_name):
    """Render vertices are unique (vertex, uv) pairs; returns their source vertex, uv and triangles."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    uv = mesh.uv_layers[uv_name].data
    keys, source, uvs, remap = {}, [], [], []
    for loop in mesh.loops:
        u = uv[loop.index].uv
        key = (loop.vertex_index, round(u.x, 5), round(u.y, 5))
        if key not in keys:
            keys[key] = len(source); source.append(loop.vertex_index); uvs.append((u.x, 1 - u.y))
        remap.append(keys[key])
    tris = [remap[i] for t in mesh.loop_triangles for i in t.loops]
    return np.array(source), np.array(uvs), np.array(tris)


def bind(points, targets, k=3):
    """Each accessory vertex follows its k nearest skin vertices (inverse-distance weights)."""
    from mathutils.kdtree import KDTree
    tree = KDTree(len(targets))
    for i, p in enumerate(targets):
        tree.insert(p, i)
    tree.balance()
    idx, wts = [], []
    for p in points:
        found = tree.find_n(p, k)
        w = np.array([1 / max(d, 1e-4) for _, _, d in found]); w /= w.sum()
        idx.append([i for _, i, _ in found]); wts.append(w)
    return np.array(idx), np.array(wts)


def to_game(co):
    """Blender (Z up, character faces -Y) to Three.js (Y up, faces +Z), centred on the head pivot."""
    pivot = JOINTS["joint-neck"]
    co = np.asarray(co) - np.array(pivot)
    return np.stack([co[:, 0], co[:, 2], -co[:, 1]], 1)


def world(obj):
    return np.array([obj.matrix_world @ v.co for v in obj.data.vertices])


def bake(hi, image_name, size):
    image = bpy.data.images.new(image_name, size, size, alpha=False, float_buffer=False)
    for mat in hi.data.materials:
        node = mat.node_tree.nodes.new("ShaderNodeTexImage"); node.image = image
        mat.node_tree.nodes.active = node
    hi.data.uv_layers.active = hi.data.uv_layers["bake"]
    for o in bpy.context.view_layer.objects: o.select_set(o is hi)
    bpy.context.view_layer.objects.active = hi
    scene = bpy.context.scene
    scene.cycles.samples = 256
    scene.render.bake.margin = 12
    scene.render.bake.use_pass_glossy = False
    scene.render.bake.use_pass_emit = False
    bpy.ops.object.bake(type="COMBINED")
    # Bake results are linear; the game samples the texture as sRGB.
    image.filepath_raw = os.path.join(OUT, image_name + ".png")
    image.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    image.save_render(os.path.join(OUT, image_name + ".png"), scene=scene)
    scene.view_settings.view_transform = "AgX"


def register_front(body, extras, cam):
    """Image-space position (0..1, top-left origin) and visibility of each vertex in the frontal render."""
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, depsgraph)
    origin = cam.matrix_world.translation
    def project(points):
        out = []
        for p in points:
            p = Vector(p)
            c = world_to_camera_view(scene, cam, p)
            direction = p - origin
            hit = bvh.ray_cast(origin, direction.normalized(), direction.length - 0.002)
            out.append((c.x, 1 - c.y, 0.0 if hit[0] is not None else 1.0))
        return np.array(out)
    return project(world(body)), {name: project(world(obj)) for name, obj in extras.items()}


def export_head(body, hi, extras, morphs, front):
    blob = Blob()
    pos = to_game(world(body))
    blob.add("position", pos, np.float32)
    source, uvs, tris = split_render_vertices(body, "bake")
    blob.add("renderSource", source, np.uint16)
    blob.add("renderUv", uvs, np.float32)
    blob.add("index", tris, np.uint16)
    for name, delta in morphs.items():
        blob.add("morph_" + name, np.stack([delta[:, 0], delta[:, 2], -delta[:, 1]], 1), np.float32)
    blob.add("front", front[0], np.float32)
    groups = {}
    for gname in ("lips", "ears", "scalp"):
        if gname in body.vertex_groups:
            gi = body.vertex_groups[gname].index
            groups[gname] = np.array([max([e.weight for e in v.groups if e.group == gi] or [0]) for v in body.data.vertices])
            blob.add("group_" + gname, groups[gname], np.float32)
    masks = hi.data.color_attributes["masks"]
    meta = {"vertices": len(pos), "renderVertices": len(source), "morphs": list(morphs), "accessories": {}}
    for name, obj in extras.items():
        apos = to_game(world(obj))
        asrc, auv, atri = split_render_vertices(obj, obj.data.uv_layers[0].name)
        idx, wts = bind(world(obj), world(body))
        blob.add(name + "_position", apos, np.float32)
        blob.add(name + "_renderSource", asrc, np.uint16)
        blob.add(name + "_renderUv", auv, np.float32)
        blob.add(name + "_index", atri, np.uint16)
        blob.add(name + "_bindIndex", idx, np.uint16)
        blob.add(name + "_bindWeight", wts, np.float32)
        blob.add(name + "_front", front[1][name], np.float32)
        meta["accessories"][name] = {"vertices": len(apos), "renderVertices": len(asrc)}
    eye = (JOINTS["joint-l-eye"] + JOINTS["joint-r-eye"]) / 2
    meta["eyes"] = to_game([JOINTS["joint-l-eye"], JOINTS["joint-r-eye"]]).round(5).tolist()
    meta["pivot"] = [0, 0, 0]
    blob.save("head", meta)


if __name__ == "__main__":
    body, morphs = build_character()
    for g in ("joint-head", "joint-neck", "joint-l-eye", "joint-r-eye", "joint-mouth", "joint-jaw", "joint-r-hand", "joint-r-elbow", "joint-r-finger-2-1", "joint-r-finger-3-1", "joint-r-finger-5-1"):
        JOINTS[g] = joint(body, g)
    pose_fingers(body)
    hand = extract_hand(body)
    morphs = cut_portrait(body, morphs)
    print("PHYS_VERTS", len(body.data.vertices))
    pack_bake_uv(body)
    hi = hires_copy(body)
    body.hide_render = True
    eye = paint_masks(hi)
    skin_material(hi)
    studio(eye.z)
    front_camera(eye)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "character.blend"))
    if PREVIEW:
        render(os.path.join(OUT, "preview.png"))
        sys.exit(0)
    extras = accessories(body)
    cam = bpy.context.scene.camera
    # The frontal render shares the bake's view transform, so its skin tone matches the texture.
    bpy.context.scene.view_settings.view_transform = "Standard"
    render(os.path.join(OUT, "front.png"))
    bpy.context.scene.view_settings.view_transform = "AgX"
    front = register_front(body, extras, cam)
    bake(hi, "head", BAKE_SIZE)
    export_head(body, hi, extras, morphs, front)
    pack_bake_uv(hand)
    hand.data.materials.clear(); hand.data.materials.append(hi.data.materials[0].copy())
    for node in list(hand.data.materials[0].node_tree.nodes):
        if node.type == "TEX_IMAGE" and node.image and node.image.name == "head":
            hand.data.materials[0].node_tree.nodes.remove(node)
    bake_albedo(hand, "hand", 512)
    export_hand(hand)
    print("HAND_VERTS", len(hand.data.vertices))
    for name, obj in extras.items():
        for mat in obj.data.materials:
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    print("ACCESSORY_TEXTURE", name, node.image.filepath)
    np.savez(os.path.join(OUT, "morphs.npz"), **morphs)
