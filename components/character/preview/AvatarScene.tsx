"use client";

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { AvatarParams, LookLightingId } from "@/lib/avatarParams";
import { AvatarFigure } from "./AvatarFigure";

/* Lighting rigs per look preset — each reads as the named photography
   style so the look selection is visible in the preview itself. */
interface LightingRig {
  key: { pos: [number, number, number]; intensity: number; color: string };
  fill: { intensity: number; color: string };
  rim: { pos: [number, number, number]; intensity: number; color: string };
  ambient: number;
  background: string;
}

const LIGHTING: Record<LookLightingId, LightingRig> = {
  studio: {
    key: { pos: [-1.6, 2.6, 2.2], intensity: 2.6, color: "#ffffff" },
    fill: { intensity: 0.7, color: "#dfe6f0" },
    rim: { pos: [1.8, 2.2, -1.6], intensity: 1.4, color: "#ffffff" },
    ambient: 0.45,
    background: "#e9edf3",
  },
  editorial: {
    key: { pos: [-2.2, 2.8, 1.8], intensity: 3.2, color: "#ffffff" },
    fill: { intensity: 0.28, color: "#c8d2e0" },
    rim: { pos: [2.4, 1.6, -1.8], intensity: 1.8, color: "#f4f0ff" },
    ambient: 0.22,
    background: "#dfe3ea",
  },
  natural: {
    key: { pos: [1.4, 2.4, 2.6], intensity: 2.2, color: "#fff6e8" },
    fill: { intensity: 0.85, color: "#e6ecf5" },
    rim: { pos: [-2, 2, -1.4], intensity: 0.9, color: "#ffffff" },
    ambient: 0.55,
    background: "#eef1f5",
  },
  golden: {
    key: { pos: [-2.6, 1.2, 1.6], intensity: 3, color: "#ffd9a0" },
    fill: { intensity: 0.5, color: "#cfd8e8" },
    rim: { pos: [2.2, 2.4, -1.6], intensity: 2.2, color: "#ffb877" },
    ambient: 0.35,
    background: "#f3e4d3",
  },
  urban: {
    key: { pos: [1.8, 2.8, 1.4], intensity: 2.4, color: "#e8f0ff" },
    fill: { intensity: 0.6, color: "#9fb4d8" },
    rim: { pos: [-2.2, 1.4, -1.8], intensity: 1.6, color: "#7ea0ff" },
    ambient: 0.4,
    background: "#dee4ee",
  },
  moody: {
    key: { pos: [0.4, 3.2, 0.8], intensity: 2.8, color: "#dfe8ff" },
    fill: { intensity: 0.15, color: "#8a94b8" },
    rim: { pos: [-2, 1.2, -2], intensity: 1.2, color: "#aac4ff" },
    ambient: 0.12,
    background: "#2b313d",
  },
};

function Rig({ look }: { look: LookLightingId }) {
  const rig = LIGHTING[look] ?? LIGHTING.studio;
  return (
    <>
      <color attach="background" args={[rig.background]} />
      <ambientLight intensity={rig.ambient} color={rig.fill.color} />
      <directionalLight
        position={rig.key.pos}
        intensity={rig.key.intensity}
        color={rig.key.color}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-2}
        shadow-camera-right={2}
        shadow-camera-top={2.5}
        shadow-camera-bottom={-0.5}
        shadow-camera-near={0.5}
        shadow-camera-far={10}
      />
      <directionalLight position={[-rig.key.pos[0], 1.5, 2]} intensity={rig.fill.intensity} color={rig.fill.color} />
      <directionalLight position={rig.rim.pos} intensity={rig.rim.intensity} color={rig.rim.color} />
    </>
  );
}

export function AvatarScene({ params }: { params: AvatarParams }) {
  return (
    <Canvas
      camera={{ position: [0.35, 1.05, 2.7], fov: 30 }}
      dpr={[1, 2]}
      shadows
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      fallback={
        <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted">
          3D preview needs WebGL — showing configuration summary instead.
        </div>
      }
    >
      <Rig look={params.lighting} />
      <Suspense fallback={null}>
        <AvatarFigure params={params} />
      </Suspense>
      <ContactShadows
        position={[0, 0.001, 0]}
        opacity={0.55}
        scale={3}
        blur={2.4}
        far={1.6}
        resolution={512}
        color="#253044"
      />
      <OrbitControls
        target={[0, 0.92, 0]}
        enablePan={false}
        minDistance={0.9}
        maxDistance={5}
        minPolarAngle={0.25}
        maxPolarAngle={Math.PI / 2 + 0.15}
        enableDamping
        dampingFactor={0.08}
      />
    </Canvas>
  );
}
