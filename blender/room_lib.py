# Helpers for building the room in Blender: collections, materials, simple
# mesh builders, colliders, props and Voronoi fracture. Loaded by
# room_build.py; run inside Blender.
#
# Conventions (see docs/blender-guide.md): 1 unit = 1 m, Z up. The game's
# forward (-Z in three.js) is Blender +Y.
import bpy
import bmesh
import math
import random
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Collections


def get_coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def clear_coll(c):
    """Delete every object (and its now-unused data) in a collection tree."""
    for ch in list(c.children):
        clear_coll(ch)
        bpy.data.collections.remove(ch)
    for o in list(c.objects):
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)


# ---------------------------------------------------------------------------
# Materials


def _reset_nodes(m):
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return nt, bsdf


def principled(name, color, rough=0.6, metal=0.0, alpha=1.0, emit=None, emit_strength=0.0):
    """Flat-colored Principled BSDF material (what props use, and what exports)."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, bsdf = _reset_nodes(m)
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Alpha"].default_value = alpha
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = (*color, alpha)
    if alpha < 1:
        m.surface_render_method = "BLENDED"
    return m


def textured(name, color, rough=0.7, build=None):
    """Material for baked furniture: Principled BSDF whose base color may be
    driven by procedural textures. Only used as the bake source; the
    exported room uses the baked atlas instead."""
    m = principled(name, color, rough)
    if build:
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        coord = nt.nodes.new("ShaderNodeTexCoord")
        build(nt, bsdf, coord.outputs["Object"])
    return m


def _mix_color(nt, fac, a, b):
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(fac, mix.inputs["Factor"])
    mix.inputs["A"].default_value = (*a, 1)
    mix.inputs["B"].default_value = (*b, 1)
    return mix.outputs["Result"]


def grain(a, b, scale=6.0, stretch=(1, 1, 1)):
    """Wood-like streaks between colors a and b."""
    def build(nt, bsdf, co):
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = stretch
        nt.links.new(co, mapping.inputs["Vector"])
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.inputs["Scale"].default_value = scale
        wave.inputs["Distortion"].default_value = 6.0
        wave.inputs["Detail"].default_value = 2.0
        nt.links.new(mapping.outputs[0], wave.inputs["Vector"])
        nt.links.new(_mix_color(nt, wave.outputs["Fac"], a, b), bsdf.inputs["Base Color"])
    return build


def speckle(a, b, scale=40.0):
    """Subtle noise between colors a and b (fabric, stone, plaster)."""
    def build(nt, bsdf, co):
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = scale
        noise.inputs["Detail"].default_value = 4.0
        nt.links.new(co, noise.inputs["Vector"])
        nt.links.new(_mix_color(nt, noise.outputs["Fac"], a, b), bsdf.inputs["Base Color"])
    return build


def bricks(c1, c2, mortar, brick_w, brick_h, mortar_size, offset=0.5, axes="XY"):
    """Planks or tiles. `axes` picks the two object axes the pattern lies in."""
    def build(nt, bsdf, co):
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        nt.links.new(co, sep.inputs[0])
        nt.links.new(sep.outputs[axes[0]], comb.inputs["X"])
        nt.links.new(sep.outputs[axes[1]], comb.inputs["Y"])
        b = nt.nodes.new("ShaderNodeTexBrick")
        b.offset = offset
        b.inputs["Color1"].default_value = (*c1, 1)
        b.inputs["Color2"].default_value = (*c2, 1)
        b.inputs["Mortar"].default_value = (*mortar, 1)
        b.inputs["Scale"].default_value = 1.0
        b.inputs["Brick Width"].default_value = brick_w
        b.inputs["Row Height"].default_value = brick_h
        b.inputs["Mortar Size"].default_value = mortar_size
        b.inputs["Bias"].default_value = 0.0
        nt.links.new(comb.outputs[0], b.inputs["Vector"])
        nt.links.new(b.outputs["Color"], bsdf.inputs["Base Color"])
    return build


# ---------------------------------------------------------------------------
# Mesh building (bmesh). Every add_* appends to `bm` with material index `mat`.


def merge(dst, src):
    me = bpy.data.meshes.new("_merge_tmp")
    src.to_mesh(me)
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


def _place(tmp, center=(0, 0, 0), rot=None, mat=0):
    m = Matrix.Translation(Vector(center))
    if rot is not None:
        m = m @ rot.to_matrix().to_4x4()
    bmesh.ops.transform(tmp, matrix=m, verts=tmp.verts)
    for f in tmp.faces:
        f.material_index = mat


def add_box(bm, size, center=(0, 0, 0), bevel=0.0, segs=1, mat=0, rot=None):
    """Box of `size` (x, y, z) centered at `center`, optionally rotated
    (a mathutils Euler/Quaternion) and with bevelled edges."""
    tmp = bmesh.new()
    bmesh.ops.create_cube(tmp, size=1.0)
    bmesh.ops.scale(tmp, vec=Vector(size), verts=tmp.verts)
    if bevel > 0:
        bevel = min(bevel, min(size) * 0.49)
        bmesh.ops.bevel(tmp, geom=tmp.edges[:], offset=bevel, segments=segs, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    _place(tmp, center, rot, mat)
    merge(bm, tmp)
    tmp.free()


def add_box_minmax(bm, lo, hi, **kw):
    lo, hi = Vector(lo), Vector(hi)
    add_box(bm, hi - lo, (lo + hi) / 2, **kw)


def add_lathe(bm, profile, segs=24, center=(0, 0, 0), mat=0, rot=None):
    """Solid of revolution around local Z. `profile` is a list of (radius, z)
    points; start and end it on the axis (radius 0) for a closed solid."""
    tmp = bmesh.new()
    vs = [tmp.verts.new((r, 0, z)) for r, z in profile]
    es = [tmp.edges.new((vs[i], vs[i + 1])) for i in range(len(vs) - 1)]
    bmesh.ops.spin(tmp, geom=vs + es, cent=(0, 0, 0), axis=(0, 0, 1),
                   angle=2 * math.pi, steps=segs, use_merge=True)
    bmesh.ops.remove_doubles(tmp, verts=tmp.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    _place(tmp, center, rot, mat)
    merge(bm, tmp)
    tmp.free()


def add_cyl(bm, r, h, center=(0, 0, 0), segs=24, mat=0, r_top=None, rot=None, bevel=0.0):
    """Cylinder (or frustum) with its base at `center`."""
    rt = r if r_top is None else r_top
    if bevel > 0:
        b = min(bevel, r * 0.3, h * 0.3)
        prof = [(0, 0), (r - b, 0), (r, b), (rt, h - b), (rt - b, h), (0, h)]
    else:
        prof = [(0, 0), (r, 0), (rt, h), (0, h)]
    add_lathe(bm, prof, segs, center, mat, rot)


def add_tube(bm, r_out, r_in, h, center=(0, 0, 0), segs=24, mat=0, rot=None, bottom=0.0):
    """Hollow cylinder; `bottom` > 0 closes it with a floor that thick."""
    if bottom > 0:
        prof = [(0, 0), (r_out, 0), (r_out, h), (r_in, h), (r_in, bottom), (0, bottom)]
    else:
        prof = [(r_in, 0), (r_out, 0), (r_out, h), (r_in, h), (r_in, 0)]
    add_lathe(bm, prof, segs, center, mat, rot)


def add_sphere(bm, r, center=(0, 0, 0), scale=(1, 1, 1), segs=16, rings=10, mat=0, rot=None):
    tmp = bmesh.new()
    bmesh.ops.create_uvsphere(tmp, u_segments=segs, v_segments=rings, radius=r)
    bmesh.ops.scale(tmp, vec=Vector(scale), verts=tmp.verts)
    _place(tmp, center, rot, mat)
    merge(bm, tmp)
    tmp.free()


def add_arc_tube(bm, radius, thickness, a0, a1, center=(0, 0, 0), plane="XZ", steps=10, sides=8, mat=0):
    """A bent rod (e.g. a mug handle): an arc of `radius` from angle a0 to a1
    in the given plane, with a round cross-section of radius `thickness`."""
    tmp = bmesh.new()
    rings = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        c = Vector((math.cos(a) * radius, 0, math.sin(a) * radius))
        t = Vector((-math.sin(a), 0, math.cos(a)))  # tangent
        n = c.normalized() if c.length > 0 else Vector((1, 0, 0))
        b = t.cross(n).normalized()
        ring = []
        for k in range(sides):
            phi = 2 * math.pi * k / sides
            ring.append(tmp.verts.new(c + (n * math.cos(phi) + b * math.sin(phi)) * thickness))
        rings.append(ring)
    for i in range(steps):
        for k in range(sides):
            k2 = (k + 1) % sides
            tmp.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    tmp.faces.new(rings[0][::-1])
    tmp.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    if plane == "YZ":
        bmesh.ops.rotate(tmp, verts=tmp.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "Z"))
    elif plane == "XY":
        bmesh.ops.rotate(tmp, verts=tmp.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "X"))
    _place(tmp, center, None, mat)
    merge(bm, tmp)
    tmp.free()


def make_obj(name, bm, coll, mats, smooth=True, sharp_angle=35.0, loc=(0, 0, 0), rot_z=0.0, parent=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (0, 0, rot_z)
    if parent:
        obj.parent = parent
    if smooth:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    else:
        me.shade_flat()
    return obj


# ---------------------------------------------------------------------------
# Colliders and markers


def collider(coll, name, lo, hi, rot_z=0.0, pivot=None):
    """Invisible convex box collider from min/max corners (world space).
    Named `<name>-col`; hidden from renders so it never shows up in bakes."""
    bm = bmesh.new()
    lo, hi = Vector(lo), Vector(hi)
    add_box(bm, hi - lo, (lo + hi) / 2)
    if rot_z:
        p = Vector(pivot) if pivot else (lo + hi) / 2
        bmesh.ops.rotate(bm, verts=bm.verts, cent=p, matrix=Matrix.Rotation(rot_z, 3, "Z"))
    obj = make_obj(f"{name}-col", bm, coll, [], smooth=False)
    obj.display_type = "WIRE"
    obj.hide_render = True
    return obj


def empty(coll, name, loc, display="PLAIN_AXES", size=0.2):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = display
    e.empty_display_size = size
    e.location = loc
    coll.objects.link(e)
    return e


# ---------------------------------------------------------------------------
# Props


def set_prop(obj, mass, grabbable=False, fragile=False):
    """Mark an object as a knockable physics prop (object custom properties)."""
    obj["knockable"] = True
    obj["mass"] = float(mass)
    if grabbable:
        obj["grabbable"] = True
    if fragile:
        obj["fragile"] = True


def _rest_on_surface(obj, surface_z):
    """Move a prop so its lowest vertex sits on `surface_z` (+1 mm)."""
    bpy.context.view_layer.update()
    zs = [(obj.matrix_world @ v.co).z for v in obj.data.vertices]
    obj.location.z += surface_z - min(zs) + 0.001


# ---------------------------------------------------------------------------
# Voronoi fracture (the same idea as the Cell Fracture add-on): scatter seed
# points in the object's bounds, build each seed's Voronoi cell as a convex
# box cut by the bisector planes to every other seed, and intersect the cell
# with the object.


def _voronoi_cell(lo, hi, seeds, i):
    cell = bmesh.new()
    add_box(cell, hi - lo, (lo + hi) / 2)
    p = seeds[i]
    for j, q in enumerate(seeds):
        if i == j:
            continue
        mid = (p + q) / 2
        n = (q - p).normalized()
        geom = cell.verts[:] + cell.edges[:] + cell.faces[:]
        res = bmesh.ops.bisect_plane(cell, geom=geom, dist=1e-7, plane_co=mid, plane_no=n,
                                     clear_outer=True, clear_inner=False)
        cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut:
            bmesh.ops.contextual_create(cell, geom=cut)
        if len(cell.faces) < 4:
            cell.free()
            return None
    bmesh.ops.recalc_face_normals(cell, faces=cell.faces)
    return cell


def fracture(obj, count, seed, coll_tmp):
    """Cuts `obj` into about `count` pieces. Returns new mesh datablocks in
    the object's local space (the caller makes objects of them)."""
    rng = random.Random(seed)
    me = obj.data
    xs = [v.co for v in me.vertices]
    lo = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
    hi = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
    size = hi - lo
    pad = size * 0.02 + Vector((0.001, 0.001, 0.001))
    lo, hi = lo - pad, hi + pad

    # Spread the seeds out a little so pieces are similar in size.
    seeds = []
    min_d = (size.x * size.y * size.z / count) ** (1 / 3) * 0.5
    tries = 0
    while len(seeds) < count and tries < 2000:
        tries += 1
        p = Vector(rng.uniform(lo[k], hi[k]) for k in range(3))
        if all((p - s).length >= min_d for s in seeds) or tries > 1500:
            seeds.append(p)

    mat0 = me.materials[0] if len(me.materials) else None
    pieces = []
    src = bpy.data.objects.new("_frac_src", me.copy())
    coll_tmp.objects.link(src)
    for i in range(len(seeds)):
        cell = _voronoi_cell(lo, hi, seeds, i)
        if cell is None:
            continue
        cme = bpy.data.meshes.new("_frac_cell")
        cell.to_mesh(cme)
        cell.free()
        if mat0:
            cme.materials.append(mat0)
        cobj = bpy.data.objects.new("_frac_cell", cme)
        coll_tmp.objects.link(cobj)
        mod = src.modifiers.new("cut", "BOOLEAN")
        mod.operation = "INTERSECT"
        mod.solver = "EXACT"
        mod.use_self = True
        mod.material_mode = "TRANSFER"
        mod.object = cobj
        dg = bpy.context.evaluated_depsgraph_get()
        result = bpy.data.meshes.new_from_object(src.evaluated_get(dg))
        src.modifiers.remove(mod)
        bpy.data.objects.remove(cobj)
        bpy.data.meshes.remove(cme)
        if len(result.polygons) >= 4:
            pieces.append(result)
        else:
            bpy.data.meshes.remove(result)
    srcme = src.data
    bpy.data.objects.remove(src)
    bpy.data.meshes.remove(srcme)
    return pieces


def add_pieces(prop, count, seed, coll, coll_tmp):
    """Pre-cut pieces for a fragile prop: a hidden child empty named
    `pieces_<prop>` holding the fracture pieces, in place over the prop."""
    meshes = fracture(prop, count, seed, coll_tmp)
    holder = bpy.data.objects.new(f"pieces_{prop.name}", None)
    holder.empty_display_size = 0.05
    coll.objects.link(holder)
    holder.parent = prop
    for k, me in enumerate(meshes):
        me.name = f"{prop.name}_piece_{k:02d}"
        c = sum((v.co for v in me.vertices), Vector()) / max(1, len(me.vertices))
        me.transform(Matrix.Translation(-c))
        piece = bpy.data.objects.new(me.name, me)
        coll.objects.link(piece)
        piece.parent = holder
        piece.location = c
        piece.hide_render = True
        piece.hide_set(True)
    holder.hide_render = True
    holder.hide_set(True)
    return len(meshes)
