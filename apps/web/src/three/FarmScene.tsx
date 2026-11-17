import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { damp, type DroneSpec, type Field } from '@droneverse/shared';
import { DroneModel } from './DroneModel';
import { getHelipadPosition, pointInRing, projectFields, type Point2, type ProjectedField } from './coordinates';
import { FARM_SCENE_CONFIG } from './sceneConfig';
import { getRenderBufferStats, getRenderTelemetry } from './telemetryRenderStore';
import type { RenderMotion } from './motionSmoothing';

interface Props {
  fields: Field[];
  drone: DroneSpec | null;
  view: 'follow' | 'camera' | 'map';
}

function FieldMesh({ field }: { field: ProjectedField }) {
  const shape = useMemo(() => {
    const [outer, ...holes] = field.rings;
    const result = new THREE.Shape((outer ?? []).map(({ x, z }) => new THREE.Vector2(x, -z)));
    for (const hole of holes) {
      result.holes.push(new THREE.Path(hole.map(({ x, z }) => new THREE.Vector2(x, -z))));
    }
    return result;
  }, [field.rings]);
  const crop = field.field.crop.toLowerCase();
  const fieldColor = crop.includes('wheat')
    ? FARM_SCENE_CONFIG.colors.fieldWheat
    : FARM_SCENE_CONFIG.colors.fieldGreen;
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={FARM_SCENE_CONFIG.fieldHeight}>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color={fieldColor} side={THREE.DoubleSide} />
    </mesh>
  );
}

function CropInstances({ field, helipadPosition }: { field: ProjectedField; helipadPosition: Point2 }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const crop = field.field.crop.toLowerCase();
  const cropKind = crop.includes('wheat') ? 'wheat' : crop.includes('corn') || crop.includes('maize') ? 'corn' : 'low';
  const positions = useMemo(() => {
    const points: Point2[] = [];
    for (let x = field.minX + 0.7; x < field.maxX; x += FARM_SCENE_CONFIG.cropRowSpacing) {
      for (let z = field.minZ + 0.7; z < field.maxZ; z += FARM_SCENE_CONFIG.cropPlantSpacing) {
        const point = { x, z };
        const clearOfHelipad =
          Math.hypot(point.x - helipadPosition.x, point.z - helipadPosition.z) >
          FARM_SCENE_CONFIG.helipadRadius + FARM_SCENE_CONFIG.helipadMargin;
        if (clearOfHelipad && pointInRing(point, field.rings[0] ?? [])) points.push(point);
        if (points.length >= FARM_SCENE_CONFIG.maxCropInstancesPerField) return points;
      }
    }
    return points;
  }, [field]);
  const geometry = useMemo(() => {
    if (cropKind === 'wheat') return new THREE.BoxGeometry(0.025, 0.25, 0.025);
    if (cropKind === 'corn') return new THREE.BoxGeometry(0.05, 0.35, 0.05);
    return new THREE.BoxGeometry(0.05, 0.18, 0.05);
  }, [cropKind]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color:
          cropKind === 'wheat'
            ? FARM_SCENE_CONFIG.colors.wheat
            : cropKind === 'corn'
              ? FARM_SCENE_CONFIG.colors.corn
              : FARM_SCENE_CONFIG.colors.crop,
      }),
    [cropKind],
  );

  useLayoutEffect(() => {
    if (!mesh.current) return;
    const matrix = new THREE.Matrix4();
    positions.forEach(({ x, z }, index) => {
      const height = cropKind === 'wheat' ? 0.13 : cropKind === 'corn' ? 0.18 : 0.09;
      matrix.makeTranslation(x, height, z);
      mesh.current!.setMatrixAt(index, matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  }, [cropKind, positions]);

  return <instancedMesh ref={mesh} args={[geometry, material, positions.length]} />;
}

function Trees({ layout }: { layout: ReturnType<typeof projectFields> }) {
  const positions = useMemo(() => {
    const result: Point2[] = [];
    const width = Math.max(layout.maxX - layout.minX, 20);
    const depth = Math.max(layout.maxZ - layout.minZ, 20);
    const clusters = [
      { x: layout.minX - 5, z: layout.minZ - 4 },
      { x: layout.maxX + 5, z: layout.minZ + depth * 0.45 },
      { x: layout.minX + width * 0.55, z: layout.maxZ + 5 },
      { x: layout.maxX - width * 0.25, z: layout.maxZ + 7 },
    ];
    clusters.forEach((cluster, clusterIndex) => {
      for (let index = 0; index < 7; index += 1) {
        const angle = ((index * 137.5 + clusterIndex * 29) * Math.PI) / 180;
        const radius = 1.5 + (index % 3) * 1.1;
        result.push({
          x: cluster.x + Math.cos(angle) * radius,
          z: cluster.z + Math.sin(angle) * radius,
        });
      }
    });
    return result;
  }, [layout]);
  const roundPositions = useMemo(() => positions.filter((_, index) => index % 3 !== 0), [positions]);
  const coniferPositions = useMemo(() => positions.filter((_, index) => index % 3 === 0), [positions]);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const canopies = useRef<THREE.InstancedMesh>(null);
  const conifers = useRef<THREE.InstancedMesh>(null);
  const trunkGeometry = useMemo(() => new THREE.CylinderGeometry(0.16, 0.22, 1.2, 6), []);
  const canopyGeometry = useMemo(() => new THREE.IcosahedronGeometry(0.8, 1), []);
  const coniferGeometry = useMemo(() => new THREE.ConeGeometry(0.75, 1.8, 8), []);
  const trunkMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: FARM_SCENE_CONFIG.colors.trunk }),
    [],
  );
  const canopyMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: FARM_SCENE_CONFIG.colors.canopy }),
    [],
  );
  const coniferMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: FARM_SCENE_CONFIG.colors.conifer }),
    [],
  );
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    positions.forEach(({ x, z }, index) => {
      const scale = 0.8 + (index % 4) * 0.1;
      matrix.compose(
        new THREE.Vector3(x, 0.6, z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale),
      );
      trunks.current?.setMatrixAt(index, matrix);
    });
    roundPositions.forEach(({ x, z }, index) => {
      const scale = 0.8 + (index % 4) * 0.1;
      matrix.compose(
        new THREE.Vector3(x, 1.55 * scale, z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale),
      );
      canopies.current?.setMatrixAt(index, matrix);
    });
    coniferPositions.forEach(({ x, z }, index) => {
      const scale = 0.8 + (index % 4) * 0.1;
      matrix.compose(
        new THREE.Vector3(x, 1.55 * scale, z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale),
      );
      conifers.current?.setMatrixAt(index, matrix);
    });
    if (trunks.current) trunks.current.instanceMatrix.needsUpdate = true;
    if (canopies.current) canopies.current.instanceMatrix.needsUpdate = true;
    if (conifers.current) conifers.current.instanceMatrix.needsUpdate = true;
  }, [coniferPositions, positions, roundPositions]);
  return (
    <>
      <instancedMesh ref={trunks} args={[trunkGeometry, trunkMaterial, positions.length]} />
      <instancedMesh ref={canopies} args={[canopyGeometry, canopyMaterial, roundPositions.length]} />
      <instancedMesh ref={conifers} args={[coniferGeometry, coniferMaterial, coniferPositions.length]} />
    </>
  );
}

function FarmPaths({ layout }: { layout: ReturnType<typeof projectFields> }) {
  if (!layout.fields.length) return null;
  const centerX = (layout.minX + layout.maxX) / 2;
  const centerZ = (layout.minZ + layout.maxZ) / 2;
  const width = Math.max(layout.maxX - layout.minX + 24, 40);
  const depth = Math.max(layout.maxZ - layout.minZ + 24, 40);
  return (
    <group position-y={0.005}>
      <mesh rotation-x={-Math.PI / 2} position={[centerX, 0, centerZ]}>
        <planeGeometry args={[width, 2.4]} />
        <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.dirt} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[centerX, 0, centerZ]}>
        <planeGeometry args={[2.4, depth]} />
        <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.dirt} />
      </mesh>
    </group>
  );
}

function IssuePatches({ layout }: { layout: ReturnType<typeof projectFields> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const patches = useMemo(
    () =>
      layout.fields.flatMap((field, index) => {
        const center = {
          x: (field.minX + field.maxX) / 2 + (index % 2 ? 1.4 : -1.2),
          z: (field.minZ + field.maxZ) / 2 + (index % 3) - 1,
        };
        return [
          center,
          { x: center.x + 1.8, z: center.z - 1.1 },
          { x: center.x - 1.5, z: center.z + 1.4 },
        ].filter((point) => pointInRing(point, field.rings[0] ?? [])).slice(0, 2);
      }),
    [layout.fields],
  );
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    patches.forEach(({ x, z }, index) => {
      const size = index % 2 ? 0.7 : 1;
      matrix.compose(
        new THREE.Vector3(x, FARM_SCENE_CONFIG.fieldHeight + 0.01, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
        new THREE.Vector3(size, size, size),
      );
      mesh.current?.setMatrixAt(index, matrix);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
  }, [patches]);
  return (
    <instancedMesh ref={mesh} args={[new THREE.CircleGeometry(1, 24), new THREE.MeshStandardMaterial({
      color: FARM_SCENE_CONFIG.colors.issue,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }), patches.length]} />
  );
}

function Pond({ layout }: { layout: ReturnType<typeof projectFields> }) {
  const x = layout.fields.length ? layout.maxX + 6 : 8;
  const z = layout.fields.length ? layout.minZ - 5 : -8;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[x, 0.02, z]} scale={[1.5, 0.8, 1]}>
      <circleGeometry args={[2.5, 32]} />
      <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.pond} roughness={0.15} metalness={0.1} />
    </mesh>
  );
}

function Windsock({ position }: { position: Point2 }) {
  return (
    <group position={[position.x + 4, 0, position.z + 1]}>
      <mesh position-y={1.2}>
        <cylinderGeometry args={[0.035, 0.05, 2.4, 8]} />
        <meshStandardMaterial color="#dce4e5" />
      </mesh>
      <mesh position={[0, 2.2, 0]} rotation-z={-Math.PI / 2}>
        <coneGeometry args={[0.28, 1, 8, 1, true]} />
        <meshStandardMaterial color="#f07f2f" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-0.22, 2.2, 0]} rotation-z={-Math.PI / 2}>
        <cylinderGeometry args={[0.18, 0.18, 0.2, 8]} />
        <meshStandardMaterial color="#f6f0dc" />
      </mesh>
    </group>
  );
}

function Hills() {
  const positions = useMemo(
    () => [
      [-130, 12, -95],
      [-70, 9, -110],
      [0, 14, -125],
      [75, 10, -110],
      [140, 13, -95],
    ] as const,
    [],
  );
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(32, 16, 8), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: FARM_SCENE_CONFIG.colors.hills, fog: true }), []);
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    positions.forEach(([x, y, z], index) => {
      matrix.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1.5 + (index % 2) * 0.35, 0.45, 0.8),
      );
      mesh.current?.setMatrixAt(index, matrix);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
  }, [positions]);
  return <instancedMesh ref={mesh} args={[geometry, material, positions.length]} />;
}

function Sky() {
  return (
    <>
      <mesh>
        <sphereGeometry args={[190, 32, 16]} />
        <shaderMaterial
          uniforms={{
            top: { value: new THREE.Color(FARM_SCENE_CONFIG.colors.skyTop) },
            horizon: { value: new THREE.Color(FARM_SCENE_CONFIG.colors.skyHorizon) },
          }}
          vertexShader="varying float height; void main() { height = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }"
          fragmentShader="uniform vec3 top; uniform vec3 horizon; varying float height; void main() { gl_FragColor = vec4(mix(horizon, top, smoothstep(-0.15, 0.75, height)), 1.0); }"
          side={THREE.BackSide}
        />
      </mesh>
      <mesh position={[35, 48, -75]}>
        <sphereGeometry args={[5, 16, 16]} />
        <meshBasicMaterial color={FARM_SCENE_CONFIG.colors.sun} />
      </mesh>
      {[-35, 15, 70].map((x, index) => (
        <group key={x} position={[x, 35 + index * 3, -95 - index * 8]}>
          {[0, 1, 2].map((offset) => (
            <mesh key={offset} position={[offset * 2.2 - 2.2, offset % 2, 0]} scale={[1.8, 0.7, 0.8]}>
              <sphereGeometry args={[1.5, 12, 8]} />
              <meshBasicMaterial color={FARM_SCENE_CONFIG.colors.cloud} transparent opacity={0.58} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

function Helipad({ position }: { position: Point2 }) {
  return (
    <group position={[position.x, 0.05, position.z]}>
      <mesh>
        <cylinderGeometry args={[FARM_SCENE_CONFIG.helipadRadius, FARM_SCENE_CONFIG.helipadRadius, 0.18, 32]} />
        <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.helipad} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.1}>
        <ringGeometry args={[2.45, 2.58, 32]} />
        <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.helipadMarking} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.11}>
        <ringGeometry args={[1.3, 1.38, 32]} />
        <meshStandardMaterial color="#f4f6f2" />
      </mesh>
    </group>
  );
}

function SmoothnessProbe({ motion }: { motion: { current: RenderMotion } }) {
  const [snapshot, setSnapshot] = useState({ interval: 0, depth: 0, delta: 0, spikes: 0, graph: [] as number[] });
  const previous = useRef<THREE.Vector3 | null>(null);
  const deltas = useRef<number[]>([]);
  const spikes = useRef(0);
  useFrame(() => {
    const current = motion.current.position;
    if (previous.current) {
      const delta = current.distanceTo(previous.current);
      const values = deltas.current;
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : delta;
      if (average > 0 && delta > average * 2) spikes.current += 1;
      values.push(delta);
      if (values.length > 30) values.shift();
    }
    previous.current = current.clone();
  });
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stats = getRenderBufferStats();
      setSnapshot({
        interval: stats.averageIntervalMs,
        depth: stats.depth,
        delta: deltas.current[deltas.current.length - 1] ?? 0,
        spikes: spikes.current,
        graph: [...deltas.current],
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Html fullscreen>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/70 p-2 font-mono text-[9px] text-white">
        <div>telemetry {snapshot.interval.toFixed(0)}ms · buffer {snapshot.depth}</div>
        <div>frame Δ {snapshot.delta.toFixed(3)} · spikes {snapshot.spikes}</div>
        <div className="mt-1 flex h-3 items-end gap-px">
          {snapshot.graph.map((value, index) => (
            <span key={index} className="w-1 bg-cyan-300" style={{ height: `${Math.min(100, value * 500)}%` }} />
          ))}
        </div>
      </div>
    </Html>
  );
}

function FarmWorld({ fields, drone, view }: Props) {
  const layout = useMemo(() => projectFields(fields), [fields]);
  const helipadPosition = useMemo(() => getHelipadPosition(layout), [layout]);
  const renderMotion = useRef<RenderMotion>({
    position: new THREE.Vector3(helipadPosition.x, FARM_SCENE_CONFIG.droneGroundY, helipadPosition.z),
    velocity: new THREE.Vector3(),
    heading: 0,
    mode: 'disarmed',
    speedKmh: 0,
    altitudeM: 0,
  });
  const { camera } = useThree();
  const debug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
  const cameraForward = useMemo(() => new THREE.Vector3(0, 0, -1), []);
  const cameraDirection = useMemo(() => new THREE.Vector3(), []);
  const cameraTargetQuaternion = useMemo(() => new THREE.Quaternion(), []);
  useFrame((_, delta) => {
    const telemetry = getRenderTelemetry();
    if (telemetry) {
      if (telemetry.mode === 'disarmed') {
        renderMotion.current.position.set(helipadPosition.x, FARM_SCENE_CONFIG.droneGroundY, helipadPosition.z);
        renderMotion.current.velocity.set(0, 0, 0);
      } else {
        const position = layout.projectPosition(telemetry.position.lon, telemetry.position.lat);
        const latScale = Math.cos((telemetry.position.lat * Math.PI) / 180);
        const east = layout.projectPosition(
          telemetry.position.lon + telemetry.velocity.eastMps / (111_320 * latScale),
          telemetry.position.lat,
        );
        const north = layout.projectPosition(
          telemetry.position.lon,
          telemetry.position.lat + telemetry.velocity.northMps / 110_540,
        );
        renderMotion.current.position.set(
          position.x,
          telemetry.position.altM > 0.1 ? telemetry.position.altM : FARM_SCENE_CONFIG.droneGroundY,
          position.z,
        );
        renderMotion.current.velocity.set(east.x - position.x, telemetry.velocity.upMps, north.z - position.z);
      }
      renderMotion.current.heading = telemetry.headingDeg;
      renderMotion.current.mode = telemetry.mode;
      renderMotion.current.speedKmh = telemetry.speedKmh;
      renderMotion.current.altitudeM = telemetry.position.altM;
    } else {
      renderMotion.current.position.set(helipadPosition.x, FARM_SCENE_CONFIG.droneGroundY, helipadPosition.z);
      renderMotion.current.velocity.set(0, 0, 0);
      renderMotion.current.mode = 'disarmed';
      renderMotion.current.speedKmh = 0;
      renderMotion.current.altitudeM = 0;
    }
    const target = renderMotion.current.position;
    if (view === 'camera') {
      camera.position.copy(target);
      const yaw = THREE.MathUtils.degToRad(renderMotion.current.heading);
      const tilt = THREE.MathUtils.degToRad(58);
      cameraDirection.set(Math.sin(yaw) * Math.cos(tilt), -Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt));
      cameraTargetQuaternion.setFromUnitVectors(cameraForward, cameraDirection);
      camera.quaternion.slerp(cameraTargetQuaternion, 1 - Math.exp(-delta * 8));
    } else {
      const desired =
        view === 'map'
          ? new THREE.Vector3(target.x, 70, target.z + 0.01)
          : new THREE.Vector3(target.x + 12, target.y + 10, target.z + 16);
      camera.position.x = damp(camera.position.x, desired.x, 6, delta);
      camera.position.y = damp(camera.position.y, desired.y, 6, delta);
      camera.position.z = damp(camera.position.z, desired.z, 6, delta);
      camera.lookAt(target);
    }
  });
  return (
    <>
      <color attach="background" args={[FARM_SCENE_CONFIG.colors.sky]} />
      <fog attach="fog" args={[FARM_SCENE_CONFIG.colors.skyHorizon, 70, 220]} />
      <hemisphereLight args={['#d9f1ff', '#6c9b67', 1.8]} />
      <directionalLight position={[15, 25, 10]} intensity={2} />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.04}>
        <planeGeometry args={[FARM_SCENE_CONFIG.groundSize, FARM_SCENE_CONFIG.groundSize]} />
        <meshStandardMaterial color={FARM_SCENE_CONFIG.colors.ground} />
      </mesh>
      <Sky />
      <Hills />
      {layout.fields.map((field) => (
        <group key={field.field.id}>
          <FieldMesh field={field} />
          <CropInstances field={field} helipadPosition={helipadPosition} />
        </group>
      ))}
      <FarmPaths layout={layout} />
      <IssuePatches layout={layout} />
      <Pond layout={layout} />
      <Trees layout={layout} />
      <Helipad position={helipadPosition} />
      <Windsock position={helipadPosition} />
      {drone && view !== 'camera' && (
        <DroneModel
          spec={drone}
          position={[renderMotion.current.position.x, renderMotion.current.position.y, renderMotion.current.position.z]}
          scale={0.9}
          renderMotion={renderMotion}
        />
      )}
      {debug && <SmoothnessProbe motion={renderMotion} />}
    </>
  );
}

export function FarmScene({ fields, drone, view }: Props) {
  return (
    <div className="h-full min-h-[28rem] w-full overflow-hidden rounded-3xl bg-sky-100">
      <Canvas
        dpr={[1, FARM_SCENE_CONFIG.maxDpr]}
        camera={{ position: [18, 18, 24], fov: 45, near: 0.01, far: 300 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <FarmWorld fields={fields} drone={drone} view={view} />
      </Canvas>
    </div>
  );
}
