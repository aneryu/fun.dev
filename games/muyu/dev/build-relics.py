"""Step 2 of the relic pipeline: build assets/relics.glb, the twelve 结缘 relics in one GLB.
blender -b --disable-autoexec --python dev/build-relics.py -- ../../sources/blenderkit /tmp/wooden-fish.glb /tmp/relics.glb
npx @gltf-transform/cli@4.5.1 draco /tmp/relics.glb assets/relics.glb --encode-speed 0 --decode-speed 5
The second argument is the fish before Draco (dev/clean-model.py's output): Blender here has no
Draco library, so compression is a separate step. Three relics are CC0 BlenderKit models
(dev/fetch-blenderkit.py), each reduced to under 2,000 triangles; their colors are baked and
repainted per face in the shared palette, without textures. The rosewood mallet reuses the fish's mallet; the rest are modeled here. Each relic
is a root node named by its id, standing on z = 0 (y = 0 in glTF), about 0.3-0.6 units tall,
facing -Y (the camera, +z in three.js). Child empties mark effect points (tip, mouth, flame,
vent) and pivots that relics.js animates (nod, loop, chimes).
"""
import bpy, bmesh, math, os, sys
from collections import Counter
import numpy as np
from mathutils import Matrix, Vector

src_dir, fish_glb, dst = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
TEXTURE = 256  # baked color size, only read to repaint the faces

# One palette for every relic, taken from the wooden fish and its skins in game.js (wood,
# red lacquer, rosewood, bronze, gold) and its cushion (red cloth, straw), so the altar reads as
# one set of lacquered wooden toys. game.js gives the wood materials the fish's grain.
def material(name, color, metallic=0.0, roughness=0.6, emission=0.0, coat=0.0):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    rgb = [((color >> s) & 255) / 255 for s in (16, 8, 0)]
    mat["srgb"] = rgb  # for matching baked colors to the palette
    rgb = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]  # sRGB hex -> linear
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
    return mat

WOOD = material("wood", 0x9c5626, roughness=0.55, coat=0.2)  # the fish's wood
DARK_WOOD = material("dark-wood", 0x6b3a1c, roughness=0.55, coat=0.2)
ROSEWOOD = material("rosewood", 0x4a1f1a, roughness=0.45, coat=0.4)
LACQUER = material("lacquer", 0xb3261b, roughness=0.25, coat=1.0)
CLOTH = material("cloth", 0x8a1a14, roughness=0.9)  # the cushion's red
GOLD = material("gold", 0xc9a13b, metallic=0.6, roughness=0.3, coat=0.6)
BRONZE = material("bronze", 0x5f7a5a, metallic=0.75, roughness=0.4, coat=0.1)
DARK_BRONZE = material("dark-bronze", 0x4a3a22, metallic=0.6, roughness=0.45)
STRAW = material("straw", 0xc2a46a, roughness=0.9)
CREAM = material("cream", 0xf2e2b8, roughness=0.6)
SAFFRON = material("saffron", 0xd9822b, roughness=0.85)
SKIN = material("skin", 0xf0c8a0, roughness=0.7)
CHEEK = material("cheek", 0xf09a8a, roughness=0.7)
INK = material("ink", 0x211f17, roughness=0.6)
EMBER = material("ember", 0xff8a2a, emission=3.0)
FLAME = material("flame", 0xffb347, emission=4.0)
RED = CLOTH

def link(obj):
    scene.collection.objects.link(obj)
    return obj

def select(objects, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objects[0]

def parent(child, to):
    child.parent = to
    child.matrix_parent_inverse = to.matrix_world.inverted()
    return child

def empty(name, location=(0, 0, 0), to=None):
    obj = link(bpy.data.objects.new(name, None))
    obj.location = location
    bpy.context.view_layer.update()
    return parent(obj, to) if to else obj

def finish(obj, mat, smooth=True, bevel=0.0):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width, mod.segments, mod.limit_method = bevel, 2, "ANGLE"
        select([obj])
        bpy.ops.object.modifier_apply(modifier=mod.name)
    select([obj])
    if smooth:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    else:
        bpy.ops.object.shade_flat()
    return obj

# Primitives: each returns a new mesh object with its transform applied.
def make(op, mat, location=(0, 0, 0), rotation=(0, 0, 0), scale=(1, 1, 1), smooth=True, bevel=0.0, **kw):
    op(location=location, rotation=rotation, **kw)
    obj = bpy.context.active_object
    obj.scale = scale
    select([obj])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return finish(obj, mat, smooth, bevel)

def cylinder(mat, r, depth, location, rotation=(0, 0, 0), vertices=24, **kw):
    return make(bpy.ops.mesh.primitive_cylinder_add, mat, location, rotation, radius=r, depth=depth, vertices=vertices, **kw)

def sphere(mat, r, location, scale=(1, 1, 1), segments=16, rings=10, **kw):
    return make(bpy.ops.mesh.primitive_uv_sphere_add, mat, location, (0, 0, 0), scale, radius=r, segments=segments, ring_count=rings, **kw)

def box(mat, size, location, rotation=(0, 0, 0), **kw):
    return make(bpy.ops.mesh.primitive_cube_add, mat, location, rotation, scale=[s / 2 for s in size], size=2, **kw)

def rod(mat, r, a, b, vertices=8, **kw):
    """A cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    rotation = Vector((0, 0, 1)).rotation_difference(b - a).to_euler()
    return cylinder(mat, r, (b - a).length, (a + b) / 2, rotation, vertices=vertices, **kw)

def torus(mat, major, minor, location, rotation=(0, 0, 0), major_segments=32, minor_segments=8, **kw):
    return make(bpy.ops.mesh.primitive_torus_add, mat, location, rotation, major_radius=major, minor_radius=minor,
                major_segments=major_segments, minor_segments=minor_segments, **kw)

def cone(mat, r1, r2, depth, location, rotation=(0, 0, 0), vertices=16, **kw):
    return make(bpy.ops.mesh.primitive_cone_add, mat, location, rotation, radius1=r1, radius2=r2, depth=depth, vertices=vertices, **kw)

def lathe(mat, profile, location=(0, 0, 0), steps=32):
    """Spins a (radius, z) profile around Z."""
    mesh = bpy.data.meshes.new("lathe")
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    edges = [bm.edges.new((a, b)) for a, b in zip(verts, verts[1:])]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi, steps=steps, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    obj = link(bpy.data.objects.new("lathe", mesh))
    obj.location = location
    select([obj])
    bpy.ops.object.transform_apply(location=True)
    return finish(obj, mat)

def join(objects, name):
    select(objects)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    return obj

def tris(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)

# ---------------------------------------------------------------- BlenderKit models
def import_model(name):
    """Appends a downloaded .blend and returns one mesh with modifiers and transforms applied."""
    with bpy.data.libraries.load(os.path.join(src_dir, name + ".blend"), link=False) as (src, data):
        data.objects = list(src.objects)
    objects = [o for o in data.objects if o is not None]
    for o in objects:
        scene.collection.objects.link(o)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    parts = []
    for o in objects:
        if o.type != "MESH" or o.hide_render:
            continue
        mesh = bpy.data.meshes.new_from_object(o.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)
        mesh.transform(o.matrix_world)
        parts.append(link(bpy.data.objects.new(name, mesh)))
    for o in objects:
        bpy.data.objects.remove(o)
    return join(parts, name + "-source")

def fit(obj, height=None, width=None, turn=0.0):
    """Turns about Z, scales to a height or width, centers on X/Y and stands on z = 0."""
    obj.data.transform(Matrix.Rotation(turn, 4, "Z"))
    co = [v.co for v in obj.data.vertices]
    low = Vector([min(c[i] for c in co) for i in range(3)])
    high = Vector([max(c[i] for c in co) for i in range(3)])
    size = high - low
    s = height / size.z if height else width / max(size.x, size.y)
    obj.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(-Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))))
    obj.data.update()
    return obj

def bake(source, name, faces, palette, gain=1.0):
    """A low-poly copy of `source`, repainted in `palette` from its baked base color (times `gain`)."""
    low = link(bpy.data.objects.new(name, source.data.copy()))
    ratio = min(1.0, faces / tris(source))
    if ratio < 1:
        mod = low.modifiers.new("Decimate", "DECIMATE")
        mod.ratio = ratio
        select([low])
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for layer in list(low.data.uv_layers):
        low.data.uv_layers.remove(layer)
    low.data.uv_layers.new(name="UVMap")
    low.data.materials.clear()
    select([low])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    image = bpy.data.images.new(name, TEXTURE, TEXTURE)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    nodes.active = tex
    low.data.materials.append(mat)
    # Bake color only: metals would bake black through the diffuse pass, so zero them first.
    for slot in source.material_slots:
        if not slot.material or not slot.material.use_nodes:
            continue
        for node in slot.material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                for link_ in list(node.inputs["Metallic"].links):
                    slot.material.node_tree.links.remove(link_)
                node.inputs["Metallic"].default_value = 0
    select([source, low], active=low)
    extent = max(low.dimensions)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=0.02 * extent, max_ray_distance=0.08 * extent, margin=4)
    bpy.data.objects.remove(source)
    # Each face takes the palette color nearest its baked color (sampled at its corners and,
    # twice, its center); then a face unlike most of its neighbors joins them, so photo
    # textures become clean flat patches like the modeled relics.
    pixels = np.array(image.pixels[:]).reshape(TEXTURE, TEXTURE, 4)[..., :3]  # sRGB bytes as 0-1
    colors = np.array([m["srgb"] for m in palette])
    uv = low.data.uv_layers.active.data
    texel = lambda p: pixels[min(TEXTURE - 1, int(p.y * TEXTURE)), min(TEXTURE - 1, int(p.x * TEXTURE))]
    choice = []
    for poly in low.data.polygons:
        corners = [uv[i].uv.copy() for i in poly.loop_indices]
        center = sum(corners, Vector((0, 0))) / len(corners)
        color = np.mean([texel(p) for p in corners + [center, center]], axis=0) * gain
        choice.append(int(np.argmin((((colors - color) ** 2) * (1.0, 1.5, 1.0)).sum(axis=1))))
    neighbors = [set() for _ in low.data.polygons]
    by_edge = {}
    for poly in low.data.polygons:
        for key in poly.edge_keys:
            by_edge.setdefault(key, []).append(poly.index)
    for shared in by_edge.values():
        for a in shared:
            neighbors[a].update(b for b in shared if b != a)
    for _ in range(3):
        smoothed = choice[:]
        for i, around in enumerate(neighbors):
            votes = Counter(choice[j] for j in around)
            votes[choice[i]] += 1
            best, count = votes.most_common(1)[0]
            if count > votes[choice[i]]:
                smoothed[i] = best
        choice = smoothed
    used = sorted(set(choice))
    low.data.materials.clear()
    for k in used:
        low.data.materials.append(palette[k])
    for poly, k in zip(low.data.polygons, choice):
        poly.material_index = used.index(k)
    low.data.uv_layers.remove(low.data.uv_layers.active)
    bpy.data.materials.remove(mat)
    bpy.data.images.remove(image)
    select([low])
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
    print(f"baked {name}: {tris(low)} triangles,", {palette[k].name: choice.count(k) for k in used})
    return low

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 4
scene.render.bake.use_pass_direct = False
scene.render.bake.use_pass_indirect = False

def relic(id, *parts, hooks=()):
    root = empty(id)
    for part in parts:
        parent(part, root)
    for hook, location in hooks:
        empty(hook, location, root)
    return root

def reduce(obj, faces):
    """Collapses a smooth mesh to about `faces` triangles."""
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = min(1.0, faces / tris(obj))
    select([obj])
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj

# Budget: about 15,000 triangles for all twelve. The fish has 23,000, and everything is drawn
# twice (camera and shadow), so this keeps a full altar under ~80,000 triangles a frame.

# Censer (香炉): a cloisonné tripod censer; smoke rings rise from the vent above the lid.
censer = bake(fit(import_model("censer"), height=0.4), "censer-body", 1800, [BRONZE, GOLD, LACQUER, DARK_BRONZE])
relic("censer", censer, hooks=[("vent", (0, 0, 0.42))])

# Lotus lamp (莲花灯): a gilded lotus on a stem; a flame burns in the cup on top.
lotus = bake(fit(import_model("lotus"), height=0.38), "lotus-body", 1500, [GOLD, DARK_BRONZE], gain=1.8)  # antique gilding: brighten
top = max(v.co.z for v in lotus.data.vertices)
flame = sphere(FLAME, 0.022, (0, 0, top + 0.02), scale=(1, 1, 1.9), segments=10, rings=6)
flame.name = "lotus-flame"
relic("lotus", lotus, flame, hooks=[("flame", (0, 0, top + 0.04))])

# Incense (线香): three sticks in a brass burner; smoke starts at the middle tip.
burner = bake(fit(import_model("incense"), width=0.3), "incense-burner", 800, [GOLD, DARK_BRONZE])
top = max(v.co.z for v in burner.data.vertices)
sticks = []
base = Vector((0, 0, top - 0.03))
for lean in (-0.16, 0, 0.16):
    up = Matrix.Rotation(lean, 3, "Y") @ Vector((0, 0, 1))
    sticks.append(rod(LACQUER, 0.0055, base, base + up * 0.1, vertices=5))
    sticks.append(rod(DARK_WOOD, 0.0055, base + up * 0.1, base + up * 0.4, vertices=5))
    sticks.append(sphere(EMBER, 0.008, base + up * 0.4, segments=6, rings=4))
tip = base + Vector((0, 0, 0.405))
relic("incense", burner, join(sticks, "incense-sticks"), hooks=[("tip", tuple(tip))])

# ---------------------------------------------------------------- modeled relics
# Chanting box (录音机): a red 念佛机 with a gold speaker, an amber display, three buttons
# and a carrying handle.
case = box(LACQUER, (0.3, 0.13, 0.21), (0, 0, 0.105), bevel=0.03)
speaker = cylinder(GOLD, 0.062, 0.008, (-0.065, -0.064, 0.105), (math.pi / 2, 0, 0), vertices=24)
grille = [torus(DARK_BRONZE, r, 0.0035, (-0.065, -0.069, 0.105), (math.pi / 2, 0, 0), major_segments=20, minor_segments=4)
          for r in (0.045, 0.026)]
display = box(INK, (0.1, 0.006, 0.045), (0.07, -0.066, 0.145))
led = box(FLAME, (0.08, 0.004, 0.016), (0.07, -0.0695, 0.145), smooth=False)
buttons = [cylinder(GOLD, 0.011, 0.01, (x, -0.066, 0.075), (math.pi / 2, 0, 0), vertices=10) for x in (0.04, 0.07, 0.1)]
handle = torus(ROSEWOOD, 0.085, 0.011, (0, 0, 0.2), (math.pi / 2, 0, 0), major_segments=24, minor_segments=6)
bm = bmesh.new(); bm.from_mesh(handle.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.205], context="VERTS")
bm.to_mesh(handle.data); bm.free()
relic("recorder", join([case, speaker, display, led, handle, *grille, *buttons], "recorder-body"))

# Bronze bowl (铜磬): a hammered-bronze singing bowl in a red ring cushion, with a wooden striker.
bowl = lathe(GOLD,
             [(0, 0), (0.07, 0), (0.12, 0.02), (0.148, 0.055), (0.157, 0.1), (0.155, 0.125), (0.147, 0.125),
              (0.148, 0.1), (0.14, 0.06), (0.11, 0.028), (0.06, 0.014), (0, 0.012)], steps=40)
bowl.data.transform(Matrix.Translation((0, 0, 0.05)))
line = torus(DARK_BRONZE, 0.1565, 0.0025, (0, 0, 0.145), major_segments=40, minor_segments=4)
cushion = torus(RED, 0.12, 0.045, (0, 0, 0.04), scale=(1, 1, 0.75), major_segments=32, minor_segments=10)
# The striker leans in the bowl, its leather grip outside the rim.
a, b = Vector((0.02, 0.02, 0.07)), Vector((0.22, -0.1, 0.2))
striker = rod(WOOD, 0.011, a, b)
grip = rod(ROSEWOOD, 0.016, b - (b - a).normalized() * 0.07, b)
relic("bowl", join([bowl, line], "bowl-body"), join([cushion, striker, grip], "bowl-cushion"))

# Wind chime (风铃): five metal tubes, a clapper and a red sail under a wooden disc, hung from a
# little stand; `chimes` swings about its hook. Centered so its footprint is centered too.
pivot = Vector((0.1, 0, 0.62))
CORD = STRAW
METAL = GOLD
x0 = pivot.x
hanging = [
    rod(CORD, 0.002, pivot, (x0, 0, 0.58), vertices=4),
    cylinder(WOOD, 0.045, 0.012, (x0, 0, 0.574), vertices=16),
    rod(CORD, 0.0015, (x0, 0, 0.568), (x0, 0, 0.37), vertices=4),
    cylinder(WOOD, 0.02, 0.008, (x0, 0, 0.47), vertices=12),
    box(LACQUER, (0.045, 0.004, 0.07), (x0, 0, 0.34), bevel=0.002),
]
for k in range(5):
    a = k * 2 * math.pi / 5 + 0.3
    x, y = x0 + math.cos(a) * 0.03, math.sin(a) * 0.03
    length = 0.2 - 0.018 * k
    hanging.append(rod(CORD, 0.0015, (x, y, 0.568), (x, y, 0.553), vertices=4))
    hanging.append(rod(METAL, 0.0065, (x, y, 0.555), (x, y, 0.555 - length), vertices=8))
stand = join([
    cylinder(DARK_WOOD, 0.075, 0.03, (-0.09, 0, 0.015), vertices=20, bevel=0.008),
    cylinder(DARK_WOOD, 0.012, 0.64, (-0.09, 0, 0.32), vertices=8),
    cylinder(DARK_WOOD, 0.01, 0.22, (0.01, 0, 0.64), (0, math.pi / 2, 0), vertices=8),
    torus(GOLD, 0.012, 0.003, (pivot.x, 0, pivot.z + 0.008), (math.pi / 2, 0, 0), major_segments=12, minor_segments=4),
], "chime-stand")
chimes = empty("chimes", tuple(pivot))
parent(join(hanging, "chime-body"), chimes)
root = relic("chime", stand)
parent(chimes, root)

# Rosewood mallet (紫檀槌): the fish's own mallet in dark rosewood, lying on the floor.
bpy.ops.import_scene.gltf(filepath=fish_glb)
mallet = join([bpy.data.objects["MalletHead"], bpy.data.objects["MalletHandle"]], "rosewood-mallet")
for o in list(scene.objects):
    if o.type == "MESH" and o.name in ("Fish", "Cushion"):
        bpy.data.objects.remove(o)
select([mallet])
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mallet.parent = None
co = [v.co for v in mallet.data.vertices]
axis = max(range(3), key=lambda i: max(c[i] for c in co) - min(c[i] for c in co))
mid = Vector([(max(c[i] for c in co) + min(c[i] for c in co)) / 2 for i in range(3)])
to_x = Vector((1, 0, 0)).rotation_difference(Vector([1.0 if i == axis else 0.0 for i in range(3)])).to_matrix().to_4x4().inverted()
mallet.data.transform(to_x @ Matrix.Translation(-mid))
if sum(v.co.x for v in mallet.data.vertices) > 0:  # the head has most vertices: put it at -x
    mallet.data.transform(Matrix.Rotation(math.pi, 4, "Z"))
fit(mallet, width=0.5)
# Tilt so the handle's end rests on the floor too.
co = [v.co for v in mallet.data.vertices]
far = [c for c in co if c.x > 0.2]
drop = min(c.z for c in far)
mallet.data.transform(Matrix.Rotation(math.atan2(drop, 0.45), 4, "Y"))
fit(mallet, width=0.5)
finish(reduce(mallet, 500), ROSEWOOD)
relic("rosewood", mallet)

# Mallet wrap (槌布): a rolled red cloth tied with gold cord, a tassel at the front.
cloth = cylinder(RED, 0.1, 0.36, (0, 0, 0.1), (0, math.pi / 2, 0), vertices=20, bevel=0.03)
flap = box(RED, (0.34, 0.006, 0.12), (0, -0.098, 0.07), (math.radians(-12), 0, 0))
cords = [torus(GOLD, 0.102, 0.008, (x, 0, 0.1), (0, math.pi / 2, 0), major_segments=20, minor_segments=5) for x in (-0.1, 0.1)]
knot = sphere(GOLD, 0.016, (0.1, -0.1, 0.1), segments=8, rings=5)
tassel = cone(RED, 0.022, 0.006, 0.08, (0.1, -0.108, 0.05), vertices=8)
relic("wrap", join([cloth, flap, knot, tassel, *cords], "wrap-cloth"))

# Fortune sticks (签筒): a bamboo cup of sticks, a few with red tips; one pops out of the mouth.
cup = lathe(STRAW, [(0.0, 0.0), (0.095, 0.0), (0.1, 0.01), (0.1, 0.29), (0.088, 0.29), (0.088, 0.02), (0.0, 0.02)], steps=20)
nodes_ = [torus(STRAW, 0.101, 0.006, (0, 0, z), major_segments=20, minor_segments=4) for z in (0.06, 0.23)]
band = cylinder(LACQUER, 0.102, 0.05, (0, 0, 0.145), vertices=20)
glyph = box(GOLD, (0.05, 0.004, 0.03), (0, -0.104, 0.145))
sticks = []
for k in range(15):
    a = k * 2.4
    r = 0.025 + 0.05 * ((k * 7) % 5) / 4
    x, y = math.cos(a) * r, math.sin(a) * r
    h = 0.42 + 0.05 * ((k * 3) % 4) / 3
    base = Vector((x, y, 0.02))
    up = Vector((x * 1.6, y * 1.6, 1)).normalized()
    sticks.append(rod(CREAM, 0.008, base, base + up * h, vertices=4, smooth=False))
    if k % 4 == 0:
        sticks.append(rod(LACQUER, 0.0085, base + up * (h - 0.05), base + up * h, vertices=4, smooth=False))
relic("sticks", join([cup, band, glyph, *nodes_], "sticks-cup"), join(sticks, "sticks-sticks"), hooks=[("mouth", (0, 0, 0.55))])

# Little monk (小沙弥): sits on a straw cushion with hands together; `nod` bends him at the waist.
seat = cylinder(STRAW, 0.17, 0.07, (0, 0, 0.035), vertices=24, bevel=0.03)
seat_ring = torus(DARK_WOOD, 0.15, 0.008, (0, 0, 0.07), major_segments=28, minor_segments=4)
legs = sphere(SAFFRON, 0.15, (0, -0.02, 0.1), scale=(1, 0.8, 0.32), segments=16, rings=8)
nod = empty("nod", (0, 0, 0.1))
body = sphere(SAFFRON, 0.11, (0, 0, 0.2), scale=(1, 0.85, 1.05), segments=16, rings=10)
sash = torus(CLOTH, 0.108, 0.012, (0, 0, 0.22), (0, math.radians(32), 0), scale=(1, 0.86, 1), major_segments=24, minor_segments=5)
head = sphere(SKIN, 0.105, (0, 0, 0.39), segments=20, rings=12)
ears = [sphere(SKIN, 0.028, (x, 0.0, 0.385), scale=(0.6, 1, 1), segments=8, rings=5) for x in (-0.103, 0.103)]
hands = sphere(SKIN, 0.03, (0, -0.1, 0.25), scale=(0.75, 0.6, 1.5), segments=8, rings=6)
face = []
for x in (-0.038, 0.038):  # closed eyes: two short arcs
    arc = torus(INK, 0.016, 0.004, (x, -0.094, 0.4), (math.pi / 2 - 0.25, 0, 0), major_segments=12, minor_segments=4)
    bm = bmesh.new(); bm.from_mesh(arc.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > 0.4 - 0.004], context="VERTS")
    bm.to_mesh(arc.data); bm.free()
    face.append(arc)
face += [sphere(CHEEK, 0.016, (x, -0.088, 0.37), scale=(1, 0.4, 0.7), segments=8, rings=5) for x in (-0.06, 0.06)]
face.append(sphere(INK, 0.008, (0, -0.103, 0.355), scale=(1.2, 0.5, 0.5), segments=6, rings=4))
dots = [sphere(DARK_WOOD, 0.0065, (x, -0.035 + y, 0.39 + math.sqrt(max(0, 0.105 ** 2 - x * x - (-0.035 + y) ** 2)) - 0.002), segments=6, rings=4)
        for x in (-0.03, 0, 0.03) for y in (0, 0.035)]
upper = join([body, sash, head, hands, *ears, *face, *dots], "novice-upper")
parent(upper, nod)
root = relic("novice", join([seat, seat_ring, legs], "novice-seat"))
parent(nod, root)

# Prayer beads (念珠): a ring of wooden beads with a red guru bead, standing in a wooden cradle;
# `loop` turns one bead per strike.
cradle = join([
    box(WOOD, (0.3, 0.12, 0.03), (0, 0, 0.015), bevel=0.008),
    box(WOOD, (0.03, 0.05, 0.08), (-0.07, 0, 0.06), bevel=0.006),
    box(WOOD, (0.03, 0.05, 0.08), (0.07, 0, 0.06), bevel=0.006),
], "beads-cradle")
loop = empty("loop", (0, 0, 0.23))
beads = []
count = 27  # a quarter mala; relics.js turns the loop 1/108 of a round per strike
for k in range(count):
    a = k * 2 * math.pi / count - math.pi / 2
    x, z = math.cos(a) * 0.16, 0.23 + math.sin(a) * 0.16
    beads.append(sphere(LACQUER if k == 0 else ROSEWOOD, 0.024 if k else 0.03, (x, 0, z), segments=8, rings=5))
loop_mesh = join(beads, "beads-loop")
parent(loop_mesh, loop)
root = relic("beads", cradle)
parent(loop, root)

# Temple bell (古钟): a small bronze bell with raised bands and bosses, hung in a wooden frame.
bell = lathe(BRONZE, [(0.0, 0.43), (0.05, 0.428), (0.075, 0.415), (0.085, 0.38), (0.09, 0.3), (0.098, 0.22), (0.112, 0.17), (0.118, 0.155), (0.11, 0.152), (0.1, 0.16)], steps=28)
bands = [torus(BRONZE, r, 0.005, (0, 0, z), major_segments=28, minor_segments=4) for r, z in ((0.0905, 0.3), (0.098, 0.225), (0.116, 0.162))]
bosses = []
for row, z in enumerate((0.34, 0.37)):
    for k in range(8):
        a = (k + row * 0.5) * math.pi / 4
        r = 0.087 - row * 0.004
        bosses.append(sphere(BRONZE, 0.008, (math.cos(a) * r, math.sin(a) * r, z), segments=6, rings=4))
lug = torus(BRONZE, 0.022, 0.007, (0, 0, 0.45), (math.pi / 2, 0, 0), major_segments=12, minor_segments=4)
frame = join([
    box(DARK_WOOD, (0.4, 0.1, 0.025), (0, 0, 0.0125), bevel=0.006),
    box(DARK_WOOD, (0.025, 0.025, 0.5), (-0.17, 0, 0.26)),
    box(DARK_WOOD, (0.025, 0.025, 0.5), (0.17, 0, 0.26)),
    box(LACQUER, (0.42, 0.03, 0.03), (0, 0, 0.5), bevel=0.006),
    cylinder(GOLD, 0.004, 0.03, (0, 0, 0.48), vertices=6),
], "bell-frame")
relic("bell", join([bell, lug, *bands, *bosses], "bell-body"), frame)

# ---------------------------------------------------------------- export
for o in scene.objects:
    if o.type == "MESH":
        print(f"{o.name:20} {tris(o):6} triangles")
print("total", sum(tris(o) for o in scene.objects if o.type == "MESH"))
bpy.ops.export_scene.gltf(
    filepath=dst, export_format="GLB", export_yup=True, export_apply=True,
    export_image_format="WEBP", export_image_quality=80,
    export_vertex_color="NONE", export_cameras=False, export_lights=False,
)
# Blender 5.2 can crash while tearing down after the appended libraries; the file is written.
sys.stdout.flush()
os._exit(0)
