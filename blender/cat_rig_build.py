# Builds the game export skeleton from a generated Rigify cat rig and skins a
# mesh to it. Run inside Blender (Text Editor or exec), after generating the
# rig from the metarig.
#
# The export skeleton ("cat_rig") holds only the Rigify DEF-* bones, with a
# plain hierarchy the game can work with: legs and tail hang off the hips,
# front legs off the chest. Each bone follows the Rigify rig through a
# Copy Transforms constraint named "follow_rig"; cat_anims.py bakes the
# animations onto it and the constraints are muted for export.
import bpy
from mathutils.geometry import intersect_point_line
from collections import defaultdict

RIGIFY_RIG = "rig"
EXPORT_RIG = "cat_rig"
EXPORT_COLLECTION = "cat_export"


def export_parents():
    parents = {"DEF-spine": None}
    for i in range(1, 7):
        parents[f"DEF-spine.00{i}"] = "DEF-spine" if i == 1 else f"DEF-spine.00{i - 1}"
    parents["DEF-tail.001"] = "DEF-spine"
    for i in range(2, 5):
        parents[f"DEF-tail.00{i}"] = f"DEF-tail.00{i - 1}"
    for s in "LR":
        rear = ["thigh", "shin", "foot", "r_toe"]
        front = ["shoulder", "upper_arm", "forearm", "hand", "f_toe"]
        parents[f"DEF-thigh.{s}"] = "DEF-spine"
        parents[f"DEF-shoulder.{s}"] = "DEF-spine.003"
        for chain in (rear, front):
            for a, b in zip(chain, chain[1:]):
                parents[f"DEF-{b}.{s}"] = f"DEF-{a}.{s}"
    return parents


def build_export_rig():
    gen = bpy.data.objects[RIGIFY_RIG]
    parents = export_parents()
    deform = {b.name for b in gen.data.bones if b.use_deform}
    if deform != set(parents):
        raise RuntimeError(f"Unexpected deform bones: {sorted(deform ^ set(parents))}")

    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    gen.hide_set(False)
    gen.select_set(True)
    bpy.context.view_layer.objects.active = gen
    bpy.ops.object.mode_set(mode="EDIT")
    src = {n: (gen.data.edit_bones[n].head.copy(), gen.data.edit_bones[n].tail.copy(), gen.data.edit_bones[n].roll) for n in parents}
    bpy.ops.object.mode_set(mode="OBJECT")

    ex = bpy.data.objects.get(EXPORT_RIG)
    if ex:
        # Keep the object (the mesh is parented to it); just rebuild its bones.
        arm = ex.data
    else:
        arm = bpy.data.armatures.new(EXPORT_RIG)
        ex = bpy.data.objects.new(EXPORT_RIG, arm)
        bpy.data.collections[EXPORT_COLLECTION].objects.link(ex)

    bpy.ops.object.select_all(action="DESELECT")
    ex.hide_set(False)
    ex.select_set(True)
    bpy.context.view_layer.objects.active = ex
    bpy.ops.object.mode_set(mode="EDIT")
    for b in list(arm.edit_bones):
        arm.edit_bones.remove(b)
    for n, (h, t, roll) in src.items():
        b = arm.edit_bones.new(n)
        b.head, b.tail, b.roll = h, t, roll
        b.use_deform = True
    for n, p in parents.items():
        if p:
            arm.edit_bones[n].parent = arm.edit_bones[p]
    bpy.ops.object.mode_set(mode="POSE")
    for n in parents:
        pb = ex.pose.bones[n]
        for c in list(pb.constraints):
            pb.constraints.remove(c)
        c = pb.constraints.new("COPY_TRANSFORMS")
        c.name = "follow_rig"
        c.target = gen
        c.subtarget = n
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.display_type = "STICK"
    ex.show_in_front = True
    return ex


def skin(mesh_name, max_influences=4):
    """Automatic weights, then cleanup for the game: no unweighted vertices,
    identical weights on vertices that share a position (no seams opening),
    at most `max_influences` bones per vertex, normalized."""
    body = bpy.data.objects[mesh_name]
    ex = bpy.data.objects[EXPORT_RIG]
    body.vertex_groups.clear()
    for m in list(body.modifiers):
        if m.type == "ARMATURE":
            body.modifiers.remove(m)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    ex.select_set(True)
    bpy.context.view_layer.objects.active = ex
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    me = body.data
    bones = [(b.name, b.head_local, b.tail_local) for b in ex.data.bones]

    def nearest_bone(co):
        best = None
        for n, h, t in bones:
            _, f = intersect_point_line(co, h, t)
            f = max(0.0, min(1.0, f))
            d = (co - (h + (t - h) * f)).length
            if best is None or d < best[0]:
                best = (d, n)
        return best[1]

    unweighted = 0
    for v in me.vertices:
        if sum(g.weight for g in v.groups) < 0.01:
            for g in list(v.groups):
                body.vertex_groups[g.group].remove([v.index])
            body.vertex_groups[nearest_bone(v.co)].add([v.index], 1.0, "REPLACE")
            unweighted += 1

    by_pos = defaultdict(list)
    for v in me.vertices:
        by_pos[tuple(round(c, 5) for c in v.co)].append(v)
    for vs in by_pos.values():
        acc = defaultdict(float)
        for v in vs:
            for g in v.groups:
                acc[g.group] += g.weight / len(vs)
        top = sorted(acc.items(), key=lambda x: -x[1])[:max_influences]
        total = sum(w for _, w in top) or 1.0
        for v in vs:
            for g in list(v.groups):
                body.vertex_groups[g.group].remove([v.index])
            for gi, w in top:
                body.vertex_groups[gi].add([v.index], w / total, "REPLACE")

    max_inf = max(len([g for g in v.groups if g.weight > 0]) for v in me.vertices)
    return {"unweighted_fixed": unweighted, "max_influences": max_inf, "groups": len(body.vertex_groups)}


if __name__ == "__main__":
    build_export_rig()
    print(skin("cat_body"))
