"""
Generate the PeraByte character-preview 3D assets from the MakeHuman/MPFB2
parametric human (CC0 assets). Run headless:

  /Applications/Blender.app/Contents/MacOS/Blender -b -P gen_avatar.py -- <outdir>

Outputs:
  <outdir>/avatar.glb      single GLB: rigged body + morph targets + all
                           hair/garment/accessory meshes (toggled by name)
  <outdir>/avatar-meta.json object names, shape keys, bones (consumed by the
                           web mapping layer)
"""
import bpy, os, sys, json, importlib

OUT_DIR = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/tmp/mhsetup/out"
ASSETS = "/tmp/mhsetup/assets_root"

# ---------------------------------------------------------------- imports
def dyn(pkg, key):
    """MPFB ships as a blender extension; find its module by suffix."""
    for amod in sys.modules:
        if amod.endswith(pkg):
            m = importlib.import_module(amod)
            return getattr(m, key)
    raise ValueError("module not found: " + pkg)

bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mpfb")

HumanService = dyn("mpfb.services.humanservice", "HumanService")
TargetService = dyn("mpfb.services.targetservice", "TargetService")
ObjectService = dyn("mpfb.services.objectservice", "ObjectService")
LocationService = dyn("mpfb.services.locationservice", "LocationService")
HumanObjectProperties = dyn("mpfb.entities.objectproperties", "HumanObjectProperties")

TARGETS = LocationService.get_mpfb_data("targets")

# ---------------------------------------------------------------- clean scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- body
base = HumanService.create_human()
base.name = "Body"
print("BASE created:", base.name, "verts:", len(base.data.vertices))

# ---------------------------------------------------------------- skin
skin = os.path.join(ASSETS, "skins/young_caucasian_female/young_caucasian_female.mhmat")
HumanService.set_character_skin(skin, base, skin_type="GAMEENGINE")
print("SKIN applied")

# ---------------------------------------------------------------- face assets
def add_mhclo(rel, atype, obj_name):
    path = os.path.join(ASSETS, rel)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    objs = HumanService.add_mhclo_asset(path, base, asset_type=atype)
    objs = objs if isinstance(objs, list) else [objs]
    for o in objs:
        o.name = obj_name
    print("ASSET", atype, "->", obj_name)
    return objs

add_mhclo("eyes/high-poly/high-poly.mhclo", "Eyes", "Eyes")
add_mhclo("eyelashes/eyelashes01/eyelashes01.mhclo", "Eyelashes", "Eyelashes")
add_mhclo("eyebrows/eyebrow001/eyebrow001.mhclo", "Eyebrows", "Eyebrows")
add_mhclo("teeth/teeth_base/teeth_base.mhclo", "Teeth", "Teeth")
add_mhclo("tongue/tongue01/tongue01.mhclo", "Tongue", "Tongue")

# ---------------------------------------------------------------- hair + garments
HAIRS = ["long01", "bob01", "bob02", "braid01", "ponytail01", "short01", "short02", "short03", "short04", "afro01"]
CLOTHES = [
    # (dir, mhclo basename without .mhclo)
    ("female_casualsuit01", "female_casualsuit01"),
    ("female_casualsuit02", "female_casualsuit02"),
    ("female_elegantsuit01", "female_elegantsuit01"),
    ("female_sportsuit01", "female_sportsuit01"),
    ("male_casualsuit01", "male_casualsuit01"),
    ("male_elegantsuit01", "male_elegantsuit01"),
    ("male_worksuit01", "male_worksuit01"),
    ("shoes01", "shoes01"),
    ("fedora01", "fedora"),
]

for h in HAIRS:
    add_mhclo(f"hair/{h}/{h}.mhclo", "Hair", "Hair__" + h)
for d, f in CLOTHES:
    add_mhclo(f"clothes/{d}/{f}.mhclo", "Clothes", "Clothes__" + d)

# ---------------------------------------------------------------- rig
rig = HumanService.add_builtin_rig(base, "game_engine")
print("RIG:", rig.name)

# Remove stray helper objects (e.g. the eye-helper icosphere MPFB leaves behind)
for o in list(bpy.data.objects):
    if o.name.lower() in ("icosphere", "sphere", "cube"):
        print("REMOVING helper object:", o.name)
        bpy.data.objects.remove(o, do_unlink=True)

base.data.name = "Body"

# ---------------------------------------------------------------- shape keys
def load_target(name, rel, weight=0.0):
    path = os.path.join(TARGETS, rel + ".target.gz")
    if not os.path.exists(path):
        print("!! missing target:", rel)
        return None
    TargetService.load_target(base, path, weight=weight, name=name)
    print("TARGET", name)
    return name

TARGET_KEYS = {
    # face shapes (FACE_SHAPES presets)
    "face_round":       "head/head-round",
    "face_square":      "head/head-square",
    "face_rectangular": "head/head-rectangular",
    "face_heart":       "head/head-invertedtriangular",
    "face_diamond":     "head/head-diamond",
    "face_long":        "head/head-scale-vert-incr",
    # eye shapes
    "eye_round":        None,  # both eyes scale-incr, handled below
    "eye_hooded":       None,
    "eye_monolid":      None,
    "eye_upturned":     None,
    # expressions
    "expr_smile":       "mouth/mouth-angles-up",
    "expr_mouth_down":  "mouth/mouth-angles-down",
    "expr_cheeks":      None,  # both cheek volumes
    # body accents
    "breast_up":        "breast/breast-volume-vert-up",
    "breast_down":      "breast/breast-volume-vert-down",
    "hip_wide":         "hip/hip-scale-horiz-incr",
    "hip_narrow":       "hip/hip-scale-horiz-decr",
    "waist_thin":       "torso/measure-waist-circ-decr",
    "waist_thick":      "torso/measure-waist-circ-incr",
    "shoulder_wide":    "torso/measure-shoulder-dist-incr",
    "shoulder_narrow":  "torso/measure-shoulder-dist-decr",
    "buttocks_up":      "buttocks/buttocks-volume-incr" if os.path.exists(os.path.join(TARGETS, "buttocks/buttocks-volume-incr.target.gz")) else None,
}
for key, rel in list(TARGET_KEYS.items()):
    if rel is None:
        del TARGET_KEYS[key]

# combined left+right targets need two files -> load both under one driven key
def load_pair(name, prefix_l, prefix_r):
    pl = os.path.join(TARGETS, prefix_l + ".target.gz")
    pr = os.path.join(TARGETS, prefix_r + ".target.gz")
    if os.path.exists(pl) and os.path.exists(pr):
        TargetService.load_target(base, pl, weight=0.0, name=name + "__l")
        TargetService.load_target(base, pr, weight=0.0, name=name + "__r")
        print("TARGET PAIR", name)
    else:
        print("!! missing pair:", name)

for name, rel in TARGET_KEYS.items():
    load_target(name, rel)

load_pair("eye_round", "eyes/l-eye-scale-incr", "eyes/r-eye-scale-incr")
load_pair("eye_hooded", "eyes/l-eye-eyefold-down", "eyes/r-eye-eyefold-down")
load_pair("eye_monolid", "eyes/l-eye-eyefold-concave", "eyes/r-eye-eyefold-concave")
load_pair("eye_upturned", "eyes/l-eye-eyefold-angle-up", "eyes/r-eye-eyefold-angle-up")
load_pair("expr_cheeks", "cheek/l-cheek-volume-incr", "cheek/r-cheek-volume-incr")

# ---------------------------------------------------------------- macro bakes
# MPFB applies macro details (gender/age/muscle/weight/height) through its
# internal $md-* shape keys; the deformation is only visible on the
# EVALUATED mesh. The "Hide helpers" mask modifier must be disabled during
# capture or the evaluated vertex count/order mismatches our base. Each
# axis extreme is captured as ONE shape key; the browser blends them
# linearly, mirroring MPFB's own axis interpolation. Bakes assert a real
# delta so an empty capture fails loudly instead of shipping a stiff body.
import numpy as np

def bake_macro(name, props):
    var = HumanService.create_human()
    var.name = "ax_" + name
    var.location = (5.0, 0.0, 0.0)
    for k, v in props.items():
        HumanObjectProperties.set_value(k, v, entity_reference=var)
    TargetService.reapply_macro_details(var, remove_zero_weight_targets=False)

    mask = var.modifiers.get("Hide helpers")
    if mask:
        mask.show_viewport = False

    def evaluated_coords():
        # to_mesh() returns LOCAL coordinates (object transform excluded), so
        # the variant's +5m workspace offset never leaks into the capture.
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = var.evaluated_get(dg).to_mesh()
        arr = np.array([v.co[:] for v in me.vertices])
        var.evaluated_get(dg).to_mesh_clear()
        return arr

    ev = evaluated_coords()
    keys = var.data.shape_keys.key_blocks
    saved = [sk.value for sk in keys]
    for sk in keys:
        sk.value = 0.0
    basis = evaluated_coords()
    for sk, v in zip(keys, saved):
        sk.value = v
    delta = ev - basis  # true deformation offsets in the shared local frame
    max_delta = float(np.abs(delta).max())
    assert max_delta > 0.005, f"{name}: macro bake captured no deformation (max delta {max_delta})"

    sk = base.shape_key_add(name="ax_" + name, from_mix=False)
    base_basis = np.array([v.co[:] for v in base.data.vertices])
    out = base_basis + delta
    for i, co in enumerate(out):
        sk.data[i].co = co
    bpy.data.objects.remove(var, do_unlink=True)
    print(f"AXIS BAKE {name}: verts {len(ev)} max delta {max_delta:.4f}")

# Only the INTERACTING axes are baked as a cross grid (2x3x3 = 18 keys).
# Height is applied as a runtime root scale (composes exactly outside
# skinning) and muscle as accent targets — per-axis full-body deltas do NOT
# compose additively, so every extra baked axis would multiply the grid.
NEUTRAL = {"gender": 0.5, "age": 0.5, "muscle": 0.5, "weight": 0.5, "height": 0.5}
# MPFB age axis: 0=baby, 0.5=young adult, 1.0=old. The wizard is 18+ only,
# so the age grid spans young -> old exclusively.
for g_name, g_val in [("m", 0.0), ("f", 1.0)]:
    for a_name, a_val in [("young", 0.5), ("old", 1.0)]:
        for w_name, w_val in [("light", 0.0), ("average", 0.5), ("heavy", 1.0)]:
            props = dict(NEUTRAL)
            props["gender"] = g_val
            props["age"] = a_val
            props["weight"] = w_val
            bake_macro(f"gaw_{g_name}_{a_name}_{w_name}", props)

# ---------------------------------------------------------------- normalize keys
shape_keys = []
key_blocks = base.data.shape_keys.key_blocks if base.data.shape_keys else []
dead = []
for sk in key_blocks:
    sk.value = 0.0
    if sk.name != "Basis":
        if sk.name.startswith("$md-"):
            dead.append(sk)
        else:
            shape_keys.append(sk.name)
# drop MPFB's internal macro keys: dead weight we never drive
for sk in dead:
    try:
        base.shape_key_remove(sk)
    except Exception as e:
        print("could not remove key", sk.name, e)
print("REMOVED dead keys:", len(dead))
print("SHAPE KEYS:", shape_keys)

# ---------------------------------------------------------------- skin assets
# Parent every fitted asset (hair/clothes/face parts) to the rig with
# automatic weights. At the rest pose the render is unchanged, but the
# meshes now follow the same skeleton as the body — runtime bind handling
# and poses stay consistent between body and assets.
asset_objects = [o for o in bpy.data.objects
                 if o.name.startswith(("Hair__", "Clothes__", "Eyes", "Eyelashes", "Eyebrows", "Teeth", "Tongue"))]
bpy.ops.object.select_all(action="DESELECT")
for o in asset_objects:
    o.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
print("SKINNED assets:", len(asset_objects))

# ---------------------------------------------------------------- rest pose
# The armature must be exported in its rest pose: runtime posing in three.js
# offsets from the bind pose, so the bind (inverse bind matrices) and the
# exported node transforms have to describe the same stance. Any leftover
# pose from the MPFB session breaks skinned posing in the browser.
posed = 0
for pb in rig.pose.bones:
    mb = pb.matrix_basis
    if abs(mb.to_euler().x) + abs(mb.to_euler().y) + abs(mb.to_euler().z) > 1e-5 or \
       any(abs(v) > 1e-5 for v in mb.to_translation()) or \
       any(abs(v - 1.0) > 1e-5 for v in mb.to_scale()):
        posed += 1
    pb.location = (0.0, 0.0, 0.0)
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (0.0, 0.0, 0.0)
    pb.scale = (1.0, 1.0, 1.0)
bpy.context.view_layer.update()
print("REST POSE applied; bones with non-identity pose before clear:", posed)

# ---------------------------------------------------------------- export
os.makedirs(OUT_DIR, exist_ok=True)

bpy.ops.object.select_all(action="DESELECT")
export_objects = [base, rig] + [o for o in bpy.data.objects if o.name.startswith(("Hair__", "Clothes__", "Eyes", "Eyelashes", "Eyebrows", "Teeth", "Tongue"))]
for o in export_objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = base

glb_path = os.path.join(OUT_DIR, "avatar.glb")
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=False,
    export_skins=True,
    export_morph=True,
    export_morph_normal=False,
    export_animations=False,
    export_materials="EXPORT",
    export_texcoords=True,
    export_normals=True,
    export_extras=False,
)
print("EXPORTED", glb_path, os.path.getsize(glb_path), "bytes")

# ---------------------------------------------------------------- metadata
meta = {
    "objects": [o.name for o in export_objects],
    "shapeKeys": shape_keys,
    "bones": [b.name for b in rig.data.bones],
    "hairs": HAIRS,
    "clothes": CLOTHES,
}
meta_path = os.path.join(OUT_DIR, "avatar-meta.json")
with open(meta_path, "w") as f:
    json.dump(meta, f, indent=1)
print("META", meta_path)
print("DONE")
