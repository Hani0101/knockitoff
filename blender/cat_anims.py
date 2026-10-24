# Rough cat animations, authored on the Rigify controls and baked onto the
# export skeleton (see cat_rig_build.py). Run inside Blender.
#
# Each animation is first keyed on the Rigify rig as "<name>__ctrl", then
# baked (visual keying, so IK and constraints are included) onto "cat_rig"
# as "<name>", which is what gets exported. Re-running replaces both.
#
# Conventions: the cat faces +Y, its left is -X, Z is up, units are meters.
# Poses are written as world-space offsets from the rest pose:
#   bone -> (translation, rotation about the bone's own head)
# All animations stay in place; the game moves the cat.
import bpy
import math
from mathutils import Quaternion, Vector

RIGIFY_RIG = "rig"
EXPORT_RIG = "cat_rig"
# Frame numbers below are in 24 fps frames, but clips are keyed and baked
# SAMPLES times per frame. The game blends straight lines between baked
# samples, and at 24 fps a fast paw swing gets so few that its arc turns
# into a polygon.
FPS = 24
SAMPLES = 2

# Every control that any animation touches. Each key sets all of them, so
# one action never inherits a leftover pose from another.
CONTROLS = [
    "torso", "hips", "chest", "neck", "head", "shoulder.L", "shoulder.R",
    "foot_ik.L", "foot_ik.R", "hand_ik.L", "hand_ik.R",
    "tail.001", "tail.002", "tail.003", "tail.004",
]

ZERO = Vector((0, 0, 0))


def rx(deg):
    return Quaternion((1, 0, 0), math.radians(deg))


def ry(deg):
    return Quaternion((0, 1, 0), math.radians(deg))


def rz(deg):
    return Quaternion((0, 0, 1), math.radians(deg))


def rest_head(name):
    return bpy.data.objects[RIGIFY_RIG].pose.bones[name].bone.head_local.copy()


def body(rot=None, pivot=None, offset=(0, 0, 0)):
    """Torso transform: rotate the whole body about `pivot` (default: the
    torso control's head, at the hips), then move it by `offset`."""
    rot = rot or Quaternion()
    h = rest_head("torso")
    pivot = Vector(pivot) if pivot else h
    loc = Vector(offset) + (pivot + rot @ (h - pivot)) - h
    return ("torso", (loc, rot))


def paw(name, target=None, offset=(0, 0, 0), rot=None):
    """IK paw control. `target` is an absolute position for the paw tip;
    otherwise `offset` is relative to the rest position."""
    loc = (Vector(target) - rest_head(name)) if target else Vector(offset)
    return (name, (loc, rot or Quaternion()))


def rot(name, q):
    return (name, (ZERO.copy(), q))


def pose(*items):
    return dict(items)


def mix(a, b, t):
    """Blend two poses (t=0 gives a, t=1 gives b)."""
    out = {}
    for n in set(a) | set(b):
        la, qa = a.get(n, (ZERO, Quaternion()))
        lb, qb = b.get(n, (ZERO, Quaternion()))
        out[n] = (la.lerp(lb, t), qa.slerp(qb, t))
    return out


def tail(*degs):
    """Tail curl, one pitch per segment, base first. Negative raises."""
    return [rot(f"tail.00{i + 1}", rx(d)) for i, d in enumerate(degs)]


# Paw swing as a cubic Bezier in (forward, up), in units of reach and lift
# height. The paw peels up and back off the ground, lifts highest early,
# reaches a little past its landing spot and settles back onto it, so the
# path is a teardrop-shaped arc and the paw is still moving backwards (with
# the ground) when it lands and when it lifts.
SWING = [(-1.0, 0.0), (-1.3, 1.6), (1.25, 1.0), (1.0, 0.0)]


def bezier(pts, t):
    u = 1 - t
    w = (u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t)
    return tuple(sum(wi * p[k] for wi, p in zip(w, pts)) for k in range(2))


SWING_PEAK = max(bezier(SWING, i / 200)[1] for i in range(201))


def gait_foot(p, duty, reach, height):
    """Paw path over one cycle: planted and sliding back for `duty` of the
    cycle, then swung forward along SWING. Returns (dy, dz, lift), where
    lift goes 0 -> 1 -> 0 over the swing (for curling the paw)."""
    p %= 1.0
    if p < duty:
        s = p / duty
        return reach - 2 * reach * s, 0.0, 0.0
    s = (p - duty) / (1 - duty)
    y, z = bezier(SWING, s)
    return reach * y, height * z / SWING_PEAK, math.sin(math.pi * s)


def spine_flex(spread, curl_per_m, stretch_per_m):
    """Degrees to bend the back from the stride: paws gathered under her
    (front paws behind their rest spot, hind paws ahead, so `spread` < 0)
    curl the back up; a long stride (`spread` > 0) stretches it flat.
    Positive means curled."""
    return -spread * (curl_per_m if spread < 0 else stretch_per_m)


def back(curl, hips=None, chest=None):
    """Bend the back by `curl` degrees on both halves (hips and chest
    pivot at mid-back), on top of extra hips/chest rotations."""
    return [
        rot("hips", (hips or Quaternion()) @ rx(curl)),
        rot("chest", (chest or Quaternion()) @ rx(-curl)),
    ]


# ---------------------------------------------------------------------------
# Shared poses

def standing():
    return pose(*tail(-15, 5, 10, 10))


# Sitting up on the haunches: hips low, hind feet folded flat under her,
# body leaning back about 55 degrees, both front paws around the held item,
# which the game places 0.32 m up and 0.2 m in front of the feet
# (tuning.holdHeight / holdForward in src/config.ts).
SIT_PITCH = 55
SIT_OFFSET = Vector((0, -0.01, -0.145))
ITEM = Vector((0, 0.2, 0.32))


def sitting(pitch=0, shift=(0, 0, 0), item=ITEM, spread=0.035, paw_l=(0, 0, 0), paw_r=(0, 0, 0), look=-35):
    """`pitch` and `shift` adjust the body relative to the sitting pose;
    `paw_l` / `paw_r` move each front paw relative to the item."""
    il = item + Vector((-spread, 0, 0)) + Vector(paw_l)
    ir = item + Vector((spread, 0, 0)) + Vector(paw_r)
    return pose(
        body(rx(SIT_PITCH + pitch), offset=SIT_OFFSET + Vector(shift)),
        paw("hand_ik.L", target=il, rot=rx(-30)),
        paw("hand_ik.R", target=ir, rot=rx(-30)),
        # Toes forward, hock on the floor behind them.
        paw("foot_ik.L", offset=(0, 0.07, 0.012), rot=rx(62)),
        paw("foot_ik.R", offset=(0, 0.07, 0.012), rot=rx(62)),
        # Look at the item rather than up with the body.
        rot("neck", rx(-15)),
        rot("head", rx(look)),
        # Tail resting along the floor behind her, tip curling up a little.
        *tail(-25, 3, -5, -10),
    )


# ---------------------------------------------------------------------------
# Looping animations: functions of the cycle phase p in [0, 1].

def idle(p):
    s = math.sin(2 * math.pi * p)
    pz = standing()
    pz.update(pose(
        body(rx(0.6 * s), offset=(0, 0, 0.002 * s)),
        rot("chest", rx(1.0 * s)),
    ))
    return pz


def stride(p, duty, reach, phases, heights, curl, inward=None, shift=None):
    """Paw poses for one gait, front paws curling as they swing. Returns
    the poses, the stride's spread (how far the front paws are ahead of the
    hind paws compared to standing, meters) and each paw's (dy, lift).
    `inward` moves a paw toward the midline (meters; it swings out a little
    around the planted leg), `shift` moves its whole stride forward."""
    items, front, hind, paws = [], [], [], {}
    inward, shift = inward or {}, shift or {}
    for n, ph in phases.items():
        dy, dz, lift = gait_foot(p - ph, duty, reach, heights[n])
        dy += shift.get(n, 0.0)
        side = -1 if n.endswith(".L") else 1  # the cat's left is -X
        dx = -side * inward.get(n, 0.0) * (1 - 0.5 * lift)
        is_front = n.startswith("hand")
        items.append(paw(n, offset=(dx, dy, dz), rot=rx(-curl * lift) if is_front else None))
        (front if is_front else hind).append(dy)
        paws[n] = (dy, lift)
    return items, sum(front) / len(front) - sum(hind) / len(hind), paws


def stance(p, phase, duty):
    """0 -> 1 -> 0 over a paw's time on the ground, else 0."""
    s = ((p - phase) % 1.0) / duty
    return math.sin(math.pi * s) if s < 1 else 0.0


# The walk, from cat gait studies and reference:
# - A lateral-sequence walk: hind L, front L, hind R, front R, a quarter
#   cycle apart. Each paw is down 62% of the time (walks are above 50%;
#   below that it's a run), so two or three paws always hold her up.
# - Animated for 0.81 m/s (the game's walkSpeed is close to it). Cats walk
#   at about 0.4-1 m/s and trot beyond that.
# - Direct register: each hind paw lands close to where the front paw on
#   that side just lifted, so the reach is short and the hind stride sits a
#   little back. The paws land close to a single line under her.
# - The shoulder blades roll with the front legs and rise as each one takes
#   the weight. Hips and shoulders roll toward the lifted leg. The head stays
#   level and pointed ahead while the body sways under it.
WALK_DUTY = 0.62
WALK_REACH = 0.115


def walk(p):
    phases = {"foot_ik.L": 0.0, "hand_ik.L": 0.25, "foot_ik.R": 0.5, "hand_ik.R": 0.75}
    heights = {"foot_ik.L": 0.03, "foot_ik.R": 0.03, "hand_ik.L": 0.035, "hand_ik.R": 0.035}
    inward = {"foot_ik.L": 0.018, "foot_ik.R": 0.018, "hand_ik.L": 0.012, "hand_ik.R": 0.012}
    shift = {"foot_ik.L": -0.03, "foot_ik.R": -0.03}
    items, spread, paws = stride(p, WALK_DUTY, WALK_REACH, phases, heights, curl=35, inward=inward, shift=shift)

    # Bend sideways toward the side whose paws are closer together.
    side_l = paws["hand_ik.L"][0] - paws["foot_ik.L"][0]
    side_r = paws["hand_ik.R"][0] - paws["foot_ik.R"][0]
    bend = 22 * (side_l - side_r)
    # Roll toward the leg in the air (positive ry lifts her left side).
    hip_roll = -3 * (paws["foot_ik.L"][1] - paws["foot_ik.R"][1])
    chest_roll = -2 * (paws["hand_ik.L"][1] - paws["hand_ik.R"][1])
    # Weight over the planted hind leg.
    sway = 0.004 * (paws["foot_ik.R"][1] - paws["foot_ik.L"][1])

    # One bounce per step of the hind legs: lowest just after a hind paw
    # lands and takes the weight, highest as the body vaults over it.
    bob = -0.008 - 0.004 * math.cos(4 * math.pi * (p - 0.03))
    # The shoulders do the same over the front paws, a quarter cycle later.
    pitch = 1.0 * math.cos(4 * math.pi * (p - 0.475))

    # Shoulder blades: swing forward with the paw, back as it pushes (the
    # rotation is about the top of the blade, so +rx moves the leg's root
    # forward), and ride up while that leg carries her.
    blades = []
    for side, ph in (("L", 0.25), ("R", 0.75)):
        dy = paws[f"hand_ik.{side}"][0]
        lift_up = 0.006 * stance(p, ph, WALK_DUTY)
        blades.append((f"shoulder.{side}", (Vector((0, 0, lift_up)), rx(9 * dy / WALK_REACH))))

    items += [
        body(rx(pitch), offset=(sway, 0, bob)),
        *back(spine_flex(spread, 25, 20), hips=rz(bend) @ ry(hip_roll), chest=rz(-bend) @ ry(chest_roll)),
        *blades,
        # The head control keeps its own heading as the chest sways (Rigify's
        # head follow is off); just undo the pitch so her gaze stays level.
        rot("head", rx(-pitch)),
        *tail(-30, 10, 15, 10),
    ]
    return pose(*items)


def run(p):
    # A bound: hind paws land at 0 and 0.08, front paws at 0.5 and 0.58.
    # The paws are gathered under her around 0 and spread out around 0.5.
    phases = {"foot_ik.R": 0.0, "foot_ik.L": 0.08, "hand_ik.R": 0.5, "hand_ik.L": 0.58}
    heights = dict.fromkeys(phases, 0.07)
    items, spread, _ = stride(p, 0.35, 0.15, phases, heights, curl=45)
    # Rear low while the hind legs push, front low while the front legs
    # land. Highest in the two moments with no paw down (around 0.46 and
    # 0.96), and more so in the gathered one.
    pitch = -2 + 5 * math.sin(2 * math.pi * (p + 0.05))
    bob = -0.005 + 0.012 * math.cos(4 * math.pi * (p - 0.46)) + 0.006 * math.cos(2 * math.pi * (p - 0.96))
    items += [
        body(rx(pitch), offset=(0, 0, bob)),
        *back(spine_flex(spread, 50, 36)),
        # Keep the head steady while the body rocks.
        rot("head", rx(-pitch)),
        *tail(5, 0, 5, 5),
    ]
    return pose(*items)


def pounce(p):
    """Getting ready to leap onto something: low and gathered, hind paws
    drawn in under her with the weight on them, chest a little up, back
    curled, and the rear swaying side to side (the wiggle) while the front
    stays still. The tail lies low with the tip flicking. The game aims the
    head at the target and holds this until the leap, which starts from the
    jump clip's crouch."""
    s = math.sin(2 * math.pi * p)
    return pose(
        body(rx(6), offset=(0, -0.015, -0.06)),
        *back(8, hips=rz(6 * s) @ ry(-3 * s)),
        paw("foot_ik.L", offset=(0, 0.05, 0)),
        paw("foot_ik.R", offset=(0, 0.05, 0)),
        paw("hand_ik.L", offset=(0, -0.01, 0)),
        paw("hand_ik.R", offset=(0, -0.01, 0)),
        *tail(10, 5, 0, -10 + 15 * math.sin(4 * math.pi * p)),
    )


def hold(p):
    s = math.sin(2 * math.pi * p)
    return sitting(shift=(0, 0, 0.003 * s), item=ITEM + Vector((0, 0, 0.003 * s)))


# ---------------------------------------------------------------------------
# One-shot animations: (frame, pose) keys.

def jump_keys():
    crouch = pose(body(rx(-4), offset=(0, -0.01, -0.05)), *tail(-10, 5, 5, 5))
    launch = pose(
        body(rx(15), offset=(0, 0.01, 0.03)),
        paw("hand_ik.L", offset=(0, 0.04, 0.1)), paw("hand_ik.R", offset=(0, 0.04, 0.1)),
        paw("foot_ik.L", offset=(0, -0.06, 0.02)), paw("foot_ik.R", offset=(0, -0.06, 0.02)),
        *tail(5, 0, 0, 0),
    )
    air = pose(
        body(rx(5)),
        paw("hand_ik.L", offset=(0, 0.08, 0.09)), paw("hand_ik.R", offset=(0, 0.08, 0.09)),
        paw("foot_ik.L", offset=(0, 0.03, 0.09)), paw("foot_ik.R", offset=(0, 0.03, 0.09)),
        *tail(-10, 5, 5, 5),
    )
    return [(0, standing()), (3, crouch), (6, launch), (10, air)]


def descend_keys():
    """Getting down from a table or shelf. She stands at the brink, lowers
    her front and reaches one front paw, then both, over and down the edge,
    tail up for balance (frames 0-8, which matches the game's
    tuning.descendWindup of 0.35 s), pushes off with the hind legs (10) and
    drops front paws first with the hind legs trailing (13, held until she
    lands). The game aims the head at the landing spot."""
    reach = pose(
        body(rx(-12), offset=(0, 0.02, -0.03)),
        paw("hand_ik.L", offset=(0, 0.07, -0.06)),
        paw("hand_ik.R", offset=(0, 0.04, -0.02)),
        paw("foot_ik.L", offset=(0, 0.02, 0)),
        paw("foot_ik.R", offset=(0, 0.02, 0)),
        rot("head", rx(-20)),
        *tail(-35, 10, 10, 10),
    )
    deeper = pose(
        body(rx(-15), offset=(0, 0.025, -0.04)),
        paw("hand_ik.L", offset=(0, 0.08, -0.08)),
        paw("hand_ik.R", offset=(0, 0.07, -0.06)),
        paw("foot_ik.L", offset=(0, 0.03, 0)),
        paw("foot_ik.R", offset=(0, 0.03, 0)),
        rot("head", rx(-25)),
        *tail(-40, 10, 10, 10),
    )
    push = pose(
        body(rx(-15), offset=(0, 0.03, -0.01)),
        paw("hand_ik.L", offset=(0, 0.08, -0.06)),
        paw("hand_ik.R", offset=(0, 0.07, -0.05)),
        paw("foot_ik.L", offset=(0, -0.03, 0)),
        paw("foot_ik.R", offset=(0, -0.03, 0)),
        rot("head", rx(-20)),
        *tail(-40, 10, 5, 5),
    )
    air = pose(
        body(rx(-20), offset=(0, 0.02, 0)),
        paw("hand_ik.L", offset=(0, 0.08, -0.07)),
        paw("hand_ik.R", offset=(0, 0.08, -0.07)),
        paw("foot_ik.L", offset=(0, -0.05, 0.05)),
        paw("foot_ik.R", offset=(0, -0.05, 0.05)),
        rot("head", rx(-20)),
        *tail(-40, 10, 5, 5),
    )
    return [(0, standing()), (5, reach), (8, deeper), (10, push), (13, air)]


def land_keys():
    reach = pose(
        body(rx(-5)),
        paw("hand_ik.L", offset=(0, 0.04, 0.02)), paw("hand_ik.R", offset=(0, 0.04, 0.02)),
        paw("foot_ik.L", offset=(0, 0.02, 0.04)), paw("foot_ik.R", offset=(0, 0.02, 0.04)),
        *tail(-10, 5, 5, 5),
    )
    impact = pose(body(rx(-4), offset=(0, -0.005, -0.045)), *tail(-5, 5, 5, 5))
    recover = pose(body(rx(-2), offset=(0, 0, -0.02)), *tail(-12, 5, 8, 8))
    return [(0, reach), (2, impact), (3, recover)]


def climb_keys():
    reach = pose(
        body(rx(35)),
        paw("hand_ik.L", target=(-0.045, 0.12, 0.45)), paw("hand_ik.R", target=(0.045, 0.12, 0.45)),
        paw("foot_ik.L", offset=(0, 0, 0.05)), paw("foot_ik.R", offset=(0, -0.03, 0.02)),
        *tail(10, 5, 0, 0),
    )
    pull = pose(
        body(rx(25), offset=(0, 0.03, 0.08)),
        paw("hand_ik.L", offset=(0, 0, 0.3)), paw("hand_ik.R", offset=(0, 0, 0.3)),
        paw("foot_ik.L", offset=(0, 0.02, 0.12)), paw("foot_ik.R", offset=(0, -0.02, 0.08)),
        *tail(0, 5, 5, 0),
    )
    push = pose(
        body(rx(10), offset=(0, 0.02, 0.04)),
        paw("hand_ik.L", offset=(0, 0, 0.08)), paw("hand_ik.R", offset=(0, 0, 0.08)),
        paw("foot_ik.L", offset=(0, -0.02, 0.15)), paw("foot_ik.R", offset=(0, 0.0, 0.12)),
        *tail(-10, 5, 5, 5),
    )
    return [(0, reach), (4, pull), (8, push), (12, standing())]


def swipe_keys(side):
    """side 'L' or 'R'. The paw strikes forward and inward at frame 2
    (0.083 s), matching the game's 0.08 s hit time."""
    sx = -1 if side == "L" else 1  # the cat's left is -X
    pawn = f"hand_ik.{side}"
    raise_ = pose(
        body(rx(5), offset=(-sx * 0.01, 0, 0)),
        paw(pawn, offset=(sx * 0.01, 0.03, 0.11), rot=rx(-50)),
        *tail(-15, 5, 10, 10),
    )
    strike = pose(
        body(rx(3) @ rz(sx * -6), offset=(-sx * 0.01, 0.01, 0)),
        paw(pawn, offset=(-sx * 0.04, 0.13, 0.05), rot=rx(-20)),
        *tail(-15, 5, 10, 10),
    )
    recover = pose(
        body(rx(2), offset=(-sx * 0.005, 0, 0)),
        paw(pawn, offset=(-sx * 0.01, 0.06, 0.04)),
        *tail(-15, 5, 10, 10),
    )
    return [(0, standing()), (1, raise_), (2, strike), (4, recover), (7, standing())]


def grab_keys():
    half = mix(standing(), sitting(), 0.5)
    return [(0, standing()), (3, half), (6, sitting())]


def throw_keys():
    wind = sitting(pitch=5, paw_l=(0, -0.05, -0.02), paw_r=(0, -0.05, -0.02))
    push = sitting(pitch=-10, shift=(0, 0.02, 0.01), paw_l=(0, 0.12, 0.02), paw_r=(0, 0.12, 0.02), look=-30)
    follow = sitting(pitch=-20, shift=(0, 0.01, 0.02), paw_l=(0, 0.1, -0.1), paw_r=(0, 0.1, -0.1), look=-25)
    return [(0, sitting()), (2, wind), (4, push), (7, follow)]


def trick_keys():
    """Toss the item straight up, then cock the right paw for the spike
    (the spike itself plays swipe_R). Holds the last frame."""
    dip = sitting(pitch=-5, shift=(0, 0, -0.01), paw_l=(0, 0, -0.05), paw_r=(0, 0, -0.05))
    toss = sitting(pitch=10, shift=(0, 0, 0.03), paw_l=(0, -0.02, 0.15), paw_r=(0, -0.02, 0.15), look=-10)
    ready = sitting(pitch=5, paw_l=(0, -0.04, -0.08), paw_r=(0, -0.06, 0.14), look=-15)
    return [(0, sitting()), (3, dip), (6, toss), (10, ready), (12, ready)]


# name -> (loop, frames, source). Loops are sampled every frame from a phase
# function; one-shots are key poses with Bezier easing.
ANIMATIONS = {
    "idle": (True, 48, idle),
    "walk": (True, 11, walk),
    "run": (True, 8, run),
    "hold": (True, 24, hold),
    "pounce": (True, 10, pounce),
    "jump": (False, 10, jump_keys),
    "land": (False, 3, land_keys),
    "descend": (False, 13, descend_keys),
    "climb": (False, 12, climb_keys),
    "swipe_L": (False, 7, lambda: swipe_keys("L")),
    "swipe_R": (False, 7, lambda: swipe_keys("R")),
    "grab": (False, 6, grab_keys),
    "throw": (False, 7, throw_keys),
    "trick": (False, 12, trick_keys),
}


# ---------------------------------------------------------------------------
# Keying and baking

def apply_pose(rig, p, frame):
    for n in CONTROLS:
        pb = rig.pose.bones[n]
        loc, q = p.get(n, (ZERO, Quaternion()))
        r0 = pb.bone.matrix_local.to_3x3()
        r0i = r0.inverted()
        pb.rotation_mode = "QUATERNION"
        pb.location = r0i @ loc
        pb.rotation_quaternion = (r0i @ q.to_matrix() @ r0).to_quaternion()
        pb.scale = (1, 1, 1)
        pb.keyframe_insert("location", frame=frame, group=n)
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=n)


def replace_action(name):
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    return act


def author(name):
    loop, frames, src = ANIMATIONS[name]
    rig = bpy.data.objects[RIGIFY_RIG]
    rig.animation_data_create()
    act = replace_action(f"{name}__ctrl")
    rig.animation_data.action = act
    if loop:
        n = frames * SAMPLES
        for f in range(n + 1):
            apply_pose(rig, src(f / n), f)
    else:
        for f, p in src():
            apply_pose(rig, p, f * SAMPLES)
    return act


def bake(name):
    _, frames, _ = ANIMATIONS[name]
    frames *= SAMPLES
    sc = bpy.context.scene
    rig = bpy.data.objects[RIGIFY_RIG]
    ex = bpy.data.objects[EXPORT_RIG]
    rig.animation_data.action = bpy.data.actions[f"{name}__ctrl"]
    sc.frame_start, sc.frame_end = 0, frames

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    ex.hide_set(False)
    ex.select_set(True)
    bpy.context.view_layer.objects.active = ex
    for pb in ex.pose.bones:
        for c in pb.constraints:
            c.mute = False
    ex.animation_data_create()
    ex.animation_data.action = None
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old)

    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(
        frame_start=0, frame_end=frames, step=1,
        only_selected=True, visual_keying=True,
        clear_constraints=False, clear_parents=False,
        use_current_action=False, clean_curves=False,
        bake_types={"POSE"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    act = ex.animation_data.action
    act.name = name
    act.use_fake_user = True
    return act


def build_all(names=None):
    sc = bpy.context.scene
    sc.render.fps = FPS * SAMPLES
    names = names or list(ANIMATIONS)
    for n in names:
        author(n)
        bake(n)
    # Leave both rigs on idle.
    bpy.data.objects[RIGIFY_RIG].animation_data.action = bpy.data.actions["idle__ctrl"]
    bpy.data.objects[EXPORT_RIG].animation_data.action = bpy.data.actions["idle"]
    sc.frame_start, sc.frame_end = 0, ANIMATIONS["idle"][1] * SAMPLES
    return names


if __name__ == "__main__":
    build_all()
