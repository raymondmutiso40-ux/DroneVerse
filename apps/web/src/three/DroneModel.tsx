import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { DroneSpec } from '@droneverse/shared';
import { rotorLayout } from '../lib/droneShape';
import { SparrowModel } from './SparrowModel';
import { getDroneVisualConfig } from './droneVisualConfig';
import { type RenderMotion } from './motionSmoothing';

interface Props {
  spec: DroneSpec;
  position?: [number, number, number];
  scale?: number;
  renderMotion: { current: RenderMotion };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function DroneModel({ spec, position = [0, 3, 0], scale = 1, renderMotion }: Props) {
  const visual = getDroneVisualConfig(spec);
  if (spec.id === 'sparrow-s4') {
    return <SparrowModel position={position} scale={scale * visual.scale} renderMotion={renderMotion} />;
  }
  return (
    <ProceduralDrone
      spec={spec}
      position={position}
      scale={scale * visual.scale}
      renderMotion={renderMotion}
      shellColor={visual.shell}
      accentColor={visual.accent}
    />
  );
}

interface ProceduralProps extends Omit<Props, 'scale'> {
  scale: number;
  shellColor: string;
  accentColor: string;
}

function ProceduralDrone({
  spec,
  position = [0, 3, 0],
  scale,
  renderMotion,
  shellColor,
  accentColor,
}: ProceduralProps) {
  const group = useRef<THREE.Group>(null);
  const visual = useRef<THREE.Group>(null);
  const rotors = useRef<(THREE.Group | null)[]>([]);
  const blurDiscs = useRef<(THREE.Mesh | null)[]>([]);
  const motion = useRef({ mode: renderMotion.current.mode, changedAt: 0, power: 0, heading: renderMotion.current.heading });
  const previousVelocity = useRef(new THREE.Vector3());
  const acceleration = useRef(new THREE.Vector3());
  const rotorAngles = useMemo(
    () => rotorLayout(spec.rotors).map((rotor) => ((Math.atan2(rotor.x - 50, 50 - rotor.y) * 180) / Math.PI) + 360),
    [spec.rotors],
  );

  useFrame(({ clock }, delta) => {
    if (!group.current || !visual.current) return;
    const current = renderMotion.current;
    const mode = current.mode;
    if (motion.current.mode !== mode) {
      motion.current.mode = mode;
      motion.current.changedAt = clock.elapsedTime;
    }
    const stopped = mode === 'disarmed' || (mode === 'landing' && current.altitudeM < 0.2);
    const targetPower = stopped
      ? 0
      : mode === 'armed' || mode === 'takeoff'
        ? clamp((clock.elapsedTime - motion.current.changedAt) / 1.8, 0, 1)
        : 1;
    motion.current.power = THREE.MathUtils.damp(motion.current.power, targetPower, 5, delta);

    acceleration.current
        .copy(current.velocity)
        .sub(previousVelocity.current)
        .multiplyScalar(1 / Math.max(delta, 1 / 120));
    previousVelocity.current.copy(current.velocity);
    group.current.position.copy(current.position);
    const speedFactor = clamp(current.speedKmh / 40, 0, 1);
    const heading = current.heading;
    const headingDelta = THREE.MathUtils.euclideanModulo(heading - motion.current.heading + 180, 360) - 180;
    motion.current.heading = heading;
    const pitchLean = clamp(-acceleration.current.z * 0.025 - speedFactor * 0.04, -0.18, 0.18);
    const rollLean = clamp(acceleration.current.x * 0.025, -0.14, 0.14);
    visual.current.rotation.x = THREE.MathUtils.damp(visual.current.rotation.x, pitchLean, 5, delta);
    visual.current.rotation.y = THREE.MathUtils.damp(visual.current.rotation.y, THREE.MathUtils.degToRad(heading), 5, delta);
    visual.current.rotation.z = THREE.MathUtils.damp(
      visual.current.rotation.z,
      rollLean - clamp(headingDelta / 45, -1, 1) * 0.12,
      5,
      delta,
    );
    visual.current.position.y = Math.sin(clock.elapsedTime * 1.5) * (speedFactor < 0.03 ? 0.02 : 0.008);

    rotors.current.forEach((rotor, index) => {
      if (rotor) rotor.rotation.y += delta * (4 + motion.current.power * 52) * (index % 2 === 0 ? 1 : -1);
      const material = blurDiscs.current[index]?.material;
      if (material instanceof THREE.MeshStandardMaterial) material.opacity = motion.current.power * 0.25;
    });
  });

  return (
    <group ref={group} position={position} scale={scale}>
      <group ref={visual} scale={0.5}>
        <Body shellColor={shellColor} accentColor={accentColor} />
        {rotorAngles.map((angle, index) => (
          <RotorArm
            key={angle}
            angle={angle}
            index={index}
            accentColor={accentColor}
            rotorRef={(node) => { rotors.current[index] = node; }}
            blurRef={(node) => { blurDiscs.current[index] = node; }}
          />
        ))}
        <Skids accentColor={accentColor} />
      </group>
    </group>
  );
}

function Body({ shellColor, accentColor }: { shellColor: string; accentColor: string }) {
  return (
    <group name="Body">
      <mesh name="Shell" position-y={0.2} scale={[1, 0.55, 1]} castShadow>
        <sphereGeometry args={[1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={shellColor} roughness={0.3} metalness={0.08} />
      </mesh>
      <mesh name="ShellBadge" position-y={0.74} rotation-x={-Math.PI / 2}>
        <cylinderGeometry args={[0.22, 0.22, 0.035, 24]} />
        <meshStandardMaterial color={accentColor} roughness={0.35} />
      </mesh>
      <mesh name="Underbody" position-y={-0.1} scale={[1, 0.42, 1]}>
        <cylinderGeometry args={[0.95, 0.88, 0.35, 24]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.55} />
      </mesh>
      <group name="GimbalPod" position={[0, -0.55, 0.6]}>
        <mesh>
          <sphereGeometry args={[0.25, 16, 12]} />
          <meshStandardMaterial color="#20252b" roughness={0.45} />
        </mesh>
        <mesh position={[0, 0, 0.21]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.09, 0.09, 0.035, 16]} />
          <meshStandardMaterial color="#11161a" metalness={0.35} />
        </mesh>
      </group>
    </group>
  );
}

function RotorArm({
  angle,
  index,
  accentColor,
  rotorRef,
  blurRef,
}: {
  angle: number;
  index: number;
  accentColor: string;
  rotorRef: (node: THREE.Group | null) => void;
  blurRef: (node: THREE.Mesh | null) => void;
}) {
  const radians = (angle * Math.PI) / 180;
  const isFront = Math.cos(radians) > 0.35;
  const isRear = Math.cos(radians) < -0.35;
  return (
    <group name={`Arm-${index + 1}`} rotation-y={radians}>
      <mesh name="ArmBar" position-x={1.2} rotation-z={Math.PI / 2} castShadow>
        <cylinderGeometry args={[0.07, 0.07, 2.4, 8]} />
        <meshStandardMaterial color="#20252b" roughness={0.6} />
      </mesh>
      <group name="Motor" position-x={2.4}>
        <mesh>
          <cylinderGeometry args={[0.2, 0.2, 0.3, 12]} />
          <meshStandardMaterial color="#20252b" roughness={0.5} />
        </mesh>
        <mesh name="AccentRing" position-y={0.14}>
          <torusGeometry args={[0.2, 0.03, 8, 16]} />
          <meshStandardMaterial color={accentColor} roughness={0.35} />
        </mesh>
        <mesh name="NavLight" position={[0, 0.05, isFront ? 0.12 : -0.12]}>
          <sphereGeometry args={[0.045, 8, 8]} />
          <meshStandardMaterial
            color={isFront ? '#ef4444' : isRear ? '#22c55e' : '#f8c94a'}
            emissive={isFront ? '#ef4444' : isRear ? '#22c55e' : '#f8c94a'}
            emissiveIntensity={1.6}
          />
        </mesh>
        <group name="Rotor" ref={rotorRef} position-y={0.32}>
          <mesh name="Hub">
            <cylinderGeometry args={[0.07, 0.07, 0.08, 10]} />
            <meshStandardMaterial color="#15191d" />
          </mesh>
          <mesh name="Blade-1">
            <boxGeometry args={[0.9, 0.02, 0.12]} />
            <meshStandardMaterial color="#172126" transparent opacity={0.85} />
          </mesh>
          <mesh name="Blade-2">
            <boxGeometry args={[0.12, 0.02, 0.9]} />
            <meshStandardMaterial color="#172126" transparent opacity={0.85} />
          </mesh>
          <mesh name="BlurDisc" ref={blurRef} rotation-x={-Math.PI / 2}>
            <circleGeometry args={[0.45, 24]} />
            <meshStandardMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function Skids({ accentColor }: { accentColor: string }) {
  const curves = useMemo(
    () =>
      [-0.55, 0.55].map(
        (x) =>
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(x, -0.45, -0.7),
            new THREE.Vector3(x, -1, -0.55),
            new THREE.Vector3(x, -1, 0.55),
            new THREE.Vector3(x, -0.45, 0.7),
          ]),
      ),
    [],
  );
  return (
    <group name="Skids">
      {curves.map((curve, index) => (
        <group key={index} name={`Skid-${index + 1}`}>
          <mesh>
            <tubeGeometry args={[curve, 16, 0.06, 8, false]} />
            <meshStandardMaterial color="#20252b" roughness={0.6} />
          </mesh>
          {[-0.7, 0.7].map((z) => (
            <mesh key={z} position={[-0.0, -0.99, z]}>
              <cylinderGeometry args={[0.09, 0.09, 0.12, 8]} />
              <meshStandardMaterial color={accentColor} roughness={0.4} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

export function rotorPositions(rotors: DroneSpec['rotors']) {
  return rotorLayout(rotors).map((rotor) => [(rotor.x - 50) / 8, (rotor.y - 50) / 8] as const);
}
