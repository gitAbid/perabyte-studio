"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useTexture } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AvatarParams, PreviewPoseId } from "@/lib/avatarParams";

const GLB_URL = "/character/preview/avatar.glb";

/* ------------------------------------------------------------------ */
/* Poses — local-euler offsets (radians) from the bind pose.           */
/* Bind pose: upright, arms hanging at the sides. Tuned against the    */
/* game_engine rig; adjust here if the export rig ever changes.        */
/* ------------------------------------------------------------------ */

type BoneRot = [number, number, number];

interface PoseDef {
  bones: Record<string, BoneRot>;
  root?: { rotX?: number; posY?: number; posZ?: number };
}

const POSES: Record<PreviewPoseId, PoseDef> = {
  // Neutral poses keep the arms at the bind stance: the garment meshes are
  // static and fitted to that exact pose, so moving the arms detaches the
  // sleeves. Only the expressive poses (action/dynamic/dance) move arms,
  // accepting the loose-sleeve approximation.
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
      upperarm_l: [-0.35, 0, 0.1], lowerarm_l: [-0.55, 0, 0],
      upperarm_r: [-0.35, 0, -0.1], lowerarm_r: [-0.55, 0, 0],
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
      hand_l: [0.06, 0, 0], hand_r: [0.06, 0, 0],
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
    bones: {
    },
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
      hand_l: [0.06, 0, 0], hand_r: [0.06, 0, 0],
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

// Per-garment "one size up" factors. Tight suits need more headroom than
// loose dresses so the morphed body never pokes through the shell.
const GARMENT_INFLATE: Record<string, number> = {
  "Clothes__female_casualsuit01": 1.08,
  "Clothes__female_casualsuit02": 1.09,
  "Clothes__female_elegantsuit01": 1.15,
  "Clothes__female_sportsuit01": 1.12,
  "Clothes__male_casualsuit01": 1.08,
  "Clothes__male_elegantsuit01": 1.1,
  "Clothes__male_worksuit01": 1.09,
};
const DEFAULT_INFLATE = 1.1;

// Scratch objects for the per-frame pose update (avoids allocation).
const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();


export function AvatarFigure({ params }: { params: AvatarParams }) {
  const { scene } = useGLTF(GLB_URL);
  const eyeTexture = useTexture(params.eyeTexture);
  eyeTexture.colorSpace = THREE.SRGBColorSpace;

  const model = useMemo(() => skeletonClone(scene), [scene]);

  // NOTE: do not "restore" the bind pose from the inverse-bind matrices —
  // this export's IBMs and node transforms disagree (the skeleton root
  // carries Blender's Y-up rotation), and only the file transforms render
  // the skin consistent with the static garment/hair shells. Poses are
  // therefore offsets from the loaded file transforms.

  const refs = useMemo(() => {
    const body = model.getObjectByName("Body") as THREE.Mesh | undefined;
    const bones = new Map<string, THREE.Bone>();
    const rest = new Map<string, { q: THREE.Quaternion }>();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        bones.set(o.name, o as THREE.Bone);
        // Rest = the restored bind pose — poses are offsets from this.
        rest.set(o.name, { q: (o as THREE.Bone).quaternion.clone() });
      }
    });
    const meshes = new Map<string, THREE.Mesh>();
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.set(o.name, o as THREE.Mesh);
    });
    const morphIndex = new Map<string, number>();
    if (body?.morphTargetDictionary) {
      for (const [name, index] of Object.entries(body.morphTargetDictionary)) {
        morphIndex.set(name, index);
      }
    }
    // Shared inflate pivot: the body's bounding-box centre in model space.
    // Garment meshes have arbitrary local origins, so scaling them directly
    // would also translate them; compensating the position keeps the shell
    // centred on the body while growing it outward.
    const pivot = new THREE.Vector3();
    if (body) {
      body.geometry.computeBoundingBox();
      body.geometry.boundingBox?.getCenter(pivot);
    }
    return { body, bones, rest, meshes, morphIndex, pivot };
  }, [model]);

  /** Inflate a static shell by s about the shared pivot. */
  const inflateShell = (mesh: THREE.Object3D, s: number, pivot: THREE.Vector3) => {
    mesh.scale.setScalar(s);
    mesh.position.copy(pivot).multiplyScalar(1 - s);
  };

  /* -------- visibility: hair / garment / shoes / hat --------
     Garments and hair are static shells fitted to the base body; the spec
     morphs grow the skin past them, so every garment is inflated slightly
     ("one size up") to keep the morphed body inside its outfit. */
  useEffect(() => {
    for (const mesh of refs.meshes.values()) {
      const name = mesh.name;
      if (name.startsWith("Hair__")) {
        mesh.visible = name === params.hairMesh;
        if (name === params.hairMesh) inflateShell(mesh, 1.03, refs.pivot);
      } else if (name.startsWith("Clothes__")) {
        if (name === "Clothes__shoes01") {
          mesh.visible = params.shoes;
          if (params.shoes) inflateShell(mesh, 1.03, refs.pivot);
        } else if (name === "Clothes__fedora01") {
          mesh.visible = params.hat;
        } else {
          mesh.visible = name === params.garmentMesh;
          if (name === params.garmentMesh) {
            inflateShell(mesh, GARMENT_INFLATE[name] ?? DEFAULT_INFLATE, refs.pivot);
          }
        }
      }
      // Mouth interior and eyeballs render with artifacts in the exported
      // bind pose (and no expression in our set opens the jaw) — keep them
      // hidden; the base-mesh face reads better without them.
      else if (name === "Teeth" || name === "Tongue" || name === "Eyes") {
        mesh.visible = false;
      }
    }
  }, [refs, params.hairMesh, params.garmentMesh, params.shoes, params.hat]);


  /* -------- materials: skin / hair / eyes / garment -------- */
  useEffect(() => {
    const body = refs.body;
    if (!body) return;
    const skinMat = body.material as THREE.MeshStandardMaterial;
    if (params.material === "toon") {
      const toon = new THREE.MeshToonMaterial({
        color: new THREE.Color(params.skinHex),
        map: skinMat.map,
      });
      body.material = toon;
    } else {
      if (!(body.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        body.material = new THREE.MeshStandardMaterial({
          map: skinMat.map,
          normalMap: skinMat.normalMap,
          roughness: 0.62,
        });
      }
      const mat = body.material as THREE.MeshStandardMaterial;
      mat.color.set(params.skinHex);
      if (params.material === "clay") {
        mat.map = null;
        mat.normalMap = null;
        mat.roughness = 0.95;
        mat.metalness = 0;
      } else {
        mat.roughness = 0.62;
        mat.metalness = 0;
      }
    }

    const tint = (meshName: string, hex: string, fallbackRough = 0.55) => {
      const mesh = refs.meshes.get(meshName);
      if (!mesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(hex);
      mat.roughness = fallbackRough;
    };

    // Hair + brows follow the selected hair colour.
    const hairMesh = refs.meshes.get(params.hairMesh ?? "");
    if (hairMesh) {
      const mat = hairMesh.material as THREE.MeshStandardMaterial;
      mat.color.set(params.hairColorHex);
      mat.roughness = 0.45;
    }
    tint("Eyebrows", params.hairColorHex, 0.6);

    const eyes = refs.meshes.get("Eyes");
    if (eyes) {
      const mat = eyes.material as THREE.MeshStandardMaterial;
      mat.map = eyeTexture;
      mat.color.set("#ffffff");
      mat.roughness = 0.15;
      mat.needsUpdate = true;
    }

    if (params.garmentMesh) {
      const mesh = refs.meshes.get(params.garmentMesh);
      if (mesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(params.garmentTint);
        mat.transparent = params.garmentOpacity < 1;
        mat.opacity = params.garmentOpacity;
        if (params.garmentGloss) {
          mat.roughness = 0.16;
          mat.metalness = 0.3;
        } else {
          mat.roughness = 0.8;
          mat.metalness = 0;
        }
        mat.needsUpdate = true;
      }
    }
  }, [refs, params, eyeTexture]);

  /* -------- procedural pieces: underwear + piercings --------
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

    if (params.coverage === "minimal" || params.coverage === "none") {
      const briefMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.coverage === "minimal" ? params.garmentTint : "#2a2a2e"),
        roughness: 0.7,
      });
      const briefs = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), briefMat);
      briefs.name = "proc_briefs";
      briefs.scale.set(0.145, 0.085, 0.1);
      attach(briefs, pelvis, [0, 0.02, 0]);

      if (params.coverage === "minimal") {
        const band = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), briefMat);
        band.name = "proc_band";
        band.scale.set(0.13, 0.05, 0.09);
        attach(band, pelvis, [0, 0.42, 0.055]);
      }
    }

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
  const POSE_LOOP_DISABLED = true; // diagnostic bisect
  useFrame((state, delta) => {
    if (POSE_LOOP_DISABLED) return;
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
      bone.quaternion.slerp(
        tmpQuat2.copy(restQ).multiply(offset),
        k,
      );
    }

    if (rootGroup.current) {
      const g = rootGroup.current;
      const rotX = pose.root?.rotX ?? 0;
      const posY = pose.root?.posY ?? 0;
      const posZ = pose.root?.posZ ?? 0;
      g.rotation.x += (rotX - g.rotation.x) * k;
      g.position.y += (posY - g.position.y) * k;
      g.position.z += (posZ - g.position.z) * k;
    }
  });

  return (
    <group ref={rootGroup}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(GLB_URL);
