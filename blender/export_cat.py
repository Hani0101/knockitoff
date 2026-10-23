# Exports the cat to assets-src/cat.glb with the settings the game expects
# (docs/blender-guide.md). Run inside Blender, then `npm run compress`.
#
# Exports only the mesh and the export skeleton ("cat_rig"), with the
# skeleton's "follow_rig" constraints muted so the baked actions are what
# gets sampled. Only the baked actions (the 12 game names) are exported;
# the "*__ctrl" actions on the Rigify rig stay in the .blend.
import bpy
import os

EXPORT_RIG = "cat_rig"
MESHES = ["cat_body"]
OUT = os.path.join(os.path.dirname(bpy.data.filepath), "..", "assets-src", "cat.glb")
GAME_ANIMS = [
    "idle", "walk", "run", "jump", "land", "climb",
    "swipe_L", "swipe_R", "grab", "hold", "throw", "trick",
]


def check():
    problems = []
    objs = [bpy.data.objects[EXPORT_RIG]] + [bpy.data.objects[n] for n in MESHES]
    for o in objs:
        if any(abs(s - 1) > 1e-6 for s in o.scale):
            problems.append(f"{o.name}: scale not applied {tuple(o.scale)}")
    for n in GAME_ANIMS:
        if n not in bpy.data.actions:
            problems.append(f"missing action {n}")
    for n in MESHES:
        me = bpy.data.objects[n]
        worst = max(len([g for g in v.groups if g.weight > 0]) for v in me.data.vertices)
        if worst > 4:
            problems.append(f"{n}: {worst} bone influences on a vertex (max 4)")
        for slot in me.material_slots:
            nodes = slot.material.node_tree.nodes if slot.material and slot.material.use_nodes else []
            if not any(nd.type == "BSDF_PRINCIPLED" for nd in nodes):
                problems.append(f"{n}: material {slot.material and slot.material.name} is not Principled BSDF")
    return problems


def export():
    problems = check()
    if problems:
        raise RuntimeError("Not exporting:\n" + "\n".join(problems))

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    ex = bpy.data.objects[EXPORT_RIG]
    for pb in ex.pose.bones:
        for c in pb.constraints:
            c.mute = True

    bpy.ops.object.select_all(action="DESELECT")
    for n in [EXPORT_RIG] + MESHES:
        o = bpy.data.objects[n]
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = ex
    ex.animation_data.action = bpy.data.actions["idle"]

    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    kwargs = dict(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_extras=True,
        export_apply=True,
        export_def_bones=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_influence_nb=4,
        export_skins=True,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    # Actions mode would also export the "*__ctrl" actions as frozen clips.
    # Fill the exporter's action filter (normally set up by its "Action
    # Filter" checkbox) so only the game actions are kept.
    import io_scene_gltf2
    if not hasattr(bpy.types.Scene, "gltf_action_filter"):
        bpy.types.Scene.gltf_action_filter = bpy.props.CollectionProperty(type=io_scene_gltf2.GLTF2_filter_action)
        bpy.types.Scene.gltf_action_filter_active = bpy.props.IntProperty()
    filt = bpy.data.scenes[0].gltf_action_filter
    filt.clear()
    for a in bpy.data.actions:
        item = filt.add()
        item.action = a
        item.keep = a.name in GAME_ANIMS
    kwargs["export_action_filter"] = True
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    finally:
        for pb in ex.pose.bones:
            for c in pb.constraints:
                c.mute = False
    return os.path.abspath(OUT)


if __name__ == "__main__":
    print(export())
