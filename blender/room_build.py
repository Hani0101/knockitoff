# Builds the Knock It Off room: living room plus kitchen corner, 8 x 6 m with
# 2.6 m walls. Run inside Blender with blender/room.blend open. Re-running
# rebuilds everything this script owns (see COLLECTIONS) from scratch.
#
# What it makes (see docs/blender-guide.md for how the game reads it):
#   room_static     furniture and shell, baked later (room_bake.py)
#   room_colliders  invisible convex `*-col` boxes
#   props           knockable props, with pre-cut pieces for fragile ones
#   room_lights     lights used only for baking
#   spawn           where the cat starts
#
# The layout and surface heights follow the grey-box room in src/game/room.ts,
# which gameplay was tuned on. Coordinates are Blender's: X east, Y north,
# Z up. The floor is X -4..4, Y -3..3.
import bpy
import bmesh
import math
import os
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(bpy.data.filepath)
exec(open(os.path.join(HERE, "room_lib.py"), encoding="utf-8").read(), globals())

W, D, H = 8.0, 6.0, 2.6
X0, X1, Y0, Y1 = -4.0, 4.0, -3.0, 3.0

COLLECTIONS = ["room_static", "room_colliders", "props", "room_lights", "room_markers", "_frac_tmp"]


def setup():
    for n in COLLECTIONS:
        c = bpy.data.collections.get(n)
        if c:
            clear_coll(c)
    global STATIC, COLS, PROPC, LIGHTS, MARKERS, TMP
    STATIC = get_coll("room_static")
    COLS = get_coll("room_colliders")
    PROPC = get_coll("props")
    LIGHTS = get_coll("room_lights")
    MARKERS = get_coll("room_markers")
    TMP = get_coll("_frac_tmp")


def static(name, bm, mats, group, **kw):
    """A baked static mesh. `group` picks its bake atlas (room_bake.py):
    floor, walls, living or kitchen."""
    obj = make_obj(name, bm, STATIC, mats, **kw)
    obj["bake_group"] = group
    return obj


# ---------------------------------------------------------------------------
# Materials used for baking (procedural is fine here: it ends up in the atlas)


def static_materials():
    M = {}
    M["floor"] = textured("floor_oak", (0.5, 0.33, 0.2), 0.5,
                          bricks((0.52, 0.34, 0.2), (0.44, 0.28, 0.16), (0.25, 0.16, 0.1), 1.2, 0.16, 0.003))
    M["wall"] = textured("wall_paint", (0.86, 0.8, 0.7), 0.9, speckle((0.87, 0.81, 0.71), (0.83, 0.77, 0.67), 3.0))
    M["accent_wall"] = textured("wall_accent", (0.55, 0.62, 0.58), 0.9,
                                speckle((0.56, 0.63, 0.59), (0.52, 0.59, 0.55), 3.0))
    M["ceiling"] = principled("ceiling_paint", (0.92, 0.9, 0.86), 0.95)
    M["trim"] = principled("trim_white", (0.93, 0.92, 0.88), 0.5)
    M["sofa"] = textured("sofa_fabric", (0.25, 0.38, 0.45), 0.95, speckle((0.26, 0.4, 0.47), (0.21, 0.33, 0.4), 120))
    M["oak"] = textured("oak", (0.6, 0.4, 0.23), 0.55, grain((0.62, 0.42, 0.25), (0.5, 0.32, 0.18), 5.0, (1, 6, 1)))
    M["walnut"] = textured("walnut", (0.3, 0.18, 0.11), 0.5, grain((0.32, 0.2, 0.12), (0.24, 0.14, 0.08), 5.0, (1, 6, 1)))
    M["cabinet"] = principled("cabinet_sage", (0.45, 0.55, 0.45), 0.6)
    M["counter"] = textured("countertop", (0.86, 0.84, 0.8), 0.4, speckle((0.88, 0.86, 0.82), (0.76, 0.74, 0.7), 25))
    M["tiles"] = textured("tiles", (0.92, 0.92, 0.9), 0.3,
                          bricks((0.93, 0.93, 0.91), (0.88, 0.89, 0.88), (0.6, 0.6, 0.58), 0.15, 0.075, 0.004, 0.5, "YZ"))
    M["tiles_n"] = textured("tiles_n", (0.92, 0.92, 0.9), 0.3,
                            bricks((0.93, 0.93, 0.91), (0.88, 0.89, 0.88), (0.6, 0.6, 0.58), 0.15, 0.075, 0.004, 0.5, "XZ"))
    M["steel"] = principled("steel_matte", (0.62, 0.63, 0.65), 0.35)
    M["dark"] = principled("dark_trim", (0.08, 0.08, 0.09), 0.4)
    M["fridge"] = principled("fridge_cream", (0.88, 0.86, 0.79), 0.35)
    M["rug"] = textured("rug", (0.7, 0.3, 0.25), 0.95,
                        bricks((0.72, 0.36, 0.28), (0.8, 0.7, 0.55), (0.35, 0.18, 0.15), 0.35, 0.35, 0.03, 0.0, "XY"))
    M["curtain"] = textured("curtain_linen", (0.88, 0.83, 0.72), 0.95, speckle((0.9, 0.85, 0.74), (0.84, 0.79, 0.68), 60))
    M["lampshade"] = principled("lampshade_glow", (0.95, 0.9, 0.8), 0.9, emit=(1.0, 0.85, 0.65), emit_strength=6.0)
    M["leaf"] = principled("plant_leaf", (0.18, 0.42, 0.18), 0.6)
    M["terracotta"] = principled("terracotta", (0.66, 0.33, 0.2), 0.8)
    M["soil"] = principled("soil", (0.14, 0.1, 0.07), 1.0)
    M["art_a"] = textured("art_a", (0.8, 0.5, 0.3), 0.8, grain((0.88, 0.55, 0.3), (0.2, 0.35, 0.5), 1.5, (1, 1, 1)))
    M["art_b"] = textured("art_b", (0.4, 0.6, 0.5), 0.8, grain((0.95, 0.85, 0.6), (0.35, 0.55, 0.45), 2.5, (1, 1, 1)))
    M["clock_face"] = principled("clock_face", (0.95, 0.94, 0.9), 0.6)
    return M


# ---------------------------------------------------------------------------
# Shell: floor, ceiling, walls with openings, trim


def wall_with_holes(name, frame, length, holes, mat_idx, mats, group, depth=0.2):
    """A wall's inner face with rectangular openings and their reveals.
    `frame(u, v, w)` maps wall coordinates to world: u along the wall,
    v up, w into the wall (0 = inner face). Holes are (u0, u1, v0, v1)."""
    bm = bmesh.new()
    us = sorted({0.0, length, *[h[0] for h in holes], *[h[1] for h in holes]})
    vs = sorted({-0.01, H + 0.01, *[h[2] for h in holes], *[h[3] for h in holes]})
    inward = (frame(0, 0, -1) - frame(0, 0, 0)).normalized()

    def quad(pts, want):
        f = bm.faces.new([bm.verts.new(p) for p in pts])
        f.normal_update()
        if f.normal.dot(want) < 0:
            f.normal_flip()
        f.material_index = mat_idx

    for i in range(len(us) - 1):
        for j in range(len(vs) - 1):
            cu, cv = (us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2
            if any(h[0] < cu < h[1] and h[2] < cv < h[3] for h in holes):
                continue
            quad([frame(us[i], vs[j], 0), frame(us[i + 1], vs[j], 0),
                  frame(us[i + 1], vs[j + 1], 0), frame(us[i], vs[j + 1], 0)], inward)
    for u0, u1, v0, v1 in holes:
        up = frame(0, 1, 0) - frame(0, 0, 0)
        along = frame(1, 0, 0) - frame(0, 0, 0)
        if v0 > 0.01:  # sill
            quad([frame(u0, v0, 0), frame(u1, v0, 0), frame(u1, v0, depth), frame(u0, v0, depth)], up)
        quad([frame(u0, v1, 0), frame(u1, v1, 0), frame(u1, v1, depth), frame(u0, v1, depth)], -up)
        quad([frame(u0, v0, 0), frame(u0, v1, 0), frame(u0, v1, depth), frame(u0, v0, depth)], along)
        quad([frame(u1, v0, 0), frame(u1, v1, 0), frame(u1, v1, depth), frame(u1, v0, depth)], -along)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    return static(name, bm, mats, group, smooth=False)


def build_shell(M):
    # Floor and ceiling run under the walls so no light leaks at the edges.
    def plane(z, flip):
        bm = bmesh.new()
        pts = [(X0 - 0.2, Y0 - 0.2, z), (X1 + 0.2, Y0 - 0.2, z), (X1 + 0.2, Y1 + 0.2, z), (X0 - 0.2, Y1 + 0.2, z)]
        f = bm.faces.new([bm.verts.new(p) for p in (pts[::-1] if flip else pts)])
        # A few cuts so the baked lighting has vertices to work with in the viewport.
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=3, use_grid_fill=True)
        return bm
    static("floor", plane(0.0, False), [M["floor"]], "floor", smooth=False)
    static("ceiling", plane(H, True), [M["ceiling"]], "walls", smooth=False)
    collider(COLS, "floor", (X0 - 0.2, Y0 - 0.2, -0.2), (X1 + 0.2, Y1 + 0.2, 0.0))
    collider(COLS, "wall_north", (X0 - 0.2, Y1, 0), (X1 + 0.2, Y1 + 0.2, H))
    collider(COLS, "wall_south", (X0 - 0.2, Y0 - 0.2, 0), (X1 + 0.2, Y0, H))
    collider(COLS, "wall_west", (X0 - 0.2, Y0, 0), (X0, Y1, H))
    collider(COLS, "wall_east", (X1, Y0, 0), (X1 + 0.2, Y1, H))
    collider(COLS, "ceiling", (X0, Y0, H), (X1, Y1, H + 0.2))

    # North wall (y = 3): window over the sofa. South wall (y = -3): window
    # over the dining table and the front door.
    # Openings are (u0, u1, v0, v1) in wall coordinates: u runs along the
    # wall from its start corner (north wall: from x = -4 east; south wall:
    # from x = 4 west), v is height.
    north_win = (1.05, 2.55, 1.0, 2.2)    # x -2.95 .. -1.45, over the sofa
    south_win = (1.4, 3.0, 0.95, 2.2)     # x 2.6 .. 1.0, over the dining table
    door = (4.05, 4.95, 0.0, 2.05)        # x -0.05 .. -0.95
    wall_with_holes("wall_north", lambda u, v, w: Vector((X0 + u, Y1 + w, v)), W, [north_win], 0,
                    [M["wall"]], "walls")
    wall_with_holes("wall_south", lambda u, v, w: Vector((X1 - u, Y0 - w, v)), W, [south_win, door], 0,
                    [M["wall"]], "walls")
    wall_with_holes("wall_west", lambda u, v, w: Vector((X0 - w, Y0 + u, v)), D, [], 0, [M["accent_wall"]], "walls")
    wall_with_holes("wall_east", lambda u, v, w: Vector((X1 + w, Y1 - u, v)), D, [], 0, [M["wall"]], "walls")

    # Baseboards (skip the door).
    bm = bmesh.new()
    t, h = 0.015, 0.08
    add_box_minmax(bm, (X0, Y1 - t, 0), (X1, Y1, h))
    add_box_minmax(bm, (X0, Y0 - 0.0, 0), (X0 + t, Y1, h))
    add_box_minmax(bm, (X1 - t, Y0, 0), (X1, Y1, h))
    dx0, dx1 = X1 - door[1], X1 - door[0]
    add_box_minmax(bm, (X0, Y0, 0), (dx0 - 0.07, Y0 + t, h))
    add_box_minmax(bm, (dx1 + 0.07, Y0, 0), (X1, Y0 + t, h))
    static("baseboards", bm, [M["trim"]], "walls", smooth=False)

    windows = [
        ("north", lambda u, v, w: Vector((X0 + u, Y1 + w, v)), north_win),
        ("south", lambda u, v, w: Vector((X1 - u, Y0 - w, v)), south_win),
    ]
    for name, frame, (u0, u1, v0, v1) in windows:
        build_window(M, name, frame, u0, u1, v0, v1)
    build_door(M, lambda u, v, w: Vector((X1 - u, Y0 - w, v)), *door)
    return windows


def _frame_box(bm, frame, u0, u1, v0, v1, w0, w1, mat=0, bevel=0.0):
    a, b = frame(u0, v0, w0), frame(u1, v1, w1)
    lo = Vector((min(a.x, b.x), min(a.y, b.y), min(a.z, b.z)))
    hi = Vector((max(a.x, b.x), max(a.y, b.y), max(a.z, b.z)))
    add_box_minmax(bm, lo, hi, mat=mat, bevel=bevel)


def build_window(M, name, frame, u0, u1, v0, v1):
    bm = bmesh.new()
    f = 0.05  # frame width
    _frame_box(bm, frame, u0, u1, v0, v0 + f, 0.08, 0.13)
    _frame_box(bm, frame, u0, u1, v1 - f, v1, 0.08, 0.13)
    _frame_box(bm, frame, u0, u0 + f, v0, v1, 0.08, 0.13)
    _frame_box(bm, frame, u1 - f, u1, v0, v1, 0.08, 0.13)
    um, vm = (u0 + u1) / 2, v0 + (v1 - v0) * 0.62
    _frame_box(bm, frame, um - 0.02, um + 0.02, v0, v1, 0.09, 0.12)
    _frame_box(bm, frame, u0, u1, vm - 0.02, vm + 0.02, 0.09, 0.12)
    # Inside sill and casing.
    _frame_box(bm, frame, u0 - 0.06, u1 + 0.06, v0 - 0.03, v0, -0.06, 0.1, bevel=0.005)
    _frame_box(bm, frame, u0 - 0.07, u1 + 0.07, v1, v1 + 0.07, -0.015, 0.0)
    _frame_box(bm, frame, u0 - 0.07, u0, v0 - 0.08, v1, -0.015, 0.0)
    _frame_box(bm, frame, u1, u1 + 0.07, v0 - 0.08, v1, -0.015, 0.0)
    _frame_box(bm, frame, u0 - 0.04, u1 + 0.04, v0 - 0.08, v0 - 0.03, -0.015, 0.0)
    static(f"window_{name}", bm, [M["trim"]], "walls", smooth=False)

    # The view outside: an unlit sky picture, not part of the bake.
    bm = bmesh.new()
    pts = [frame(u0, v0, 0.15), frame(u1, v0, 0.15), frame(u1, v1, 0.15), frame(u0, v1, 0.15)]
    face = bm.faces.new([bm.verts.new(p) for p in pts])
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, co in zip(face.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop[uv].uv = co
    face.normal_update()
    inward = frame(0, 0, -1) - frame(0, 0, 0)
    if face.normal.dot(inward) < 0:
        face.normal_flip()
    sky = make_obj(f"window_{name}_view", bm, STATIC, [sky_material()], smooth=False)
    sky["baked"] = True
    sky["bake_exclude"] = True

    # Curtains either side, a rod above.
    for side, (cu0, cu1) in (("l", (u0 - 0.45, u0 + 0.05)), ("r", (u1 - 0.05, u1 + 0.45))):
        bm = bmesh.new()
        nu, nv = 18, 6
        grid = []
        for j in range(nv + 1):
            row = []
            for i in range(nu + 1):
                u = cu0 + (cu1 - cu0) * i / nu
                v = 0.05 + (v1 + 0.18 - 0.05) * j / nv
                wv = -0.08 - 0.03 * math.sin(i / nu * math.pi * 5)
                row.append(bm.verts.new(frame(u, v, wv)))
            grid.append(row)
        for j in range(nv):
            for i in range(nu):
                bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
        static(f"curtain_{name}_{side}", bm, [M["curtain"]], "walls", smooth=True, sharp_angle=80)
    bm = bmesh.new()
    a, b = frame(u0 - 0.55, v1 + 0.2, -0.1), frame(u1 + 0.55, v1 + 0.2, -0.1)
    d = b - a
    add_cyl(bm, 0.012, d.length, center=a, segs=10, rot=d.to_track_quat("Z", "Y"))
    static(f"curtain_rod_{name}", bm, [M["walnut"]], "walls")


_SKY = None


def sky_material():
    """A small gradient picture for the windows, shown unlit in the game."""
    global _SKY
    if _SKY:
        return _SKY
    img = bpy.data.images.get("window_sky") or bpy.data.images.new("window_sky", 32, 64)
    px = []
    for y in range(64):
        t = y / 63
        top = (0.55, 0.72, 0.95)
        low = (0.86, 0.92, 0.97)
        c = [low[k] + (top[k] - low[k]) * t for k in range(3)]
        if t < 0.3:  # distant hedge
            c = [0.36 + 0.1 * t, 0.5 + 0.1 * t, 0.36]
        for x in range(32):
            px += [*c, 1.0]
    img.pixels = px
    img.pack()
    m = principled("window_view", (1, 1, 1), 1.0)
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    _SKY = m
    return m


def build_door(M, frame, u0, u1, v0, v1):
    bm = bmesh.new()
    _frame_box(bm, frame, u0, u1, v0, v1, 0.04, 0.08, mat=0, bevel=0.004)
    # Panels: slightly proud rectangles.
    for (a0, a1, b0, b1) in ((0.12, 0.42, 1.15, 1.9), (0.48, 0.78, 1.15, 1.9), (0.12, 0.42, 0.15, 1.0), (0.48, 0.78, 0.15, 1.0)):
        _frame_box(bm, frame, u0 + a0, u0 + a1, b0, b1, 0.03, 0.04, mat=0, bevel=0.003)
    # Casing.
    _frame_box(bm, frame, u0 - 0.08, u0, 0, v1 + 0.08, -0.015, 0, mat=1)
    _frame_box(bm, frame, u1, u1 + 0.08, 0, v1 + 0.08, -0.015, 0, mat=1)
    _frame_box(bm, frame, u0 - 0.08, u1 + 0.08, v1, v1 + 0.08, -0.015, 0, mat=1)
    knob = frame(u0 + 0.08, 1.0, 0.0)
    inward = (frame(0, 0, -1) - frame(0, 0, 0)).normalized()
    add_sphere(bm, 0.03, center=knob + inward * 0.01, segs=12, rings=8, mat=2)
    static("door", bm, [M["oak"], M["trim"], M["steel"]], "walls")


# ---------------------------------------------------------------------------
# Living room (west half)


def build_sofa(M):
    x0, x1, y0, y1 = -3.2, -1.2, 2.125, 2.975
    bm = bmesh.new()
    for x in (x0 + 0.08, x1 - 0.08):
        for y in (y0 + 0.08, y1 - 0.08):
            add_cyl(bm, 0.025, 0.08, center=(x, y, 0), segs=10, r_top=0.018, mat=1)
    add_box_minmax(bm, (x0, y0 + 0.02, 0.08), (x1, y1, 0.3), bevel=0.02, segs=2)               # frame
    add_box_minmax(bm, (x0, y1 - 0.2, 0.3), (x1, y1, 0.85), bevel=0.04, segs=3)                # back
    add_box_minmax(bm, (x0, y0, 0.08), (x0 + 0.2, y1, 0.6), bevel=0.05, segs=3)               # arms
    add_box_minmax(bm, (x1 - 0.2, y0, 0.08), (x1, y1, 0.6), bevel=0.05, segs=3)
    xm = (x0 + x1) / 2
    for a, b in ((x0 + 0.2, xm), (xm, x1 - 0.2)):                                             # seat cushions
        add_box_minmax(bm, (a + 0.005, y0, 0.3), (b - 0.005, y1 - 0.2, 0.45), bevel=0.04, segs=3)
        add_box_minmax(bm, (a + 0.01, y1 - 0.36, 0.45), (b - 0.01, y1 - 0.18, 0.8), bevel=0.06, segs=3,
                       rot=None)                                                               # back cushions
    static("sofa", bm, [M["sofa"], M["walnut"]], "living")
    collider(COLS, "sofa_base", (x0, y0, 0), (x1, y1, 0.45))
    collider(COLS, "sofa_back", (x0, y1 - 0.2, 0.45), (x1, y1, 0.85))
    collider(COLS, "sofa_arm_l", (x0, y0, 0.45), (x0 + 0.2, y1, 0.6))
    collider(COLS, "sofa_arm_r", (x1 - 0.2, y0, 0.45), (x1, y1, 0.6))


def table(M, name, cx, cy, w, d, top_z, thick, leg, mat, group, inset=0.05, apron=0.0):
    """Four-legged table with a separate collider for the top and each leg,
    so the cat can walk underneath."""
    bm = bmesh.new()
    add_box_minmax(bm, (cx - w / 2, cy - d / 2, top_z - thick), (cx + w / 2, cy + d / 2, top_z), bevel=0.008, segs=2)
    lx, ly = w / 2 - inset - leg / 2, d / 2 - inset - leg / 2
    for sx in (-1, 1):
        for sy in (-1, 1):
            add_box_minmax(bm, (cx + sx * lx - leg / 2, cy + sy * ly - leg / 2, 0),
                           (cx + sx * lx + leg / 2, cy + sy * ly + leg / 2, top_z - thick), bevel=0.004)
            collider(COLS, f"{name}_leg", (cx + sx * lx - leg / 2, cy + sy * ly - leg / 2, 0),
                     (cx + sx * lx + leg / 2, cy + sy * ly + leg / 2, top_z - thick))
    if apron:
        a = apron
        add_box_minmax(bm, (cx - lx, cy - ly - 0.01, top_z - thick - a), (cx + lx, cy - ly + 0.01, top_z - thick))
        add_box_minmax(bm, (cx - lx, cy + ly - 0.01, top_z - thick - a), (cx + lx, cy + ly + 0.01, top_z - thick))
        add_box_minmax(bm, (cx - lx - 0.01, cy - ly, top_z - thick - a), (cx - lx + 0.01, cy + ly, top_z - thick))
        add_box_minmax(bm, (cx + lx - 0.01, cy - ly, top_z - thick - a), (cx + lx + 0.01, cy + ly, top_z - thick))
    static(name, bm, [mat], group)
    collider(COLS, f"{name}_top", (cx - w / 2, cy - d / 2, top_z - thick), (cx + w / 2, cy + d / 2, top_z))


def build_living(M):
    build_sofa(M)
    # Coffee table: top at 0.45, underside at 0.4 so the cat fits under.
    table(M, "coffee_table", -2.2, 1.2, 1.1, 0.6, 0.45, 0.05, 0.05, M["oak"], "living")

    # Rug under the coffee table.
    bm = bmesh.new()
    add_box_minmax(bm, (-3.3, 0.45, 0.0), (-1.1, 1.95, 0.008), bevel=0.003)
    static("rug", bm, [M["rug"]], "living", smooth=False)

    # Side table by the sofa: top at 0.6.
    x0, x1, y0, y1 = -3.825, -3.375, 2.375, 2.825
    bm = bmesh.new()
    add_box_minmax(bm, (x0, y0, 0.57), (x1, y1, 0.6), bevel=0.006)
    add_box_minmax(bm, (x0 + 0.02, y0 + 0.02, 0.42), (x1 - 0.02, y1 - 0.02, 0.57))
    add_box_minmax(bm, (x1 - 0.022, y0 + 0.06, 0.44), (x1 - 0.019, y1 - 0.06, 0.55), mat=1)   # drawer front
    add_sphere(bm, 0.012, center=(x1 - 0.012, (y0 + y1) / 2, 0.495), segs=10, rings=6, mat=2)
    for x in (x0 + 0.04, x1 - 0.04):
        for y in (y0 + 0.04, y1 - 0.04):
            add_cyl(bm, 0.018, 0.42, center=(x, y, 0), segs=10, r_top=0.022)
    static("side_table", bm, [M["walnut"], M["oak"], M["steel"]], "living")
    collider(COLS, "side_table", (x0, y0, 0), (x1, y1, 0.6))

    # TV stand along the south wall: top at 0.5.
    x0, x1, y0, y1 = -3.0, -1.4, -2.975, -2.525
    bm = bmesh.new()
    add_box_minmax(bm, (x0, y0, 0.08), (x1, y1, 0.5), bevel=0.008, segs=2)
    for i in range(3):
        a = x0 + 0.02 + i * (x1 - x0 - 0.04) / 3
        b = a + (x1 - x0 - 0.04) / 3 - 0.006
        add_box_minmax(bm, (a, y1, 0.11), (b, y1 + 0.012, 0.47), bevel=0.003, mat=1)
        add_box_minmax(bm, ((a + b) / 2 - 0.06, y1 + 0.012, 0.42), ((a + b) / 2 + 0.06, y1 + 0.022, 0.43), mat=2)
    for x in (x0 + 0.06, x1 - 0.06):
        for y in (y0 + 0.06, y1 - 0.06):
            add_cyl(bm, 0.02, 0.08, center=(x, y, 0), segs=10, mat=2)
    static("tv_stand", bm, [M["walnut"], M["oak"], M["dark"]], "living")
    collider(COLS, "tv_stand", (x0, y0, 0), (x1, y1, 0.5))

    # Desk against the west wall: top at 0.75, open underneath.
    x0, x1, y0, y1 = -4.0, -3.4, -0.9, 0.3
    bm = bmesh.new()
    add_box_minmax(bm, (x0, y0, 0.72), (x1, y1, 0.75), bevel=0.006)
    add_box_minmax(bm, (x0, y0, 0), (x1 - 0.02, y0 + 0.025, 0.72))
    add_box_minmax(bm, (x0, y1 - 0.025, 0), (x1 - 0.02, y1, 0.72))
    add_box_minmax(bm, (x0, y0 + 0.025, 0.4), (x0 + 0.02, y1 - 0.025, 0.72))
    static("desk", bm, [M["oak"]], "living")
    collider(COLS, "desk_top", (x0, y0, 0.72), (x1, y1, 0.75))
    collider(COLS, "desk_side", (x0, y0, 0), (x1 - 0.02, y0 + 0.025, 0.72))
    collider(COLS, "desk_side", (x0, y1 - 0.025, 0), (x1 - 0.02, y1, 0.72))

    # Open bookshelf next to the desk: boards at 0, 0.5, 1.0, top at 1.6.
    x0, x1 = -3.995, -3.645
    ya, yb = -2.1, -1.1
    parts = [
        ((x0, ya, 0), (x1, ya + 0.03, 1.55)),
        ((x0, yb - 0.03, 0), (x1, yb, 1.55)),
        ((x0 - 0.005, ya, 0), (x0 + 0.025, yb, 1.55)),
        ((x0, ya + 0.03, 1.55), (x1, yb - 0.03, 1.6)),
    ]
    for z in (0.0, 0.5, 1.0):
        parts.append(((x0, ya + 0.03, z), (x1, yb - 0.03, z + 0.03)))
    bm = bmesh.new()
    for lo, hi in parts:
        add_box_minmax(bm, lo, hi, bevel=0.003)
    static("bookshelf", bm, [M["walnut"]], "living")
    for k, (lo, hi) in enumerate(parts):
        collider(COLS, "bookshelf", lo, hi)
    # The top overhangs a little.
    collider(COLS, "bookshelf_top", (x0, ya, 1.55), (x1, yb, 1.6))

    # Floor plant in the south-east corner and pictures on the walls.
    bm = bmesh.new()
    add_lathe(bm, [(0, 0), (0.15, 0), (0.19, 0.38), (0.175, 0.38), (0.0, 0.36)], 24, mat=0)
    add_cyl(bm, 0.17, 0.01, center=(0, 0, 0.355), segs=24, mat=1)
    for k in range(9):
        a = k * 2.4
        tilt = 0.5 + 0.25 * (k % 3)
        q = Euler((tilt, 0, a)).to_quaternion()
        add_sphere(bm, 0.05, center=Vector((0, 0, 0.36)) + q @ Vector((0, 0, 0.32)),
                   scale=(0.6, 0.25, 4.0), segs=10, rings=8, mat=2, rot=q)
    plant = static("floor_plant", bm, [M["terracotta"], M["soil"], M["leaf"]], "living")
    plant.location = (3.55, -2.55, 0)
    plant.data.transform(Matrix.Translation(plant.location))
    plant.location = (0, 0, 0)
    collider(COLS, "floor_plant", (3.37, -2.73, 0), (3.73, -2.37, 0.38))

    art = [("art_west", (-3.995, 2.55, 1.5), 0.55, 0.42, "X", M["art_a"]),
           ("art_south", (-2.2, -2.995, 1.6), 0.9, 0.5, "Y", M["art_b"])]
    for name, c, w, h, axis, mat in art:
        bm = bmesh.new()
        c = Vector(c)
        inward = Vector((1, 0, 0)) if axis == "X" else Vector((0, 1, 0))
        along = Vector((0, 1, 0)) if axis == "X" else Vector((1, 0, 0))
        size_frame = along * w + inward * 0.03 + Vector((0, 0, h))
        size_frame = Vector((abs(size_frame.x), abs(size_frame.y), abs(size_frame.z)))
        add_box(bm, size_frame, c + inward * 0.015, bevel=0.005, mat=1)
        size_art = along * (w - 0.08) + inward * 0.004 + Vector((0, 0, h - 0.08))
        size_art = Vector((abs(size_art.x), abs(size_art.y), abs(size_art.z)))
        add_box(bm, size_art, c + inward * 0.031, mat=0)
        static(name, bm, [mat, M["walnut"]], "living", smooth=False)


# ---------------------------------------------------------------------------
# Kitchen (east side) and dining


def cabinets_run(bm, axis, a0, a1, front, back, z0, z1, door_w, mat_door, mat_handle, facing):
    """Doors and handles along a cabinet front. `axis` 'Y' for a run along Y
    (front plane at x = front), 'X' for a run along X (front at y = front)."""
    n = max(1, round((a1 - a0) / door_w))
    step = (a1 - a0) / n
    for i in range(n):
        s0, s1 = a0 + i * step + 0.003, a0 + (i + 1) * step - 0.003
        if axis == "Y":
            add_box_minmax(bm, (front + facing * 0.018 if facing < 0 else front, s0, z0),
                           (front if facing < 0 else front + 0.018, s1, z1), bevel=0.003, mat=mat_door)
            hx = front + facing * 0.03
            add_box_minmax(bm, (min(hx, front + facing * 0.018), (s0 + s1) / 2 - 0.06, z1 - 0.06),
                           (max(hx, front + facing * 0.018), (s0 + s1) / 2 + 0.06, z1 - 0.045), mat=mat_handle)
        else:
            add_box_minmax(bm, (s0, front + facing * 0.018 if facing < 0 else front, z0),
                           (s1, front if facing < 0 else front + 0.018, z1), bevel=0.003, mat=mat_door)
            hy = front + facing * 0.03
            add_box_minmax(bm, ((s0 + s1) / 2 - 0.06, min(hy, front + facing * 0.018), z1 - 0.06),
                           ((s0 + s1) / 2 + 0.06, max(hy, front + facing * 0.018), z1 - 0.045), mat=mat_handle)


def build_kitchen(M):
    mats = [M["cabinet"], M["counter"], M["steel"], M["dark"]]
    # East counter run: x 3.4..4.0, y 0.2..3.0. North run: x 1.6..3.4, y 2.4..3.0.
    bm = bmesh.new()
    add_box_minmax(bm, (3.44, 0.2, 0.1), (4.0, 3.0, 0.86))
    add_box_minmax(bm, (3.49, 0.22, 0.0), (4.0, 3.0, 0.1), mat=3)
    add_box_minmax(bm, (1.6, 2.44, 0.1), (3.44, 3.0, 0.86))
    add_box_minmax(bm, (1.62, 2.49, 0.0), (3.49, 3.0, 0.1), mat=3)
    cabinets_run(bm, "Y", 0.2, 2.44, 3.44, None, 0.12, 0.84, 0.6, 0, 2, -1)
    cabinets_run(bm, "X", 1.6, 3.44, 2.44, None, 0.12, 0.84, 0.6, 0, 2, -1)
    # Countertop with a small front overhang.
    add_box_minmax(bm, (3.4, 0.19, 0.86), (4.0, 3.0, 0.9), bevel=0.004, mat=1)
    add_box_minmax(bm, (1.6, 2.4, 0.86), (3.4, 3.0, 0.9), bevel=0.004, mat=1)
    # Sink (inset look) and cooktop.
    add_box_minmax(bm, (2.45, 2.5, 0.9), (2.95, 2.86, 0.903), bevel=0.002, mat=2)
    add_box_minmax(bm, (2.48, 2.53, 0.9005), (2.92, 2.83, 0.9035), mat=3)
    add_box_minmax(bm, (3.46, 1.65, 0.9), (3.96, 2.2, 0.905), bevel=0.002, mat=3)
    for (x, y) in ((3.58, 1.78), (3.82, 1.78), (3.58, 2.06), (3.82, 2.06)):
        add_tube(bm, 0.075, 0.068, 0.001, center=(x, y, 0.905), segs=24, mat=2)
    static("kitchen_counters", bm, mats, "kitchen")
    collider(COLS, "counter_e", (3.4, 0.2, 0), (4.0, 3.0, 0.9))
    collider(COLS, "counter_n", (1.6, 2.4, 0), (3.4, 3.0, 0.9))

    # Faucet behind the sink.
    bm = bmesh.new()
    add_cyl(bm, 0.022, 0.05, center=(2.7, 2.92, 0.9), segs=16)
    add_cyl(bm, 0.012, 0.22, center=(2.7, 2.92, 0.95), segs=12)
    add_arc_tube(bm, 0.08, 0.012, 0, math.pi * 0.9, center=(2.7, 2.84, 1.17), plane="YZ", steps=10, sides=10)
    static("faucet", bm, [M["steel"]], "kitchen")
    collider(COLS, "faucet", (2.67, 2.75, 0.9), (2.73, 2.95, 1.27))

    # Backsplash tiles between counter and upper cabinets.
    bm = bmesh.new()
    add_box_minmax(bm, (3.99, 0.2, 0.9), (4.0, 3.0, 1.45))
    static("backsplash_e", bm, [M["tiles"]], "kitchen", smooth=False)
    bm = bmesh.new()
    add_box_minmax(bm, (1.6, 2.99, 0.9), (3.99, 3.0, 1.45))
    static("backsplash_n", bm, [M["tiles_n"]], "kitchen", smooth=False)

    # Upper cabinets (leave room above the cooktop for the hood).
    bm = bmesh.new()
    uppers = [((1.6, 2.65, 1.45), (3.65, 3.0, 2.15)), ((3.65, 2.3, 1.45), (4.0, 3.0, 2.15)),
              ((3.65, 0.3, 1.45), (4.0, 1.55, 2.15))]
    for lo, hi in uppers:
        add_box_minmax(bm, lo, hi, bevel=0.004)
    cabinets_run(bm, "X", 1.6, 3.65, 2.65, None, 1.47, 2.13, 0.5, 0, 2, -1)
    cabinets_run(bm, "Y", 2.3, 3.0, 3.65, None, 1.47, 2.13, 0.35, 0, 2, -1)
    cabinets_run(bm, "Y", 0.3, 1.55, 3.65, None, 1.47, 2.13, 0.42, 0, 2, -1)
    # Range hood above the cooktop.
    add_box_minmax(bm, (3.5, 1.62, 1.6), (4.0, 2.23, 1.72), bevel=0.01, mat=1)
    add_box_minmax(bm, (3.72, 1.8, 1.72), (4.0, 2.05, H), mat=1)
    static("upper_cabinets", bm, [M["cabinet"], M["steel"], M["steel"]], "kitchen")
    for k, (lo, hi) in enumerate(uppers):
        collider(COLS, "upper_cabinet", lo, hi)
    collider(COLS, "hood", (3.5, 1.62, 1.6), (4.0, 2.23, H))

    # Fridge: top at 1.75, reached from the east counter.
    x0, x1, y0, y1 = 3.3, 4.0, -0.7, 0.0
    bm = bmesh.new()
    add_box_minmax(bm, (x0 + 0.02, y0, 0.03), (x1, y1, 1.75), bevel=0.03, segs=3)
    add_box_minmax(bm, (x0, y0 + 0.01, 0.06), (x0 + 0.03, y1 - 0.01, 1.17), bevel=0.012, segs=2)
    add_box_minmax(bm, (x0, y0 + 0.01, 1.19), (x0 + 0.03, y1 - 0.01, 1.72), bevel=0.012, segs=2)
    for z0, z1 in ((0.7, 1.05), (1.25, 1.45)):
        add_cyl(bm, 0.012, z1 - z0, center=(x0 - 0.03, y1 - 0.08, z0), segs=10, mat=1)
    add_box_minmax(bm, (x0 + 0.04, y0 + 0.02, 0.0), (x1, y1 - 0.02, 0.03), mat=2)
    static("fridge", bm, [M["fridge"], M["steel"], M["dark"]], "kitchen")
    collider(COLS, "fridge", (x0, y0, 0), (x1, y1, 1.75))

    # Dining table (top at 0.75) and two chairs (seats at 0.45).
    table(M, "dining_table", 1.8, -1.4, 1.2, 0.8, 0.75, 0.035, 0.06, M["oak"], "kitchen", inset=0.06, apron=0.07)
    for name, cy, back_sign in (("chair_a", -0.7, 1), ("chair_b", -2.1, -1)):
        bm = bmesh.new()
        cx, s = 1.8, 0.42
        add_box_minmax(bm, (cx - s / 2, cy - s / 2, 0.41), (cx + s / 2, cy + s / 2, 0.45), bevel=0.006)
        by = cy + back_sign * (s / 2 - 0.02)
        for sx in (-1, 1):
            for sy in (-1, 1):
                lx, ly = cx + sx * (s / 2 - 0.03), cy + sy * (s / 2 - 0.03)
                top = 0.9 if sy == back_sign else 0.41
                add_box_minmax(bm, (lx - 0.018, ly - 0.018, 0), (lx + 0.018, ly + 0.018, top), bevel=0.003)
                collider(COLS, f"{name}_leg", (lx - 0.018, ly - 0.018, 0), (lx + 0.018, ly + 0.018, 0.41))
        for z in (0.6, 0.72, 0.84):
            add_box_minmax(bm, (cx - s / 2 + 0.03, by - 0.012, z - 0.03), (cx + s / 2 - 0.03, by + 0.012, z + 0.03),
                           bevel=0.004)
        static(name, bm, [M["oak"]], "kitchen")
        collider(COLS, f"{name}_seat", (cx - s / 2, cy - s / 2, 0.41), (cx + s / 2, cy + s / 2, 0.45))
        collider(COLS, f"{name}_back", (cx - s / 2, by - 0.02, 0.45), (cx + s / 2, by + 0.02, 0.9))

    # Wall clock above the north counter.
    bm = bmesh.new()
    rot = Euler((math.pi / 2, 0, 0)).to_quaternion()
    add_cyl(bm, 0.16, 0.035, center=(1.1, 2.995, 1.95), segs=32, mat=1, rot=rot)
    add_cyl(bm, 0.145, 0.004, center=(1.1, 2.958, 1.95), segs=32, mat=0, rot=rot)
    add_box_minmax(bm, (1.096, 2.95, 1.95), (1.104, 2.953, 2.06), mat=2)
    add_box_minmax(bm, (1.1, 2.95, 1.946), (1.18, 2.953, 1.954), mat=2)
    static("clock", bm, [M["clock_face"], M["walnut"], M["dark"]], "kitchen")


# ---------------------------------------------------------------------------
# Lights (bake only) and ceiling fixtures


def build_lights(M, windows):
    sc = bpy.context.scene
    world = sc.world or bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.55, 0.72, 1.0, 1)
    bg.inputs["Strength"].default_value = 3.0

    def light(name, kind, loc, energy, color=(1, 1, 1), **kw):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        for k, v in kw.items():
            setattr(ld, k, v)
        o = bpy.data.objects.new(name, ld)
        LIGHTS.objects.link(o)
        o.location = loc
        return o

    # Afternoon sun through the south window.
    sun = light("sun", "SUN", (1.7, -6, 5), 5.0, (1.0, 0.93, 0.82), angle=math.radians(1.5))
    sun.rotation_euler = Vector((0.35, 0.8, -0.6)).to_track_quat("-Z", "Y").to_euler()
    # Window portals guide sky light in.
    for name, frame, (u0, u1, v0, v1) in windows:
        c = frame((u0 + u1) / 2, (v0 + v1) / 2, 0.19)
        inward = (frame(0, 0, -1) - frame(0, 0, 0)).normalized()
        p = light(f"portal_{name}", "AREA", c, 1.0, shape="RECTANGLE", size=u1 - u0, size_y=v1 - v0)
        p.data.cycles.is_portal = True
        p.rotation_euler = (-inward).to_track_quat("Z", "Y").to_euler()

    # Ceiling fixtures: a flush dome in the living room, a pendant over the table.
    bm = bmesh.new()
    add_lathe(bm, [(0, H - 0.12), (0.12, H - 0.11), (0.2, H - 0.06), (0.22, H), (0, H)], 32, center=(-2.2, 1.0, 0))
    static("ceiling_light", bm, [M["lampshade"]], "walls")
    light("lamp_living", "POINT", (-2.2, 1.0, H - 0.15), 120, (1.0, 0.82, 0.62), shadow_soft_size=0.15)
    bm = bmesh.new()
    add_cyl(bm, 0.004, H - 1.95, center=(1.8, -1.4, 1.95), segs=8, mat=1)
    add_lathe(bm, [(0.2, 0.0), (0.06, 0.16), (0.05, 0.16), (0.19, 0.0), (0.2, 0.0)], 32,
              center=(1.8, -1.4, 1.8), mat=1)
    add_sphere(bm, 0.05, center=(1.8, -1.4, 1.86), mat=0)
    static("pendant_light", bm, [M["lampshade"], M["dark"]], "kitchen")
    light("lamp_dining", "POINT", (1.8, -1.4, 1.84), 80, (1.0, 0.82, 0.62), shadow_soft_size=0.06)


# ---------------------------------------------------------------------------
# Props


def prop_materials():
    P = {}
    def p(key, color, rough=0.5, metal=0.0, alpha=1.0, name=None):
        P[key] = principled(name or f"prop_{key}", color, rough, metal, alpha)
    p("red", (0.75, 0.18, 0.15), 0.3)
    p("yellow", (0.9, 0.68, 0.2), 0.3)
    p("blue", (0.2, 0.4, 0.7), 0.3)
    p("white", (0.92, 0.9, 0.86), 0.25)
    p("cream", (0.9, 0.84, 0.7), 0.35)
    p("glass", (0.8, 0.92, 0.95), 0.05, 0.0, 0.3)
    p("green_glass", (0.1, 0.35, 0.15), 0.1, 0.0, 0.8)
    p("black", (0.03, 0.03, 0.035), 0.4)
    p("grey", (0.25, 0.26, 0.28), 0.5)
    p("screen", (0.02, 0.025, 0.04), 0.15)
    p("metal", (0.7, 0.72, 0.75), 0.35, 0.3)
    p("gold", (0.8, 0.62, 0.25), 0.35, 0.5)
    p("apple", (0.65, 0.06, 0.04), 0.35)
    p("stem", (0.3, 0.2, 0.1), 0.8)
    p("wax", (0.95, 0.9, 0.75), 0.6)
    p("terracotta", (0.7, 0.35, 0.2), 0.8)
    p("soil", (0.15, 0.1, 0.07), 1.0)
    p("leaf", (0.2, 0.5, 0.2), 0.6)
    p("wood", (0.55, 0.35, 0.2), 0.6)
    p("paper", (0.95, 0.94, 0.9), 0.9)
    p("cardboard", (0.65, 0.5, 0.32), 0.9)
    p("tape", (0.75, 0.62, 0.4), 0.4)
    p("egg", (0.92, 0.84, 0.7), 0.6)
    p("pink", (0.9, 0.45, 0.65), 0.6)
    p("photo_sky", (0.45, 0.65, 0.9), 0.4)
    p("photo_land", (0.35, 0.6, 0.3), 0.4)
    p("mustard", (0.8, 0.6, 0.2), 0.95)
    p("rust", (0.7, 0.35, 0.25), 0.95)
    p("yarn", (0.7, 0.1, 0.15), 0.95)
    p("beans", (0.25, 0.14, 0.08), 0.7)
    p("cereal", (0.95, 0.75, 0.15), 0.5)
    p("cereal_label", (0.8, 0.15, 0.1), 0.5)
    for k, c in enumerate([(0.7, 0.15, 0.15), (0.2, 0.35, 0.6), (0.2, 0.5, 0.3), (0.85, 0.65, 0.2),
                           (0.35, 0.2, 0.15), (0.45, 0.55, 0.6), (0.15, 0.3, 0.25)]):
        p(f"book{k}", c, 0.6)
    p("magazine", (0.85, 0.3, 0.35), 0.4)
    return P


def mug(bm):
    add_tube(bm, 0.045, 0.039, 0.1, bottom=0.008, segs=24)
    add_arc_tube(bm, 0.027, 0.007, -math.pi / 2, math.pi / 2, center=(0.044, 0, 0.05), plane="XZ")


def tumbler(bm):
    add_lathe(bm, [(0, 0), (0.033, 0), (0.037, 0.12), (0.034, 0.12), (0.031, 0.012), (0, 0.012)], 24)


def wine_glass(bm):
    add_lathe(bm, [(0, 0), (0.035, 0), (0.035, 0.004), (0.006, 0.008), (0.004, 0.08), (0.02, 0.1), (0.038, 0.13),
                   (0.04, 0.16), (0.036, 0.19), (0.033, 0.19), (0.037, 0.16), (0.035, 0.13), (0.018, 0.104),
                   (0, 0.1)], 24)


# Prop definitions: (name, location, rot_z, mass, grabbable, fragile, pieces,
# builder). A builder adds geometry to a bmesh (base at z = 0, front facing
# +Y) and returns the material list.
PROP_DEFS = []


def prop(name, loc, mass, build, rot=0.0, grab=False, fragile=False, pieces=7):
    PROP_DEFS.append((name, Vector(loc), rot, mass, grab, fragile, pieces, build))


def define_props():
    PROP_DEFS.clear()

    def single(fn, mat_key):
        def b(bm, P):
            fn(bm)
            return [P[mat_key]]
        return b

    # --- Coffee table (top 0.45)
    prop("mug_coffee_table", (-2.45, 1.3, 0.45), 0.35, single(mug, "red"), rot=0.6, grab=True, fragile=True)
    def remote(bm, P):
        add_box(bm, (0.05, 0.18, 0.02), (0, 0, 0.01), bevel=0.006, segs=2)
        for k in range(6):
            add_cyl(bm, 0.006, 0.004, center=(-0.012 + 0.024 * (k % 2), -0.03 + 0.025 * (k // 2), 0.019), segs=8, mat=1)
        add_cyl(bm, 0.008, 0.004, center=(0, 0.06, 0.019), segs=8, mat=2)
        return [P["black"], P["grey"], P["red"]]
    prop("remote", (-2.0, 1.05, 0.45), 0.15, remote, rot=0.4, grab=True)
    def magazine(bm, P):
        add_box(bm, (0.2, 0.27, 0.005), (0, 0, 0.0025), bevel=0.001)
        add_box(bm, (0.2, 0.27, 0.001), (0, 0, 0.0055), mat=1)
        return [P["paper"], P["magazine"]]
    prop("magazine", (-1.88, 1.32, 0.45), 0.2, magazine, rot=-0.2)
    prop("glass_coffee_table", (-2.62, 1.05, 0.45), 0.2, single(tumbler, "glass"), grab=True, fragile=True)
    def bowl(bm, P):
        add_lathe(bm, [(0, 0), (0.05, 0), (0.1, 0.04), (0.11, 0.06), (0.102, 0.06), (0.092, 0.042), (0.045, 0.008),
                       (0, 0.008)], 32)
        return [P["white"]]
    prop("fruit_bowl", (-2.25, 1.15, 0.45), 0.5, bowl, fragile=True, pieces=8)
    def apple(bm, P):
        add_sphere(bm, 0.04, center=(0, 0, 0.036), scale=(1, 1, 0.9), segs=16, rings=10)
        add_cyl(bm, 0.003, 0.015, center=(0, 0, 0.068), segs=6, mat=1)
        return [P["apple"], P["stem"]]
    prop("apple", (-2.45, 0.98, 0.45), 0.15, apple, grab=True)
    def candle(bm, P):
        add_lathe(bm, [(0, 0), (0.05, 0), (0.05, 0.008), (0.04, 0.012), (0, 0.012)], 24, mat=1)
        add_cyl(bm, 0.034, 0.11, center=(0, 0, 0.012), segs=20, mat=0)
        add_cyl(bm, 0.002, 0.012, center=(0, 0, 0.122), segs=6, mat=2)
        return [P["wax"], P["gold"], P["black"]]
    prop("candle", (-1.75, 1.05, 0.45), 0.25, candle, grab=True)

    # --- Side table (top 0.6)
    def lamp(bm, P):
        add_cyl(bm, 0.08, 0.03, segs=24, bevel=0.006)
        add_cyl(bm, 0.009, 0.4, center=(0, 0, 0.03), segs=10, mat=1)
        add_lathe(bm, [(0.14, 0.3), (0.08, 0.48), (0.074, 0.48), (0.134, 0.3), (0.14, 0.3)], 32, mat=2)
        return [P["wood"], P["metal"], P["cream"]]
    prop("lamp", (-3.6, 2.65, 0.6), 1.5, lamp)
    def phone(bm, P):
        add_box(bm, (0.07, 0.15, 0.008), (0, 0, 0.004), bevel=0.003, segs=2)
        add_box(bm, (0.062, 0.135, 0.001), (0, 0, 0.0085), mat=1)
        return [P["black"], P["screen"]]
    prop("phone", (-3.5, 2.45, 0.6), 0.18, phone, rot=0.3, grab=True)

    # --- TV stand (top 0.5). The TV faces into the room (+Y).
    def tv(bm, P):
        add_box(bm, (0.35, 0.2, 0.012), (0, 0, 0.006), bevel=0.003)
        add_box(bm, (0.08, 0.04, 0.07), (0, -0.01, 0.045))
        add_box(bm, (1.0, 0.05, 0.6), (0, -0.01, 0.38), bevel=0.008, segs=2)
        add_box(bm, (0.96, 0.002, 0.56), (0, 0.016, 0.38), mat=1)
        return [P["black"], P["screen"]]
    prop("tv", (-2.2, -2.82, 0.5), 6.0, tv, fragile=True, pieces=10)
    def controller(bm, P):
        add_box(bm, (0.1, 0.06, 0.028), (0, 0, 0.016), bevel=0.01, segs=2)
        for sx in (-1, 1):
            add_sphere(bm, 0.022, center=(sx * 0.05, -0.012, 0.016), scale=(1, 1.4, 0.7), segs=12, rings=8)
            add_cyl(bm, 0.008, 0.01, center=(sx * 0.022, -0.005, 0.028), segs=8, mat=1)
        return [P["grey"], P["black"]]
    prop("game_controller", (-1.6, -2.65, 0.5), 0.2, controller, rot=0.3, grab=True)
    def plant_pot(bm, P):
        add_lathe(bm, [(0, 0), (0.05, 0), (0.065, 0.12), (0.059, 0.12), (0, 0.11)], 24)
        add_cyl(bm, 0.058, 0.004, center=(0, 0, 0.108), segs=20, mat=1)
        for k in range(7):
            q = Euler((0.5 + 0.15 * (k % 3), 0, k * 0.9)).to_quaternion()
            add_sphere(bm, 0.02, center=Vector((0, 0, 0.11)) + q @ Vector((0, 0, 0.05)), scale=(0.7, 0.2, 2.6),
                       segs=8, rings=6, mat=2, rot=q)
        return [P["terracotta"], P["soil"], P["leaf"]]
    prop("plant_pot", (-2.85, -2.7, 0.5), 0.6, plant_pot, grab=True, fragile=True)
    def picture(bm, P):
        add_box(bm, (0.15, 0.018, 0.19), (0, 0, 0.095), bevel=0.003)
        add_box(bm, (0.12, 0.002, 0.08), (0, 0.009, 0.11), mat=1)
        add_box(bm, (0.12, 0.002, 0.07), (0, 0.009, 0.045), mat=2)
        add_box(bm, (0.03, 0.004, 0.12), (0, -0.04, 0.06), rot=Euler((0.4, 0, 0)))
        return [P["wood"], P["photo_sky"], P["photo_land"]]
    prop("picture_frame", (-1.55, -2.85, 0.5), 0.3, picture, grab=True, fragile=True, pieces=5)

    # --- Desk (top 0.75)
    def pencil_cup(bm, P):
        add_tube(bm, 0.038, 0.034, 0.1, bottom=0.006, segs=20)
        for k in range(4):
            q = Euler((0.12 * (1 if k % 2 else -1), 0.1 * (k - 1.5), 0)).to_quaternion()
            add_cyl(bm, 0.0035, 0.15, center=(0.01 * (k - 1.5), 0.008 * (k % 2), 0.006), segs=6, mat=1, rot=q)
        return [P["blue"], P["yellow"]]
    prop("pencil_cup", (-3.85, 0.15, 0.75), 0.2, pencil_cup, grab=True)
    def laptop(bm, P):
        add_box(bm, (0.32, 0.22, 0.014), (0, 0, 0.007), bevel=0.004, segs=2)
        add_box(bm, (0.28, 0.12, 0.001), (0, 0.02, 0.0145), mat=1)
        hinge = Vector((0, -0.11, 0.014))
        q = Euler((math.radians(-10), 0, 0)).to_quaternion()
        add_box(bm, (0.32, 0.007, 0.21), hinge + q @ Vector((0, -0.0035, 0.105)), bevel=0.003, rot=q)
        add_box(bm, (0.29, 0.001, 0.18), hinge + q @ Vector((0, 0.0005, 0.105)), mat=2, rot=q)
        return [P["metal"], P["black"], P["screen"]]
    prop("laptop", (-3.72, -0.25, 0.75), 1.4, laptop, rot=-math.pi / 2)
    prop("mug_desk", (-3.55, -0.7, 0.75), 0.35, single(mug, "yellow"), rot=2.2, grab=True, fragile=True)
    def papers(bm, P):
        for k in range(3):
            add_box(bm, (0.21, 0.297, 0.002), (0.004 * k, -0.003 * k, 0.001 + 0.002 * k), rot=Euler((0, 0, 0.05 * k)))
        return [P["paper"]]
    prop("papers", (-3.62, 0.08, 0.75), 0.2, papers, rot=0.15)
    prop("glass_desk", (-3.52, -0.5, 0.75), 0.2, single(tumbler, "glass"), grab=True, fragile=True)

    # --- Bookshelf (boards at 0.53 and 1.03, top 1.6). Books stand spine-out (+X).
    for i in range(6):
        board = 0.53 if i < 3 else 1.03
        y = -1.3 - (i % 3) * 0.05
        def book(bm, P, k=i):
            add_box(bm, (0.13, 0.03, 0.2), (0, 0, 0.1), bevel=0.002)
            add_box(bm, (0.002, 0.024, 0.03), (0.065, 0, 0.15), mat=1)
            return [P[f"book{k}"], P["paper"]]
        prop(f"book_{i}", (-3.82, y, board), 0.3, book, grab=True)
    def vase(bm, P):
        add_lathe(bm, [(0, 0), (0.05, 0), (0.07, 0.06), (0.075, 0.12), (0.05, 0.2), (0.04, 0.24), (0.045, 0.25),
                       (0.038, 0.25), (0.033, 0.24), (0.042, 0.2), (0.068, 0.12), (0.063, 0.06), (0.045, 0.012),
                       (0, 0.012)], 28)
        return [P["blue"]]
    prop("vase_shelf", (-3.82, -1.8, 1.6), 1.0, vase, fragile=True, pieces=8)
    def figurine(bm, P):
        add_sphere(bm, 0.03, center=(0, 0, 0.04), scale=(0.9, 0.8, 1.3), segs=14, rings=10)
        add_sphere(bm, 0.022, center=(0, 0.008, 0.095), segs=14, rings=10)
        for sx in (-1, 1):
            add_cyl(bm, 0.008, 0.018, center=(sx * 0.012, 0.006, 0.108), segs=4, r_top=0.0005,
                    rot=Euler((0, sx * 0.3, 0)))
        add_arc_tube(bm, 0.025, 0.005, -math.pi / 2, math.pi * 0.6, center=(0.0, -0.025, 0.03), plane="YZ",
                     steps=8, sides=6)
        return [P["yellow"]]
    prop("figurine", (-3.82, -1.88, 1.03), 0.2, figurine, rot=math.pi / 2, grab=True, fragile=True, pieces=5)

    # --- East counter (top 0.9)
    def plate(bm, P):
        add_lathe(bm, [(0, 0), (0.07, 0), (0.075, 0.003), (0.11, 0.013), (0.11, 0.016), (0.105, 0.016),
                       (0.07, 0.008), (0, 0.008)], 32)
        return [P["white"]]
    for i in range(3):
        prop(f"plate_{i}", (3.7, 2.45, 0.9 + i * 0.0165), 0.4, plate, fragile=True, pieces=6)
    prop("wine_glass", (3.55, 2.78, 0.9), 0.2, single(wine_glass, "glass"), grab=True, fragile=True, pieces=6)
    def bottle(bm, P):
        add_lathe(bm, [(0, 0), (0.04, 0), (0.04, 0.18), (0.035, 0.21), (0.014, 0.24), (0.014, 0.265), (0, 0.265)], 24)
        add_cyl(bm, 0.016, 0.015, center=(0, 0, 0.26), segs=16, mat=1)
        return [P["green_glass"], P["gold"]]
    prop("bottle", (3.85, 2.86, 0.9), 0.8, bottle, fragile=True)
    def toaster(bm, P):
        add_box(bm, (0.27, 0.16, 0.18), (0, 0, 0.1), bevel=0.035, segs=3)
        for sx in (-1, 1):
            add_box(bm, (0.2, 0.025, 0.004), (0, sx * 0.035, 0.19), mat=1)
        add_box(bm, (0.012, 0.03, 0.02), (0.14, 0, 0.12), mat=1)
        for sx in (-1, 1):
            for sy in (-1, 1):
                add_cyl(bm, 0.01, 0.01, center=(sx * 0.1, sy * 0.05, 0), segs=8, mat=1)
        return [P["red"], P["black"]]
    prop("toaster", (3.72, 1.2, 0.9), 1.5, toaster, rot=math.pi / 2)
    def cereal(bm, P):
        add_box(bm, (0.19, 0.07, 0.28), (0, 0, 0.14), bevel=0.002)
        add_box(bm, (0.15, 0.002, 0.12), (0, 0.035, 0.16), mat=1)
        return [P["cereal"], P["cereal_label"]]
    prop("cereal_box", (3.85, 0.6, 0.9), 0.4, cereal, rot=math.pi / 2)
    def shaker(bm, P):
        add_lathe(bm, [(0, 0), (0.02, 0), (0.021, 0.05), (0.017, 0.062), (0, 0.062)], 16)
        add_lathe(bm, [(0, 0.062), (0.017, 0.062), (0.017, 0.072), (0.01, 0.08), (0, 0.08)], 16, mat=1)
        return [P["glass"], P["metal"]]
    prop("salt_shaker", (3.55, 0.42, 0.9), 0.1, shaker, grab=True, fragile=True, pieces=5)
    def egg(bm, P):
        add_sphere(bm, 0.022, center=(0, 0, 0.0286), scale=(1, 1, 1.3), segs=14, rings=10)
        return [P["egg"]]
    prop("egg_0", (3.55, 1.45, 0.9), 0.06, egg, grab=True, fragile=True, pieces=5)
    prop("egg_1", (3.6, 1.38, 0.9), 0.06, egg, grab=True, fragile=True, pieces=5)

    # --- North counter (top 0.9)
    def jar(bm, P):
        add_tube(bm, 0.06, 0.056, 0.14, bottom=0.006, segs=24)
        add_cyl(bm, 0.062, 0.02, center=(0, 0, 0.14), segs=24, mat=1, bevel=0.004)
        add_cyl(bm, 0.054, 0.07, center=(0, 0, 0.006), segs=20, mat=2)
        return [P["glass"], P["wood"], P["beans"]]
    prop("jar", (1.85, 2.7, 0.9), 0.5, jar, grab=True, fragile=True)
    prop("mug_kitchen", (2.2, 2.6, 0.9), 0.35, single(mug, "blue"), rot=-0.8, grab=True, fragile=True)
    def board(bm, P):
        add_box(bm, (0.32, 0.2, 0.02), (0, 0, 0.01), bevel=0.006, segs=2)
        return [P["wood"]]
    prop("cutting_board", (3.15, 2.66, 0.9), 0.6, board, rot=0.15)

    # --- Fridge top (1.75)
    def cookie_jar(bm, P):
        add_lathe(bm, [(0, 0), (0.06, 0), (0.08, 0.04), (0.08, 0.12), (0.06, 0.15), (0, 0.15)], 28)
        add_sphere(bm, 0.016, center=(0, 0, 0.16), segs=10, rings=6, mat=1)
        return [P["cream"], P["wood"]]
    prop("cookie_jar", (3.5, -0.2, 1.75), 0.8, cookie_jar, fragile=True, pieces=8)
    def cardboard(bm, P):
        add_box(bm, (0.3, 0.25, 0.2), (0, 0, 0.1), bevel=0.004)
        add_box(bm, (0.3, 0.05, 0.002), (0, 0, 0.2005), mat=1)
        return [P["cardboard"], P["tape"]]
    prop("cardboard_box", (3.72, -0.5, 1.75), 0.3, cardboard, rot=0.1)

    # --- Dining table (top 0.75)
    def flower_vase(bm, P):
        add_lathe(bm, [(0, 0), (0.04, 0), (0.045, 0.03), (0.03, 0.11), (0.034, 0.13), (0.03, 0.13), (0.026, 0.11),
                       (0.04, 0.03), (0.036, 0.006), (0, 0.006)], 24)
        for k, (dx, dy, mat) in enumerate(((0.0, 0.0, 2), (0.02, 0.012, 3), (-0.018, -0.01, 2))):
            add_cyl(bm, 0.002, 0.07, center=(dx * 0.4, dy * 0.4, 0.1), segs=5, mat=1,
                    rot=Euler((dy * 4, -dx * 4, 0)))
            add_sphere(bm, 0.02, center=(dx * 1.6, dy * 1.6, 0.175), segs=10, rings=8, mat=mat)
        return [P["glass"], P["leaf"], P["pink"], P["yellow"]]
    prop("flower_vase", (1.8, -1.4, 0.75), 0.6, flower_vase, grab=True, fragile=True)
    prop("glass_dining_a", (1.45, -1.2, 0.75), 0.2, single(tumbler, "glass"), grab=True, fragile=True)
    prop("glass_dining_b", (2.15, -1.6, 0.75), 0.2, single(tumbler, "glass"), grab=True, fragile=True)
    prop("plate_dining", (1.5, -1.6, 0.75), 0.4, plate, fragile=True, pieces=6)
    def napkins(bm, P):
        add_box(bm, (0.12, 0.05, 0.006), (0, 0, 0.003), mat=0)
        for sy in (-1, 1):
            add_box(bm, (0.12, 0.004, 0.08), (0, sy * 0.023, 0.046), mat=0)
        add_box(bm, (0.11, 0.04, 0.07), (0, 0, 0.041), mat=1)
        return [P["metal"], P["paper"]]
    prop("napkin_holder", (2.05, -1.15, 0.75), 0.2, napkins, grab=True)

    # --- Extras: cushions on the sofa, yarn on the floor, a book on a chair.
    def cushion(mat):
        def b(bm, P):
            add_box(bm, (0.38, 0.38, 0.12), (0, 0, 0.06), bevel=0.05, segs=4)
            return [P[mat]]
        return b
    prop("cushion_a", (-2.72, 2.38, 0.45), 0.3, cushion("mustard"), rot=0.2)
    prop("cushion_b", (-1.7, 2.4, 0.45), 0.3, cushion("rust"), rot=-0.3)
    def yarn(bm, P):
        add_sphere(bm, 0.045, center=(0, 0, 0.045), segs=16, rings=10)
        add_arc_tube(bm, 0.06, 0.004, -0.2, 1.4, center=(0.05, 0, 0.004), plane="XY", steps=10, sides=6)
        return [P["yarn"]]
    prop("yarn_ball", (-1.0, 1.9, 0.0), 0.1, yarn, grab=True)
    def hardcover(bm, P):
        add_box(bm, (0.17, 0.24, 0.03), (0, 0, 0.015), bevel=0.002)
        add_box(bm, (0.002, 0.226, 0.024), (0.085, 0, 0.015), mat=1)
        return [P["book6"], P["paper"]]
    prop("book_chair", (1.82, -2.1, 0.45), 0.6, hardcover, rot=0.5)


def build_props(P):
    stats = {"props": 0, "pieces": 0, "fragile": 0}
    for i, (name, loc, rot_z, mass, grab, fragile, pieces, build) in enumerate(PROP_DEFS):
        bm = bmesh.new()
        mats = build(bm, P)
        obj = make_obj(name, bm, PROPC, mats, loc=loc, rot_z=rot_z)
        _rest_on_surface(obj, loc.z)
        set_prop(obj, mass, grab, fragile)
        stats["props"] += 1
        if fragile:
            stats["fragile"] += 1
            stats["pieces"] += add_pieces(obj, pieces, seed=1000 + i, coll=PROPC, coll_tmp=TMP)
    return stats


def remove_hidden_faces():
    """Deletes faces nobody can see (resting on the floor or flat against a
    wall) so they don't take up space in the bake atlases."""
    removed = 0
    walls = [(Vector((1, 0, 0)), X1), (Vector((-1, 0, 0)), -X0), (Vector((0, 1, 0)), Y1), (Vector((0, -1, 0)), -Y0)]
    for obj in STATIC.objects:
        if obj.name in ("floor", "ceiling") or obj.name.startswith(("wall_", "window_", "curtain", "door")):
            continue
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        dead = []
        for f in bm.faces:
            c, n = f.calc_center_median(), f.normal
            if n.z < -0.95 and c.z < 0.003:
                dead.append(f)
            elif any(n.dot(d) > 0.95 and c.dot(d) > dist - 0.03 for d, dist in walls):
                dead.append(f)
        if dead:
            bmesh.ops.delete(bm, geom=dead, context="FACES")
            removed += len(dead)
            bm.to_mesh(obj.data)
        bm.free()
    return removed


def build_all():
    setup()
    M = static_materials()
    windows = build_shell(M)
    build_living(M)
    build_kitchen(M)
    remove_hidden_faces()
    build_lights(M, windows)
    spawn = empty(MARKERS, "spawn", (0.0, 0.0, 0.05), "SINGLE_ARROW", 0.3)
    define_props()
    stats = build_props(prop_materials())
    bpy.data.collections.remove(TMP)
    return stats


if __name__ == "__main__":
    print(build_all())
