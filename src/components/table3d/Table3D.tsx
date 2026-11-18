"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SeatMedia, SeatPerson } from "@/components/GdTable";
import {
  appearanceFromUserId,
  computeRingRadius,
  computeTableRadius,
  facingOriginAngle,
  focusCameraPose,
  overviewCameraPose,
  seatWorldPosition,
} from "./seat3d";

export type Table3DProps = {
  participants: SeatPerson[];
  tiles: SeatMedia[];
  selfUserId: string;
  aiEnabled?: boolean;
  aiSpeaking?: boolean;
  activeSpeakerId?: string | null;
  invitedParticipantId?: string | null;
  paused?: boolean;
  onWebGLFallback?: () => void;
};

type ActorRecord = {
  group: THREE.Group;
  mouth: THREE.Mesh;
  rightArm: THREE.Group;
  inviteRing: THREE.Mesh;
  materials: THREE.Material[];
  targetX: number;
  targetZ: number;
  targetRotY: number;
  speaking: boolean;
  invited: boolean;
  connected: boolean;
};

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return true;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function buildCharacter(userId: string): Omit<ActorRecord, "targetX" | "targetZ" | "targetRotY" | "speaking" | "invited" | "connected"> {
  const look = appearanceFromUserId(userId);
  const group = new THREE.Group();
  const materials: THREE.Material[] = [];

  const chairMat = new THREE.MeshStandardMaterial({ color: 0x5c3f2e, roughness: 0.78, metalness: 0.05 });
  const skinMat = new THREE.MeshStandardMaterial({ color: look.skinColor, roughness: 0.62, metalness: 0.02 });
  const hairMat = new THREE.MeshStandardMaterial({ color: look.hairColor, roughness: 0.72, metalness: 0.04 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: look.shirtColor, roughness: 0.58, metalness: 0.06 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.3, metalness: 0.1 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.5 });
  const inviteMat = new THREE.MeshBasicMaterial({
    color: 0xe6b75f,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  materials.push(chairMat, skinMat, hairMat, shirtMat, eyeMat, mouthMat, inviteMat);

  // Chair
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.52), chairMat);
  seat.position.set(0, 0.46, -0.04);
  seat.castShadow = true;
  group.add(seat);

  const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.62, 0.08), chairMat);
  backrest.position.set(0, 0.78, -0.26);
  backrest.castShadow = true;
  group.add(backrest);

  // Torso (capsule)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.36, 8, 14), shirtMat);
  torso.position.set(0, 0.86, 0);
  torso.castShadow = true;
  group.add(torso);

  // Left arm
  const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.28, 6, 10), shirtMat);
  leftArm.position.set(-0.28, 0.84, 0.04);
  leftArm.rotation.z = 0.22;
  group.add(leftArm);

  // Right arm (pivoted at shoulder for waving)
  const rightArm = new THREE.Group();
  rightArm.position.set(0.26, 0.98, 0.02);
  const rightArmMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.28, 6, 10), shirtMat);
  rightArmMesh.position.set(0.03, -0.14, 0.02);
  rightArm.add(rightArmMesh);
  group.add(rightArm);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 18, 16), skinMat);
  head.position.set(0, 1.48, 0);
  head.castShadow = true;
  group.add(head);

  // Hair cap
  const hairRadius = look.hairStyle === "curly" ? 0.255 : 0.242;
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(hairRadius, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.58),
    hairMat,
  );
  hair.position.set(0, 1.5, -0.01);
  group.add(hair);

  if (look.hairStyle === "bun") {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), hairMat);
    bun.position.set(0, 1.66, -0.18);
    group.add(bun);
  }

  // Eyes
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), eyeMat);
  leftEye.position.set(-0.075, 1.51, 0.205);
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), eyeMat);
  rightEye.position.set(0.075, 1.51, 0.205);
  group.add(leftEye, rightEye);

  // Mouth (animated when speaking)
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.024, 0.02), mouthMat);
  mouth.position.set(0, 1.41, 0.215);
  group.add(mouth);

  // Floor invite/speaking ring
  const inviteRing = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.48, 28), inviteMat);
  inviteRing.rotation.x = -Math.PI / 2;
  inviteRing.position.set(0, 0.02, 0);
  group.add(inviteRing);

  return { group, mouth, rightArm, inviteRing, materials };
}

export default function Table3D({
  participants,
  tiles,
  selfUserId,
  aiEnabled = true,
  aiSpeaking = false,
  activeSpeakerId = null,
  invitedParticipantId = null,
  paused = false,
  onWebGLFallback,
}: Table3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const mediaByUser = useMemo(() => new Map(tiles.map((t) => [t.identity, t])), [tiles]);
  const seated = useMemo(
    () =>
      participants
        .filter((p) => !p.removed && !p.leftAt && (p.joinedAt || mediaByUser.has(p.userId)))
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    [participants, mediaByUser],
  );

  const propsRef = useRef({
    seated,
    mediaByUser,
    selfUserId,
    aiSpeaking,
    activeSpeakerId,
    invitedParticipantId,
    paused,
  });
  propsRef.current = {
    seated,
    mediaByUser,
    selfUserId,
    aiSpeaking,
    activeSpeakerId,
    invitedParticipantId,
    paused,
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: "high-performance",
        alpha: true,
      });
    } catch {
      setWebglFailed(true);
      onWebGLFallback?.();
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(44, 16 / 10, 0.1, 100);
    const initialPose = overviewCameraPose(computeRingRadius(propsRef.current.seated.length));
    camera.position.set(...initialPose.position);
    const camTarget = new THREE.Vector3(...initialPose.target);
    camera.lookAt(camTarget);

    // Warm key + cool hemisphere fill
    const hemi = new THREE.HemisphereLight(0xeef6ff, 0x3b2f28, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff5e4, 1.35);
    key.position.set(4, 8, 5);
    key.castShadow = !isSoftwareGl;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    scene.add(key);

    // Floor disc
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x26322c, roughness: 0.92, metalness: 0.02 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 48), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Round wooden table (scaled dynamically with ringRadius)
    const tableGroup = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8f6241, roughness: 0.48, metalness: 0.06 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x5c3c27, roughness: 0.65, metalness: 0.08 });
    const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.03, 0.1, 48), woodMat);
    tableTop.position.y = 0.74;
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 0.72, 24), trimMat);
    pedestal.position.y = 0.36;
    tableGroup.add(tableTop, pedestal);
    scene.add(tableGroup);

    // Center AI orb
    const aiOrbMat = new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x187653,
      emissiveIntensity: 0.35,
      roughness: 0.25,
      metalness: 0.35,
    });
    const aiOrb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 20), aiOrbMat);
    aiOrb.position.set(0, 1.04, 0);
    scene.add(aiOrb);

    const actors = new Map<string, ActorRecord>();
    const desiredPos = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3();

    const resize = () => {
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglFailed(true);
      onWebGLFallback?.();
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    let frameId = 0;
    let lastTime = performance.now();
    let disposed = false;

    const tick = (now: number) => {
      if (disposed) return;
      if (document.hidden) {
        frameId = requestAnimationFrame(tick);
        return;
      }

      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const cur = propsRef.current;
      const count = cur.seated.length;
      const ringRadius = computeRingRadius(count);
      const tableRadius = computeTableRadius(ringRadius);
      tableTop.scale.set(tableRadius, 1, tableRadius);

      const selfIdx = cur.seated.findIndex((p) => p.userId === cur.selfUserId);
      const presentIds = new Set<string>();
      let focusWorld: { x: number; z: number } | null = null;

      cur.seated.forEach((person, idx) => {
        presentIds.add(person.userId);
        const pos = seatWorldPosition(idx, count, selfIdx >= 0 ? selfIdx : null, ringRadius);
        const rotY = facingOriginAngle(pos.x, pos.z);
        const media = cur.mediaByUser.get(person.userId);
        const speaking = Boolean(media?.speaking) || cur.activeSpeakerId === person.id;
        const invited = cur.invitedParticipantId === person.id;
        const connected = Boolean(media);

        if (speaking && !focusWorld) {
          focusWorld = pos;
        }

        let actor = actors.get(person.userId);
        if (!actor) {
          const built = buildCharacter(person.userId);
          built.group.position.set(pos.x, 0, pos.z);
          built.group.rotation.y = rotY;
          built.group.scale.setScalar(0.01);
          scene.add(built.group);
          actor = {
            ...built,
            targetX: pos.x,
            targetZ: pos.z,
            targetRotY: rotY,
            speaking,
            invited,
            connected,
          };
          actors.set(person.userId, actor);
        } else {
          actor.targetX = pos.x;
          actor.targetZ = pos.z;
          actor.targetRotY = rotY;
          actor.speaking = speaking;
          actor.invited = invited;
          actor.connected = connected;
        }

        const lambda = reducedMotion ? 30 : 6.5;
        actor.group.position.x = THREE.MathUtils.damp(actor.group.position.x, actor.targetX, lambda, dt);
        actor.group.position.z = THREE.MathUtils.damp(actor.group.position.z, actor.targetZ, lambda, dt);
        actor.group.rotation.y = THREE.MathUtils.damp(actor.group.rotation.y, actor.targetRotY, lambda, dt);

        const targetScale = actor.speaking ? 1.06 : 1;
        const nextScale = THREE.MathUtils.damp(actor.group.scale.x, targetScale, lambda, dt);
        actor.group.scale.setScalar(nextScale);

        // Mouth bobbing loop while speaking (not lip-sync)
        actor.mouth.scale.y =
          actor.speaking && !reducedMotion ? 1 + Math.abs(Math.sin(now * 0.014)) * 1.9 : 1;

        // Wave right arm when invited
        actor.rightArm.rotation.z =
          actor.invited && !reducedMotion ? 2.4 + Math.sin(now * 0.01) * 0.35 : 0;

        // Floor ring indicator
        const ringMat = actor.inviteRing.material as THREE.MeshBasicMaterial;
        ringMat.opacity = actor.speaking
          ? 0.85
          : actor.invited
            ? reducedMotion
              ? 0.65
              : 0.4 + 0.35 * Math.sin(now * 0.006)
            : 0;
        ringMat.color.setHex(actor.speaking ? 0x34d399 : 0xe6b75f);
      });

      // Remove departed participants
      for (const [uid, actor] of actors.entries()) {
        if (!presentIds.has(uid)) {
          scene.remove(actor.group);
          for (const mat of actor.materials) mat.dispose();
          actors.delete(uid);
        }
      }

      // AI orb pulse
      aiOrbMat.emissiveIntensity = cur.aiSpeaking
        ? reducedMotion
          ? 1.1
          : 0.8 + 0.45 * Math.sin(now * 0.008)
        : 0.25;

      // Camera glide
      const pose = focusWorld
        ? focusCameraPose((focusWorld as { x: number; z: number }).x, (focusWorld as { x: number; z: number }).z)
        : overviewCameraPose(ringRadius);
      desiredPos.set(...pose.position);
      desiredTarget.set(...pose.target);

      const camLambda = reducedMotion ? 40 : 4.2;
      camera.position.x = THREE.MathUtils.damp(camera.position.x, desiredPos.x, camLambda, dt);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, desiredPos.y, camLambda, dt);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, desiredPos.z, camLambda, dt);
      camTarget.x = THREE.MathUtils.damp(camTarget.x, desiredTarget.x, camLambda, dt);
      camTarget.y = THREE.MathUtils.damp(camTarget.y, desiredTarget.y, camLambda, dt);
      camTarget.z = THREE.MathUtils.damp(camTarget.z, desiredTarget.z, camLambda, dt);
      camera.lookAt(camTarget);

      renderer.render(scene, camera);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      ro.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      for (const actor of actors.values()) {
        for (const mat of actor.materials) mat.dispose();
      }
      actors.clear();
      floorMat.dispose();
      woodMat.dispose();
      trimMat.dispose();
      aiOrbMat.dispose();
      envTex.dispose();
      renderer.dispose();
      container.innerHTML = "";
    };
  }, [onWebGLFallback]);

  if (webglFailed) {
    return (
      <div className="card text-sm text-muted">
        WebGL is unavailable on this browser — switch back to the 2D Round table view.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-muted">
          3D Round Table ({seated.length} seated)
        </span>
        {aiEnabled && (
          <span className={aiSpeaking ? "font-medium text-accent" : "text-muted"}>
            {paused ? "Meeting paused" : aiSpeaking ? "AI Moderator Speaking · Mics Locked" : "AI Moderator Listening"}
          </span>
        )}
      </div>

      <div className="relative mx-auto aspect-[16/10] min-h-[360px] max-h-[70vh] w-full overflow-hidden rounded-lg border border-line bg-bg">
        <div ref={mountRef} aria-hidden className="h-full w-full" />
      </div>

      {/* Accessible live participant summary */}
      <ul className="sr-only" role="group" aria-label="Round table (3D)">
        {seated.map((p) => {
          const media = mediaByUser.get(p.userId);
          return (
            <li key={p.id}>
              {p.name}
              {p.userId === selfUserId ? " (you)" : ""}
              {p.isHost ? " · host" : ""}
              {media?.speaking || activeSpeakerId === p.id ? " — speaking" : ""}
              {media?.micEnabled === false ? " — muted" : ""}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
