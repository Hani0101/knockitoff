# Bakes the room's lighting into texture atlases (docs/blender-guide.md,
# "Baked lighting").
#
# 1. prepare()  - run inside Blender with room.blend open, then save.
#    Unwraps every static mesh into its group's atlas (non-overlapping UVs),
#    gives each group its own copies of the materials with a bake target
#    image, and marks the meshes `baked`.
# 2. bake       - run in the background so Blender stays responsive:
#      blender -b blender/room.blend --python blender/room_bake.py -- --samples 256
#    Bakes Cycles "Combined" (diffuse light and emission, no glossy) with
#    props, colliders and window views hidden, denoises, and writes
#    blender/bake/<group>.png.
# 3. apply()    - run inside Blender. Builds one plain Principled material per
#    atlas from those PNGs; export_room.py uses them.
import bpy
import math
import os
import sys
import time

HERE = os.path.dirname(bpy.data.filepath)
BAKE_DIR = os.path.join(HERE, "bake")
GROUPS = {"floor": 2048, "walls": 2048, "living": 2048, "kitchen": 2048}
MARGIN_PX = 12


def static_objects(group=None):
    objs = [o for o in bpy.data.collections["room_static"].objects
            if o.type == "MESH" and not o.get("bake_exclude") and "bake_group" in o]
    return [o for o in objs if group is None or o["bake_group"] == group]


def _view3d_override():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next(r for r in area.regions if r.type == "WINDOW")
                return dict(window=win, area=area, region=region)
    return {}


def unwrap(group):
    objs = static_objects(group)
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        me = o.data
        while len(me.uv_layers):
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name="UVMap")
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    margin = MARGIN_PX / GROUPS[group]
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
        bpy.ops.object.mode_set(mode="OBJECT")
    return len(objs)


def bake_image(group, float_buffer=True):
    name = f"bake_{group}"
    img = bpy.data.images.get(name)
    size = GROUPS[group]
    if img is None or tuple(img.size) != (size, size):
        if img:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=float_buffer)
    return img


def group_materials(group):
    """Gives the group's objects their own material copies (a material used by
    two atlases can only point at one bake image), each with an active
    Image Texture node holding the group's bake target."""
    img = bake_image(group)
    for o in static_objects(group):
        for slot in o.material_slots:
            m = slot.material
            if m is None:
                continue
            base = m.get("bake_source", m.name)
            name = f"{base}@{group}"
            copy = bpy.data.materials.get(name)
            if copy is not None and copy.users == 0:
                # Left over from before a rebuild: refresh it from the source.
                bpy.data.materials.remove(copy)
                copy = None
            if copy is None:
                copy = bpy.data.materials[base].copy()
                copy.name = name
                copy["bake_source"] = base
            slot.material = copy
            nt = copy.node_tree
            node = nt.nodes.get("bake_target") or nt.nodes.new("ShaderNodeTexImage")
            node.name = "bake_target"
            node.image = img
            node.location = (-600, 400)
            nt.nodes.active = node
        o["baked"] = True


def prepare():
    for g in GROUPS:
        group_materials(g)
        unwrap(g)
    return {g: len(static_objects(g)) for g in GROUPS}


# ---------------------------------------------------------------------------
# Baking (background)


def _hide_for_bake():
    """Props, colliders, pieces and window views stay out of the bake. Returns
    a list to restore afterwards."""
    changed = []
    for o in bpy.data.objects:
        hide = (o.users_collection and o.users_collection[0].name in ("props", "room_colliders")) \
            or o.get("knockable") or o.get("bake_exclude") or o.name.startswith(("pieces_", "_"))
        if o.parent and o.parent.get("knockable"):
            hide = True
        if hide and not o.hide_render:
            o.hide_render = True
            changed.append(o)
    return changed


def bake(groups, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 0
    sc.cycles.transmission_bounces = 0
    sc.cycles.sample_clamp_indirect = 8.0
    b = sc.render.bake
    b.use_pass_direct = True
    b.use_pass_indirect = True
    b.use_pass_diffuse = True
    b.use_pass_emit = True
    b.use_pass_glossy = False
    b.use_pass_transmission = False
    b.margin = MARGIN_PX
    b.margin_type = "EXTEND"
    b.target = "IMAGE_TEXTURES"
    restore = _hide_for_bake()
    times = {}
    try:
        for g in groups:
            t = time.time()
            objs = static_objects(g)
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.hide_set(False)
                o.hide_render = False
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            img = bake_image(g)
            # Bake writes into the active, selected image node of each material.
            for o in objs:
                for slot in o.material_slots:
                    nt = slot.material.node_tree
                    for n in nt.nodes:
                        n.select = False
                    node = nt.nodes["bake_target"]
                    node.image = img
                    node.select = True
                    nt.nodes.active = node
            bpy.ops.object.bake(type="COMBINED", use_clear=True, margin=MARGIN_PX, margin_type="EXTEND")
            times[g] = round(time.time() - t, 1)
            # Keep the raw bake: if denoising fails, `--denoise-only` redoes
            # just that step instead of baking again.
            save_raw(img, g)
            save_denoised(img, os.path.join(BAKE_DIR, f"{g}.png"))
            print(f"baked {g} in {times[g]} s", flush=True)
    finally:
        for o in restore:
            o.hide_render = False
    return times


def save_raw(img, group):
    os.makedirs(BAKE_DIR, exist_ok=True)
    img.filepath_raw = os.path.join(BAKE_DIR, f"{group}_raw.exr")
    img.file_format = "OPEN_EXR"
    img.save()


def denoise_only(groups):
    for g in groups:
        img = bpy.data.images.load(os.path.join(BAKE_DIR, f"{g}_raw.exr"), check_existing=False)
        save_denoised(img, os.path.join(BAKE_DIR, f"{g}.png"))
        print(f"denoised {g}", flush=True)


# Brightens the bake on save (stops). Tuned so the floor's median is about
# 0.5 in the PNG; the game's tone mapping darkens it a little again.
EXPOSURE = 0.5


def save_denoised(img, path, exposure=None):
    """Denoises a float bake image with the compositor and saves an 8-bit sRGB
    PNG (Standard view transform: the game applies its own tone mapping)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc = bpy.data.scenes.get("_denoise") or bpy.data.scenes.new("_denoise")
    sc.render.resolution_x, sc.render.resolution_y = img.size
    sc.render.resolution_percentage = 100
    sc.render.engine = "BLENDER_WORKBENCH"
    if sc.camera is None:
        cam = bpy.data.objects.new("_denoise_cam", bpy.data.cameras.new("_denoise_cam"))
        sc.collection.objects.link(cam)
        sc.camera = cam
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = EXPOSURE if exposure is None else exposure
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.image_settings.color_depth = "8"
    ng = bpy.data.node_groups.get("_denoise") or bpy.data.node_groups.new("_denoise", "CompositorNodeTree")
    ng.nodes.clear()
    if not ng.interface.items_tree:
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    src = ng.nodes.new("CompositorNodeImage")
    src.image = img
    dn = ng.nodes.new("CompositorNodeDenoise")
    dn.inputs["HDR"].default_value = True
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(src.outputs["Image"], dn.inputs["Image"])
    ng.links.new(dn.outputs["Image"], out.inputs[0])
    sc.compositing_node_group = ng
    sc.render.use_compositing = True
    # The GPU compositor can crash in background mode on small GPUs.
    sc.render.compositor_device = "CPU"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)


# ---------------------------------------------------------------------------
# After baking: atlas materials for export


def apply():
    """One Principled material per atlas, base color = the baked PNG. Kept
    separate from the bake-source materials; export_room.py swaps them in."""
    out = {}
    for g in GROUPS:
        path = os.path.join(BAKE_DIR, f"{g}.png")
        if not os.path.exists(path):
            continue
        img = bpy.data.images.get(f"room_{g}.png")
        if img is None:
            img = bpy.data.images.load(path)
            img.name = f"room_{g}.png"
        else:
            img.filepath = path
            img.reload()
        m = bpy.data.materials.get(f"room_{g}") or bpy.data.materials.new(f"room_{g}")
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        o = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        bsdf.inputs["Roughness"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(bsdf.outputs[0], o.inputs[0])
        out[g] = m.name
    return out


def _args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"samples": 256, "groups": list(GROUPS)}
    for i, a in enumerate(argv):
        if a == "--samples":
            opts["samples"] = int(argv[i + 1])
        elif a == "--denoise-only":
            opts["denoise_only"] = True
        elif a == "--size":  # quick low-resolution test bakes
            for g in GROUPS:
                GROUPS[g] = int(argv[i + 1])
        elif a == "--groups":
            opts["groups"] = argv[i + 1].split(",")
    return opts


if __name__ == "__main__" and bpy.app.background:
    opts = _args()
    if opts.get("denoise_only"):
        denoise_only(opts["groups"])
    else:
        print(bake(opts["groups"], opts["samples"]), flush=True)
