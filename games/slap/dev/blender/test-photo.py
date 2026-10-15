"""Renders a CC0 MakeHuman stranger as a phone-style portrait for testing the photo path.
Usage: blender -b --addons bl_ext.user_default.mpfb -P test-photo.py -- out.jpg [yaw_degrees]"""
import bpy, math, os, sys
from mathutils import Vector
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

args = sys.argv[sys.argv.index("--") + 1:]
out, yaw = args[0], float(args[1]) if len(args) > 1 else 12
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
info = HumanService._create_default_human_info_dict()
info["phenotype"].update({"gender": 0.0, "age": 0.45, "weight": 0.5, "race": {"asian": 0.0, "caucasian": 0.2, "african": 0.8}})
info["eyes"] = "eyes/low-poly/low-poly.mhclo"
info["eyebrows"] = "eyebrows/eyebrow002/eyebrow002.mhclo"
info["eyelashes"] = "eyelashes/eyelashes02/eyelashes02.mhclo"
info["hair"] = "hair/short01/short01.mhclo"
info["skin_mhmat"] = "skins/young_african_female/young_african_female.mhmat"
info["skin_material_type"] = "ENHANCED_SSS"
settings = HumanService.get_default_deserialization_settings(); settings["subdiv_levels"] = 1
body = HumanService.deserialize_from_dict(info, settings)
units = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(sys.modules[HumanService.__module__].__file__))), "data/targets/expression/units/african")
TargetService.load_target(body, os.path.join(units, "mouth-corner-puller.target.gz"), weight=0.7, name="smile")
for o in bpy.data.objects:
    if o is not body and o.type == "MESH": HumanService.refit(o); break
eye_z = 1.48 * max(v.co.z for v in body.data.vertices) / 1.62
scene = bpy.context.scene
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); cam.data.lens = 50
scene.collection.objects.link(cam)
r = 0.75
cam.location = (math.sin(math.radians(yaw)) * r, -math.cos(math.radians(yaw)) * r, eye_z + 0.03)
cam.rotation_euler = (Vector((0, -0.08, eye_z - 0.03)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
for name, loc, e in [("key", (0.8, -1.0, eye_z + 0.6), 70), ("fill", (-0.9, -0.8, eye_z), 18)]:
    l = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA")); l.data.energy = e; l.data.size = 1.0; l.location = loc
    scene.collection.objects.link(l)
    l.rotation_euler = (Vector((0, 0, eye_z)) - l.location).to_track_quat("-Z", "Y").to_euler()
scene.world = bpy.data.worlds.new("w"); scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.7, 1)
scene.render.engine = "CYCLES"; scene.cycles.samples = 96; scene.cycles.use_denoising = True
prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind; prefs.get_devices()
        for d in prefs.devices: d.use = True
        scene.cycles.device = "GPU"; break
    except Exception: pass
scene.render.resolution_x, scene.render.resolution_y = 900, 1200
scene.view_settings.view_transform = "AgX"
scene.render.image_settings.file_format = "JPEG"; scene.render.image_settings.quality = 85
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
