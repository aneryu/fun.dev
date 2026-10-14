"""Step 2: name the parts, replace the cushion with a torus, smooth the fish, bake AO into the fish, apply transforms, export assets/wooden-fish.glb.
blender -b --python dev/clean-model.py -- /tmp/plain.glb assets/wooden-fish.glb
Parts of the Tripo model: 0 fish, 5 mallet head, 7 mallet handle, the rest the (replaced) cushion.
"""
import bpy, bmesh, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree
src, dst = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
names = {"tripo_part_0": "Fish", "tripo_part_5": "MalletHead", "tripo_part_7": "MalletHandle"}
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
for o in meshes:
    o.name = names.get(o.parent.name, "Cushion")
cushion = [o for o in meshes if o.name.startswith("Cushion")]
bpy.ops.object.select_all(action="DESELECT")
for o in cushion: o.select_set(True)
bpy.context.view_layer.objects.active = cushion[0]
bpy.ops.object.join()
bpy.context.view_layer.objects.active.name = "Cushion"
for o in list(bpy.context.scene.objects):
    if o.type != "MESH": bpy.data.objects.remove(o)
# The generated cushion is five lumpy pieces; replace it with a clean, slightly flattened torus
# that fills the same bounding box (Blender is Z-up here).
old = bpy.data.objects["Cushion"]
corners = [old.matrix_world @ Vector(c) for c in old.bound_box]
low = Vector([min(c[i] for c in corners) for i in range(3)])
high = Vector([max(c[i] for c in corners) for i in range(3)])
bpy.data.objects.remove(old)
outer = ((high.x - low.x) + (high.y - low.y)) / 4
tube = 0.11
bpy.ops.mesh.primitive_torus_add(major_segments=96, minor_segments=32, major_radius=outer - tube, minor_radius=tube,
                                 location=((low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2))
cushion = bpy.context.active_object
cushion.name = cushion.data.name = "Cushion"
cushion.scale.z = (high.z - low.z) / (2 * tube)
bpy.ops.object.shade_smooth()
# Generated meshes are lumpy: smooth the fish lightly so the carving survives.
for name, factor, repeat in (("Fish", 0.5, 4),):
    obj = bpy.data.objects[name]
    smooth = obj.modifiers.new("Smooth", "SMOOTH")
    smooth.factor, smooth.iterations = factor, repeat
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    # Recompute normals from the smoothed surface instead of the imported ones.
    with bpy.context.temp_override(object=obj, active_object=obj, selected_editable_objects=[obj]):
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
        bpy.ops.object.shade_smooth()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Bake ambient occlusion into the fish's vertex colors (see below).
# The cushion stays in the scene and shades the fish's underside.
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 128
scene.world = scene.world or bpy.data.worlds.new("World")
fish = bpy.data.objects["Fish"]
fish.data.materials.append(bpy.data.materials.new("Bake"))
ao = fish.data.color_attributes.new("AO", "BYTE_COLOR", "POINT")
fish.data.color_attributes.active_color = ao
fish.data.color_attributes.render_color_index = fish.data.color_attributes.active_color_index
bpy.ops.object.select_all(action="DESELECT")
fish.select_set(True)
bpy.context.view_layer.objects.active = fish
# Red: baked AO for the carving's shallow grooves. Green: how far each vertex sits below the
# fish's convex hull. The slit is a wide, shallow cut that AO cannot darken, but it is the most
# recessed part, so depth lets the game shade it like the hollow inside of a real wooden fish.
scene.world.light_settings.distance = 0.08
bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
hull = bmesh.new()
for v in fish.data.vertices: hull.verts.new(v.co)
bmesh.ops.convex_hull(hull, input=hull.verts[:])
tree = BVHTree.FromBMesh(hull)
for i, c in enumerate(ao.data):
    depth = tree.find_nearest(fish.data.vertices[i].co)[3]
    c.color = (c.color[0], max(0.0, 1.0 - depth / 0.15), 1.0, 1.0)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_draco_mesh_compression_enable=False, export_materials="NONE", export_texcoords=False, export_vertex_color="ACTIVE", export_yup=True)
