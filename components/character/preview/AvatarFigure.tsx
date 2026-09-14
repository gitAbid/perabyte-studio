"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AvatarParams, PreviewPoseId } from "@/lib/avatarParams";

const GLB_URL = "/character/preview/avatar.glb";

// Body-first phase: garments stay hidden while clothing rendering is
// reworked (skinned garments); a tasteful underlayer is always shown.
const BODY_ONLY_PREVIEW = true;

/* ------------------------------------------------------------------ */
/* Poses — local-euler offsets from the bind pose restored below.      */
/* Re-tune here if the export rig ever changes.                        */
/* ------------------------------------------------------------------ */

type BoneRot = [number, number, number];

interface PoseDef {
  bones: Record<string, BoneRot>;
  root?: { rotX?: number; posY?: number; posZ?: number };
}

const POSES: Record<PreviewPoseId, PoseDef> = {
  standing: { bones: {} },
  portrait: {
    bones: {
      head: [0, 0.16, 0.05],
    },
  },
  sitting: {
    bones: {
      thigh_l: [-1.45, 0, 0.06], calf_l: [1.45, 0, 0],
      thigh_r: [-1.45, 0, -0.06], calf_r: [1.45, 0, 0],
    },
  },
  walking: {
    bones: {
      thigh_l: [-0.55, 0, 0], calf_l: [0.5, 0, 0],
      thigh_r: [0.3, 0, 0], calf_r: [0.15, 0, 0],
      spine_02: [0, 0.06, 0],
    },
  },
  action: {
    bones: {
      upperarm_l: [-1.6, 0, -0.35], upperarm_r: [-1.6, 0, 0.35],
      lowerarm_l: [-0.6, 0, 0], lowerarm_r: [-0.6, 0, 0],
      thigh_l: [-0.35, 0, 0.18], thigh_r: [0, 0, -0.18],
      calf_l: [0.35, 0, 0], spine_02: [-0.1, 0, 0],
    },
  },
  relaxed: {
    bones: {
      spine_02: [0.05, 0, 0], head: [0.04, 0, 0],
    },
  },
  dynamic: {
    bones: {
      upperarm_r: [-2.2, 0, 0.25], lowerarm_r: [-0.3, 0, 0],
      upperarm_l: [0.1, 0, -0.15], lowerarm_l: [0.5, 0, -0.06],
      thigh_l: [-0.5, 0, 0], calf_l: [0.4, 0, 0],
      spine_01: [0, -0.18, 0], head: [0, 0.1, 0],
    },
  },
  dance: {
    bones: {
      upperarm_l: [-2.3, 0, -0.15], upperarm_r: [-2.3, 0, 0.15],
      lowerarm_l: [-0.4, 0, 0.55], lowerarm_r: [-0.4, 0, -0.55],
      thigh_r: [0.35, 0, 0], calf_r: [0.3, 0, 0],
      spine_02: [-0.08, 0, 0], head: [-0.1, 0, 0],
    },
  },
  lying: {
    bones: {},
    root: { rotX: -Math.PI / 2, posY: 0.32, posZ: 0.55 },
  },
  arched: {
    bones: {
      spine_01: [0.22, 0, 0], spine_02: [0.22, 0, 0], spine_03: [0.18, 0, 0],
      head: [-0.35, 0, 0],
      thigh_l: [0.1, 0, 0.08], thigh_r: [0.1, 0, -0.08],
    },
  },
  allfours: {
    bones: {
      thigh_l: [-1.35, 0, 0.1], calf_l: [1.3, 0, 0],
      thigh_r: [-1.35, 0, -0.1], calf_r: [1.3, 0, 0],
      upperarm_l: [-1.45, 0, -0.1], upperarm_r: [-1.45, 0, 0.1],
      lowerarm_l: [-0.2, 0, 0], lowerarm_r: [-0.2, 0, 0],
      spine_01: [0.35, 0, 0], head: [-0.5, 0, 0],
    },
    root: { rotX: -1.35, posY: 0.28, posZ: 0.4 },
  },
  spreading: {
    bones: {
      thigh_l: [0, 0, 0.32], thigh_r: [0, 0, -0.32],
      spine_02: [-0.06, 0, 0],
    },
  },
  kneeling: {
    bones: {
      thigh_l: [0.45, 0, 0.06], calf_l: [1.75, 0, 0],
      thigh_r: [0.45, 0, -0.06], calf_r: [1.75, 0, 0],
      head: [0.18, 0, 0],
    },
    root: { posY: -0.42 },
  },
  dominant: {
    bones: {
      head: [-0.14, 0, 0], spine_03: [-0.05, 0, 0],
      thigh_l: [0, 0, 0.1], thigh_r: [0, 0, -0.1],
    },
  },
};

const POSE_BONE_NAMES = [
  "Root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
  "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l",
  "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
  "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r",
];

/* ------------------------------------------------------------------ */

const DAMP = 7; // smoothing speed for morphs and bones

// Scratch objects for the per-frame pose update (avoids allocation).
const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();

/**
 * Restore the skeleton's bind pose from the inverse-bind matrices. The
 * exporter's node transforms and IBMs disagree (the skeleton root carries
 * Blender's Y-up rotation), which shows up as mangled hands/fingers at the
 * file transforms. Rendering every skinned vertex through nodeWorld = IBM⁻¹
 * reproduces the authored mesh exactly — clean hands, clean joints. Poses
 * are then offsets from this restored stance.
 */
function restoreBindPose(model: THREE.Object3D) {
  let skinned: THREE.SkinnedMesh | undefined;
  model.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) {
      skinned = o as THREE.SkinnedMesh;
    }
  });
  if (!skinned) return;
  const { bones, boneInverses } = skinned.skeleton;
  const worldBind = new Map<THREE.Bone, THREE.Matrix4>();
  bones.forEach((bone, i) => {
    worldBind.set(bone, boneInverses[i].clone().invert());
  });
  const local = new THREE.Matrix4();
  const parentWorldInv = new THREE.Matrix4();
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    const world = worldBind.get(bone)!;
    const parent = bone.parent as THREE.Bone | null;
    const parentWorld = parent ? worldBind.get(parent) : undefined;
    if (parentWorld) {
      parentWorldInv.copy(parentWorld).invert();
      local.multiplyMatrices(parentWorldInv, world);
    } else {
      local.copy(world);
    }
    local.decompose(bone.position, bone.quaternion, bone.scale);
  }
  model.updateMatrixWorld(true);
}

/** Upgrade the body's material to a physical skin shading model. */
function upgradeSkinMaterial(body: THREE.Mesh, skinHex: string) {
  const src = body.material as THREE.MeshStandardMaterial;
  const skin = new THREE.MeshPhysicalMaterial({
    map: src.map ?? null,
    normalMap: src.normalMap ?? null,
    color: new THREE.Color(skinHex),
    roughness: 0.58,
    metalness: 0,
    sheen: 0.4, // soft dermal scattering approximation
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color("#4a241d"),
    clearcoat: 0.05, // faint skin-oil highlight
    clearcoatRoughness: 0.7,
  });
  body.material = skin;
}

export function AvatarFigure({ params }: { params: AvatarParams }) {
  const { scene } = useGLTF(GLB_URL);

  const model = useMemo(() => {
    const cloned = skeletonClone(scene);
    restoreBindPose(cloned);
    const body = cloned.getObjectByName("Body") as THREE.Mesh | undefined;
    if (body) upgradeSkinMaterial(body, params.skinHex);
    return cloned;
    // skinHex is re-applied by the materials effect; this seeds the colour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // NOTE: never pose with absolute rotations — both partial bind restores
  // and absolute eulers crumple the skinned mesh. Poses are quaternion
  // offsets from the restored bind stance.

  const refs = useMemo(() => {
    const body = model.getObjectByName("Body") as THREE.Mesh | undefined;
    const bones = new Map<string, THREE.Bone>();
    const rest = new Map<string, { q: THREE.Quaternion }>();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        bones.set(o.name, o as THREE.Bone);
        rest.set(o.name, { q: (o as THREE.Bone).quaternion.clone() });
      }
    });
    const meshes = new Map<string, THREE.Mesh>();
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.set(o.name, o as THREE.Mesh);
    });
    return { body, bones, rest, meshes };
  }, [model]);

  /* -------- visibility: hair on, garments off, face interior off -------- */
  useEffect(() => {
    for (const mesh of refs.meshes.values()) {
      const name = mesh.name;
      if (name.startsWith("Hair__")) {
        mesh.visible = name === params.hairMesh;
      } else if (name.startsWith("Clothes__")) {
        // Clothing rendering is being reworked (skinned garments).
        mesh.visible = !BODY_ONLY_PREVIEW && name === params.garmentMesh;
      }
      // Mouth interior and eyeballs read poorly in this base mesh (and no
      // expression in our set opens the jaw) — keep them hidden.
      else if (name === "Teeth" || name === "Tongue" || name === "Eyes") {
        mesh.visible = false;
      }
    }
  }, [refs, params.hairMesh, params.garmentMesh]);

  /* -------- materials: re-tint skin / hair / brows in place --------
     Mutations stay IN PLACE on each mesh's own material: swapping material
     instances at runtime desyncs depth against the rest of the figure. */
  useEffect(() => {
    const body = refs.body;
    if (!body) return;
    (body.material as THREE.MeshPhysicalMaterial).color.set(params.skinHex);

    const tint = (meshName: string, hex: string, rough: number) => {
      const mesh = refs.meshes.get(meshName);
      if (!mesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(hex);
      mat.roughness = rough;
    };

    tint(params.hairMesh ?? "", params.hairColorHex, 0.45);
    tint("Eyebrows", params.hairColorHex, 0.6);
  }, [refs, params]);

  /* -------- procedural pieces: underlayer + piercings --------
     Rebuilt when coverage/tint/piercings change. Children attach to bones
     (pelvis/head) so they follow the pose; cleanup detaches + disposes. */
  useEffect(() => {
    const pelvis = refs.bones.get("pelvis");
    const head = refs.bones.get("head");

    const attach = (mesh: THREE.Mesh, bone: THREE.Bone | undefined, pos: [number, number, number]) => {
      mesh.position.set(...pos);
      if (bone) bone.add(mesh);
      else model.add(mesh);
    };

    // Tasteful underlayer, always on during the body phase.
    const briefMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(params.coverage === "minimal" ? params.garmentTint : "#2a2a2e"),
      roughness: 0.7,
    });
    const briefs = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), briefMat);
    briefs.name = "proc_briefs";
    briefs.scale.set(0.145, 0.085, 0.1);
    attach(briefs, pelvis, [0, -0.075, 0]);

    if (params.piercings) {
      const studMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#d9b64a"),
        metalness: 0.85,
        roughness: 0.25,
      });
      for (const side of [-1, 1]) {
        const stud = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), studMat);
        stud.name = `proc_stud_${side}`;
        attach(stud, head, [0.082 * side, 0.045, 0.02]);
      }
    }

    return () => {
      for (const name of ["proc_briefs", "proc_band", "proc_stud_-1", "proc_stud_1"]) {
        const obj = model.getObjectByName(name);
        if (!obj) continue;
        obj.parent?.remove(obj);
        const mesh = obj as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    };
  }, [refs, model, params.coverage, params.garmentTint, params.piercings]);

  /* -------- per-frame: damp morphs and bone rotations -------- */
  const rootGroup = useRef<THREE.Group>(null);
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const k = Math.min(1, DAMP * delta);

    if (refs.body?.morphTargetInfluences && refs.body.morphTargetDictionary) {
      const dict = refs.body.morphTargetDictionary;
      for (const [name, target] of Object.entries(params.morphs)) {
        const idx = dict[name];
        if (idx === undefined) continue;
        const cur = refs.body.morphTargetInfluences[idx] ?? 0;
        refs.body.morphTargetInfluences[idx] = cur + (target - cur) * k;
      }
      // ease back any morph not in the target set
      for (const [name, idx] of Object.entries(dict)) {
        if (!(name in params.morphs)) {
          const cur = refs.body.morphTargetInfluences[idx] ?? 0;
          if (Math.abs(cur) > 0.001) refs.body.morphTargetInfluences[idx] = cur * (1 - k);
        }
      }
    }

    const pose = POSES[params.pose] ?? POSES.standing;
    const idle = {
      spine_02: Math.sin(t * 1.5) * 0.02,
      head: Math.sin(t * 0.7) * 0.02,
      head_z: Math.sin(t * 0.55) * 0.018,
    };

    const euler = tmpEuler;
    const offset = tmpQuat;
    for (const name of POSE_BONE_NAMES) {
      const bone = refs.bones.get(name);
      const restQ = refs.rest.get(name)?.q;
      if (!bone || !restQ) continue;
      const target = pose.bones[name] ?? [0, 0, 0];
      let [rx, ry, rz] = target;
      if (name === "spine_02") rx += idle.spine_02;
      if (name === "head") {
        rx += idle.head;
        rz += idle.head_z;
      }
      // Offset from the bone's rest stance: rest * delta, never absolute.
      euler.set(rx, ry, rz);
      offset.setFromEuler(euler);
      bone.quaternion.slerp(tmpQuat2.copy(restQ).multiply(offset), k);
    }

    if (rootGroup.current) {
      const g = rootGroup.current;
      const rotX = pose.root?.rotX ?? 0;
      const posY = pose.root?.posY ?? 0;
      const posZ = pose.root?.posZ ?? 0;
      g.rotation.x += (rotX - g.rotation.x) * k;
      g.position.y += (posY - g.position.y) * k;
      g.position.z += (posZ - g.position.z) * k;
      const hs = params.heightScale;
      g.scale.x += (hs.xz - g.scale.x) * k;
      g.scale.z += (hs.xz - g.scale.z) * k;
      g.scale.y += (hs.y - g.scale.y) * k;
    }
  });

  return (
    <group ref={rootGroup}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(GLB_URL);
