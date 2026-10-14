"""Regenerate the original wooden-fish mesh: blender -b --python dev/create-model.py.
Only needed when editing the shape; the website build uses the checked-in JSON.
The round belly, slit and tail follow traditional instrument construction.
"""
import bpy
import math
import json
from pathlib import Path

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Each cross-section specifies top, bottom and half-width independently.
# A continuous sloping shoulder joins the domed head to a short, flat carved tail.
profile = [(-1.52, .02, .02, 0), (-1.48, .40, -.36, .42),
           (-1.32, .85, -.70, .83), (-1.08, 1.19, -.92, 1.09),
           (-.76, 1.42, -1.02, 1.25), (-.40, 1.48, -1.05, 1.32),
           (-.04, 1.38, -1.04, 1.30), (.30, 1.16, -.98, 1.20),
           (.59, .85, -.83, 1.03), (.84, .52, -.61, .79),
           (1.04, .27, -.39, .56), (1.22, .12, -.25, .43),
           (1.40, .09, -.19, .46), (1.57, .08, -.17, .60),
           (1.67, .05, -.15, .64), (1.73, -.05, -.05, 0)]
segments = 48
vertices = []
for x, top, bottom, width in profile:
    center = (top + bottom) / 2
    radius = (top - bottom) / 2
    for a in range(segments):
        angle = a * math.tau / segments
        # Subtle fork, rounded instead of pointed fins.
        fin = max(0, min(1, (x - 1.35) / .3)) if width else 0
        vertices.append((x + .08 * fin * math.sin(angle) ** 2,
                         max(-1.01, center + radius * math.cos(angle)),
                         width * math.sin(angle)))
faces = []
for row in range(len(profile) - 1):
    for a in range(segments):
        b = (a + 1) % segments
        faces.append((row*segments+a, row*segments+b, (row+1)*segments+b, (row+1)*segments+a))
mesh = bpy.data.meshes.new('Hollow carved wood')
mesh.from_pydata(vertices, [], faces)
mesh.update()
body = bpy.data.objects.new('Wooden fish', mesh)
wood = bpy.data.materials.new('Wood')
interior = bpy.data.materials.new('Unlit cavity')
body.data.materials.append(wood)
body.data.materials.append(interior)
bpy.context.collection.objects.link(body)
bpy.context.view_layer.objects.active = body
body.select_set(True)
# Weld the profile poles and ensure outward normals before solid operations.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=.001)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
sub = body.modifiers.new('Rounded carving', 'SUBSURF')
sub.levels = 1
bpy.ops.object.modifier_apply(modifier=sub.name)

def subtract(cutter):
    cutter.data.materials.clear()
    cutter.data.materials.append(wood)
    cutter.data.materials.append(interior)
    for polygon in cutter.data.polygons:
        polygon.material_index = 1
    bpy.context.view_layer.objects.active = body
    mod = body.modifiers.new('Carved opening', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

# Actual air cavity, a narrow slit and round sound holes; no painted black stripe.
bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, location=(-.32, .04, 0))
cavity = bpy.context.object
cavity.scale = (1.02, 1.03, 1.04)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
subtract(cavity)
bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.10, .02, 0))
slot = bpy.context.object
slot.dimensions = (2.90, .14, 4)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
subtract(slot)
bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=1, depth=4, location=(.38, -.08, 0))
port = bpy.context.object
port.scale = (.38, .32, 1)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
subtract(port)
bevel = body.modifiers.new('Soft wooden edges', 'BEVEL')
bevel.width = .045
bevel.segments = 3
bevel.material = 0
bpy.context.view_layer.objects.active = body
bpy.ops.object.modifier_apply(modifier=bevel.name)
for face in body.data.polygons:
    face.use_smooth = True
# Preserve planar cut faces and soften the rounded belly.
normal = body.modifiers.new('Carved surface normals', 'WEIGHTED_NORMAL')
normal.keep_sharp = True
body.data.use_auto_smooth = True
bpy.ops.object.modifier_apply(modifier=normal.name)
body.data.calc_loop_triangles()
body.data.calc_normals_split()
positions, normals, shades, indices, lookup = [], [], [], [], {}
material_indices = [[], []]
for tri in body.data.loop_triangles:
    if tri.area < 1e-10:
        continue
    # Bake simple cavity shading so openings remain readable without mobile SSAO.
    shade = .18 if body.data.polygons[tri.polygon_index].material_index == 1 else 1
    for loop_index in tri.loops:
        loop = body.data.loops[loop_index]
        point = body.data.vertices[loop.vertex_index].co
        n = loop.normal if loop.normal.length_squared > .5 else tri.normal
        n = n.normalized()
        key = tuple(round(v, 5) for v in (*point, *n, shade))
        if key not in lookup:
            lookup[key] = len(positions)//3
            positions.extend(key[:3])
            normals.extend(key[3:6])
            shades.append(shade)
        material_indices[1 if shade < 1 else 0].append(lookup[key])
indices = material_indices[0] + material_indices[1]
groups = [[0, len(material_indices[0]), 0], [len(material_indices[0]), len(material_indices[1]), 1]]
output = Path(__file__).resolve().parent.parent / 'assets/wooden-fish.json'
output.write_text(json.dumps({'positions': positions, 'normals': normals, 'shades': shades, 'indices': indices, 'groups': groups}, separators=(',', ':')))
print(f'Wooden fish: {len(indices)//3} triangles, {len(positions)//3} vertices, {output.stat().st_size} bytes')
