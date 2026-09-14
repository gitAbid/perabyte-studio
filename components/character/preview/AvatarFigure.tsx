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
  standing: {
    bones: {
      upperarm_l: [-0.06, 0, 0.05], upperarm_r: [-0.06, 0, -0.05],
    },
  },
  portrait: { bones: { head: [0, 0.12, 0.05] } },
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
      upperarm_l: [0.45, 0, 0.08], upperarm_r: [-0.45, 0, -0.08],
      lowerarm_l: [-0.5, 0, 0], lowerarm_r: [-0.5, 0, 0],
      spine_02: [0, 0.06, 0],
    },
  },
  action: {
    bones: {
      upperarm_l: [-1.9, 0, 0.5], upperarm_r: [-1.9, 0, -0.5],
      lowerarm_l: [-0.7, 0, 0], lowerarm_r: [-0.7, 0, 0],
      thigh_l: [-0.35, 0, 0.18], thigh_r: [0, 0, -0.18],
      calf_l: [0.35, 0, 0], spine_02: [-0.1, 0, 0],
    },
  },
  relaxed: {
    bones: {
      upperarm_l: [0, 0, 0.25], upperarm_r: [0, 0, -0.25],
      lowerarm_l: [-1.15, 0.35, 0], lowerarm_r: [-1.15, -0.35, 0],
      spine_02: [0.05, 0, 0], head: [0.04, 0, 0],
    },
  },
  dynamic: {
    bones: {
      upperarm_r: [-2.5, 0, -0.4], lowerarm_r: [-0.3, 0, 0],
      upperarm_l: [0, 0, 0.9], lowerarm_l: [-1.0, 0, 0],
      thigh_l: [-0.5, 0, 0], calf_l: [0.4, 0, 0],
      spine_01: [0, -0.18, 0], head: [0, 0.1, 0],
    },
  },
  dance: {
    bones: {
      upperarm_l: [-2.6, 0, 0.6], upperarm_r: [-2.6, 0, -0.6],
      lowerarm_l: [-0.5, 0, 0.6], lowerarm_r: [-0.5, 0, -0.6],
      thigh_r: [0.35, 0, 0], calf_r: [0.3, 0, 0],
      spine_02: [-0.08, 0, 0], head: [-0.1, 0, 0],
    },
  },
  lying: {
    bones: { upperarm_l: [0, 0, 0.2], upperarm_r: [0, 0, -0.2] },
    root: { rotX: -Math.PI / 2, posY: 0.32, posZ: 0.55 },
  },
  arched: {
    bones: {
      spine_01: [0.22, 0, 0], spine_02: [0.22, 0, 0], spine_03: [0.18, 0, 0],
      head: [-0.35, 0, 0],
      upperarm_l: [0.4, 0, 0.3], upperarm_r: [0.4, 0, -0.3],
      thigh_l: [0.1, 0, 0.08], thigh_r: [0.1, 0, -0.08],
    },
  },
  allfours: {
    bones: {
      thigh_l: [-1.35, 0, 0.1], calf_l: [1.3, 0, 0],
      thigh_r: [-1.35, 0, -0.1], calf_r: [1.3, 0, 0],
      upperarm_l: [-1.5, 0, 0.15], upperarm_r: [-1.5, 0, -0.15],
      lowerarm_l: [-0.2, 0, 0], lowerarm_r: [-0.2, 0, 0],
      spine_01: [0.35, 0, 0], head: [-0.5, 0, 0],
    },
    root: { rotX: -1.35, posY: 0.28, posZ: 0.4 },
  },
  spreading: {
    bones: {
      upperarm_l: [0, 0, 1.35], upperarm_r: [0, 0, -1.35],
      thigh_l: [0, 0, 0.32], thigh_r: [0, 0, -0.32],
      spine_02: [-0.06, 0, 0],
    },
  },
  kneeling: {
    bones: {
      thigh_l: [0.45, 0, 0.06], calf_l: [1.75, 0, 0],
      thigh_r: [0.45, 0, -0.06], calf_r: [1.75, 0, 0],
      upperarm_l: [-0.25, 0, 0.12], lowerarm_l: [-0.35, 0, 0],
      upperarm_r: [-0.25, 0, -0.12], lowerarm_r: [-0.35, 0, 0],
      head: [0.18, 0, 0],
    },
    root: { posY: -0.42 },
  },
  dominant: {
    bones: {
      upperarm_l: [0, 0, 0.4], upperarm_r: [0, 0, -0.4],
      lowerarm_l: [-1.3, 0.4, 0], lowerarm_r: [-1.3, -0.4, 0],
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

export function AvatarFigure({ params }: { params: AvatarParams }) {
  const { scene } = useGLTF(GLB_URL);
  const eyeTexture = useTexture(params.eyeTexture);
  eyeTexture.colorSpace = THREE.SRGBColorSpace;

  const model = useMemo(() => skeletonClone(scene), [scene]);

  const refs = useMemo(() => {
    const body = model.getObjectByName("Body") as THREE.Mesh | undefined;
    const bones = new Map<string, THREE.Bone>();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
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
    return { body, bones, meshes, morphIndex };
  }, [model]);

  /* -------- visibility: hair / garment / shoes / hat -------- */
  useEffect(() => {
    for (const mesh of refs.meshes.values()) {
      const name = mesh.name;
      if (name.startsWith("Hair__")) mesh.visible = name === params.hairMesh;
      else if (name.startsWith("Clothes__")) {
        if (name === "Clothes__shoes01") mesh.visible = params.shoes;
        else if (name === "Clothes__fedora01") mesh.visible = params.hat;
        else mesh.visible = name === params.garmentMesh;
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
      "head_z": Math.sin(t * 0.55) * 0.018,
    };

    for (const name of POSE_BONE_NAMES) {
      const bone = refs.bones.get(name);
      if (!bone) continue;
      const target = pose.bones[name] ?? [0, 0, 0];
      let [rx, ry, rz] = target;
      if (name === "spine_02") rx += idle.spine_02;
      if (name === "head") {
        rx += idle.head;
        rz += idle.head_z;
      }
      bone.rotation.x += (rx - bone.rotation.x) * k;
      bone.rotation.y += (ry - bone.rotation.y) * k;
      bone.rotation.z += (rz - bone.rotation.z) * k;
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
