import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SPARROW_ROTOR_CENTERS, splitSparrowParts } from './sparrowGeometry';
import type { RenderMotion } from './motionSmoothing';

interface Props {
  position: [number, number, number];
  scale: number;
  renderMotion: { current: RenderMotion };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function SparrowModel({ position, scale, renderMotion }: Props) {
  const { scene } = useGLTF('/models/sparrow.glb');
  const parts = useMemo(() => splitSparrowParts(scene), [scene]);
  const group = useRef<THREE.Group>(null);
  const visual = useRef<THREE.Group>(null);
  const rotors = useRef<(THREE.Group | null)[]>([]);
  const blur = useRef<(THREE.Mesh | null)[]>([]);
  const motion = useRef({ mode: renderMotion.current.mode, changedAt: 0, power: 0, heading: renderMotion.current.heading });

  useFrame(({ clock }, delta) => {
    if (!group.current || !visual.current) return;
    const current = renderMotion.current;
    const currentMode = current.mode;
    if (motion.current.mode !== currentMode) {
      motion.current.mode = currentMode;
      motion.current.changedAt = clock.elapsedTime;
    }
    const stopped = currentMode === 'disarmed' || (currentMode === 'landing' && current.altitudeM < 0.2);
    const targetPower = stopped
      ? 0
      : currentMode === 'armed' || currentMode === 'takeoff'
        ? clamp((clock.elapsedTime - motion.current.changedAt) / 1.8, 0, 1)
        : 1;
    motion.current.power = THREE.MathUtils.damp(motion.current.power, targetPower, 5, delta);
    group.current.position.copy(current.position);
    const speed = current.speedKmh;
    const speedFactor = clamp(speed / 40, 0, 1);
    const heading = current.heading;
    const headingDelta = THREE.MathUtils.euclideanModulo(heading - motion.current.heading + 180, 360) - 180;
    motion.current.heading = heading;
    visual.current.rotation.x = THREE.MathUtils.damp(visual.current.rotation.x, -speedFactor * 0.16, 5, delta);
    visual.current.rotation.z = THREE.MathUtils.damp(visual.current.rotation.z, -clamp(headingDelta / 45, -1, 1) * 0.12, 5, delta);
    visual.current.position.y = Math.sin(clock.elapsedTime * 1.5) * (speed < 1 ? 0.02 : 0.008);
    rotors.current.forEach((rotor, index) => {
      if (rotor) rotor.rotation.y += delta * (4 + motion.current.power * 52);
      const material = blur.current[index]?.material;
      if (material instanceof THREE.MeshStandardMaterial) material.opacity = motion.current.power * 0.24;
    });
  });

  return (
    <group ref={group} position={position} scale={scale * parts.scale}>
      <group ref={visual}>
        <primitive object={parts.body} />
        {parts.fanGeometry.map((geometry, index) => (
          <group key={index} ref={(node) => { rotors.current[index] = node; }} position={SPARROW_ROTOR_CENTERS[index]}>
            <mesh geometry={parts.guardGeometry[index]} material-color="#b9c1c8" material-transparent material-opacity={0.45} />
            <mesh geometry={geometry} material-color="#35404a" />
            <mesh ref={(node) => { blur.current[index] = node; }} rotation-x={-Math.PI / 2}>
              <circleGeometry args={[0.2, 24]} />
              <meshStandardMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

useGLTF.preload('/models/sparrow.glb');
