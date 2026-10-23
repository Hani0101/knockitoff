# Exports the room to assets-src/room.glb (docs/blender-guide.md). Run inside
# Blender with room.blend open, after room_bake.py has written blender/bake/.
#
# Static meshes are exported with their atlas material (one per bake group)
# instead of the procedural bake-source materials; the swap is undone after
# exporting. Lights are not exported (the lighting lives in the atlases).
import bpy
import os

HERE = os.path.dirname(bpy.data.filepath)
OUT = os.path.join(HERE, "..", "assets-src", "room.glb")
EXPORT = ["room_static", "room_colliders", "props", "room_markers"]
PROP_TRI_LIMIT = 2000
ROOM_TRI_LIMIT = 200_000


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def check():
    problems, notes = [], []
    objs = [o for n in EXPORT for o in bpy.data.collections[n].all_objects]
    total = sum(tris(o) for o in objs if o.type == "MESH" and not o.name.endswith("-col") and "-col." not in o.name)
    notes.append(f"{total:,} triangles (limit {ROOM_TRI_LIMIT:,})")
    if total > ROOM_TRI_LIMIT:
        problems.append("over the room triangle budget")
    for o in objs:
        if any(abs(s - 1) > 1e-6 for s in o.scale):
            problems.append(f"{o.name}: scale not applied {tuple(round(s, 3) for s in o.scale)}")
        if o.get("knockable"):
            if o.get("baked"):
                problems.append(f"{o.name}: props must not be baked")
            t = tris(o)
            if t > PROP_TRI_LIMIT:
                problems.append(f"{o.name}: {t} triangles (prop limit ~{PROP_TRI_LIMIT})")
            if o.get("fragile") and not any(c.name.startswith("pieces") for c in o.children):
                problems.append(f"{o.name}: fragile but has no pieces")
            if o.get("grabbable"):
                dims = o.dimensions
                if max(dims) > 0.22 or o.get("mass", 0.5) > 0.6:
                    problems.append(f"{o.name}: grabbable but {max(dims):.2f} m / {o.get('mass')} kg")
    for o in bpy.data.collections["room_static"].objects:
        if o.get("baked") and not o.get("bake_exclude"):
            g = o.get("bake_group")
            if not bpy.data.materials.get(f"room_{g}"):
                problems.append(f"{o.name}: no baked atlas for group {g} (run room_bake.apply())")
    if "spawn" not in bpy.data.objects:
        problems.append("no spawn empty")
    return problems, notes


def export():
    problems, notes = check()
    if problems:
        raise RuntimeError("Not exporting:\n" + "\n".join(problems))
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    # Swap in single-material copies of the baked meshes.
    swapped = []
    for o in bpy.data.collections["room_static"].objects:
        if o.type != "MESH" or not o.get("baked") or o.get("bake_exclude"):
            continue
        atlas = bpy.data.materials[f"room_{o['bake_group']}"]
        orig = o.data
        me = orig.copy()
        for p in me.polygons:
            p.material_index = 0
        me.materials.clear()
        me.materials.append(atlas)
        o.data = me
        swapped.append((o, orig, me))

    # Export everything in the export collections, hidden pieces included.
    root = bpy.data.collections.get("room_export") or bpy.data.collections.new("room_export")
    if root.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(root)
    for n in EXPORT:
        c = bpy.data.collections[n]
        if c.name not in root.children:
            root.children.link(c)
    layer = bpy.context.view_layer.layer_collection.children[root.name]
    bpy.context.view_layer.active_layer_collection = layer

    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(
            filepath=os.path.abspath(OUT),
            export_format="GLB",
            use_active_collection=True,
            use_active_collection_with_nested=True,
            use_visible=False,
            use_renderable=False,
            export_yup=True,
            export_extras=True,
            export_apply=True,
            export_animations=False,
            export_lights=False,
            export_cameras=False,
            export_texcoords=True,
            export_normals=True,
            export_materials="EXPORT",
            export_image_format="AUTO",
        )
    finally:
        for o, orig, me in swapped:
            o.data = orig
            bpy.data.meshes.remove(me)
        for n in EXPORT:
            c = bpy.data.collections[n]
            if c.name in root.children:
                root.children.unlink(c)
        bpy.data.collections.remove(root)
    return os.path.abspath(OUT), notes


if __name__ == "__main__":
    # Also works headless: blender -b blender/room.blend --python blender/export_room.py
    bake_ns = {"__name__": "room_bake"}
    exec(open(os.path.join(HERE, "room_bake.py"), encoding="utf-8").read(), bake_ns)
    print(bake_ns["apply"]())
    print(export())
