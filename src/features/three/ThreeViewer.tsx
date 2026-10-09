import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { GeometryScene } from "../../geometry/constraints";
import type { Floor } from "../../domain/model";
import { buildFloorModel, disposeModel, type ModelWarning } from "./model";
const labels: Record<string, string> = {
  wall: "Стена",
  column: "Колонна",
  beam: "Балка",
  stair: "Лестница",
  ramp: "Пандус",
  levelChange: "Перепад уровня",
  window: "Окно",
  door: "Дверь",
  opening: "Проём",
  room: "Помещение",
};
export function ThreeViewer({
  scene,
  floor,
  onSelect,
}: {
  scene: GeometryScene;
  floor: Floor;
  onSelect: (id: string) => void;
}) {
  const fillRef = useRef(true);
  const host = useRef<HTMLDivElement>(null),
    controls = useRef<{
      fit: () => void;
      top: () => void;
      snap: () => void;
      fill: (shown: boolean) => void;
    } | null>(null);
  const [error, setError] = useState(""),
    [warnings, setWarnings] = useState<ModelWarning[]>([]),
    [selected, setSelected] = useState<{ id: string; kind: string } | null>(
      null,
    ),
    [fill, setFill] = useState(true),
    [ready, setReady] = useState(false);
  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer | undefined,
      orbit: OrbitControls | undefined,
      model: ReturnType<typeof buildFloorModel> | undefined,
      resize: ResizeObserver | undefined;
    let active = true,
      frame = 0;
    const temporary = new Set<THREE.Material>();
    const world = new THREE.Scene();
    world.background = new THREE.Color(0xf1f5f4);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    const drawn = () => {
      if (active && renderer) {
        renderer.render(world, camera);
        const p = camera.position;
        container.dataset.camera = [p.x, p.y, p.z]
          .map((v) => v.toFixed(3))
          .join(",");
      }
    };
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          drawn();
        });
    };
    try {
      model = buildFloorModel(scene, floor);
      const builtWarnings = model.warnings;
      queueMicrotask(() => {
        if (active) {
          setWarnings(builtWarnings);
          setSelected(null);
          setError("");
        }
      });
      const bounds = new THREE.Box3().setFromObject(model.group),
        center = bounds.isEmpty()
          ? new THREE.Vector3(0, floor.elevation, 0)
          : bounds.getCenter(new THREE.Vector3());
      model.group.position.sub(center);
      world.add(model.group);
      const size = bounds.isEmpty()
          ? new THREE.Vector3(4, 3, 4)
          : bounds.getSize(new THREE.Vector3()),
        radius = Math.max(2, size.length() / 2);
      camera.near = Math.max(0.001, radius / 10000);
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute("aria-label", "3D модель этажа");
      renderer.domElement.setAttribute("role", "img");
      container.appendChild(renderer.domElement);
      world.add(new THREE.HemisphereLight(0xffffff, 0x879a91, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(radius, radius * 2, radius);
      world.add(light);
      const grid = new THREE.GridHelper(
        Math.max(10, radius * 3),
        20,
        0xb9ccc3,
        0xdde6e1,
      );
      grid.position.y = floor.elevation - center.y - 0.08;
      world.add(grid);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = false;
      orbit.minDistance = radius * 0.03;
      orbit.maxDistance = radius * 20;
      orbit.maxPolarAngle = Math.PI * 0.98;
      orbit.addEventListener("change", schedule);
      function fit() {
        camera.up.set(0, 1, 0);
        camera.position.set(radius * 1.7, radius * 1.2, radius * 1.7);
        orbit!.target.set(0, 0, 0);
        orbit!.update();
        schedule();
      }
      function top() {
        camera.up.set(0, 0, -1);
        camera.position.set(0, radius * 3, 0);
        orbit!.target.set(0, 0, 0);
        orbit!.update();
        schedule();
      }
      function visibility(shown: boolean) {
        model!.group.traverse((o) => {
          if (
            o instanceof THREE.Mesh &&
            ["window", "door"].includes(o.userData.kind)
          )
            o.visible = shown;
        });
        schedule();
      }
      function snap() {
        drawn();
        renderer!.domElement.toBlob((blob) => {
          if (!blob || !active) {
            if (active) setError("Не удалось создать снимок");
            return;
          }
          const url = URL.createObjectURL(blob),
            link = document.createElement("a");
          link.href = url;
          link.download = `${floor.name.replace(/[^\p{L}\p{N}_ -]/gu, "_")}-3D.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, "image/png");
      }
      controls.current = { fit, top, snap, fill: visibility };
      visibility(fillRef.current);
      fit();
      const sizeRenderer = () => {
        const width = Math.max(1, container.clientWidth),
          height = Math.max(1, container.clientHeight);
        renderer!.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        schedule();
      };
      resize = new ResizeObserver(sizeRenderer);
      resize.observe(container);
      sizeRenderer();
      const ray = new THREE.Raycaster(),
        down = { x: 0, y: 0 };
      let changed = false;
      const markChange = () => {
        changed = true;
      };
      orbit.addEventListener("change", markChange);
      const pointerDown = (e: PointerEvent) => {
        down.x = e.clientX;
        down.y = e.clientY;
        changed = false;
      };
      const pointerUp = (e: PointerEvent) => {
        if (changed || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5)
          return;
        const r = renderer!.domElement.getBoundingClientRect();
        ray.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            (-(e.clientY - r.top) / r.height) * 2 + 1,
          ),
          camera,
        );
        const hit = ray
          .intersectObjects(model!.group.children, true)
          .find((h) => h.object.visible && h.object.userData.sourceId);
        model!.group.traverse((o) => {
          if (o instanceof THREE.Mesh && o.userData.originalMaterial) {
            o.material = o.userData.originalMaterial;
            delete o.userData.originalMaterial;
          }
        });
        for (const m of temporary) m.dispose();
        temporary.clear();
        if (hit) {
          const mesh = hit.object as THREE.Mesh,
            material = (mesh.material as THREE.MeshStandardMaterial).clone();
          material.emissive.set(0x497766);
          mesh.userData.originalMaterial = mesh.material;
          mesh.material = material;
          temporary.add(material);
          setSelected({ id: mesh.userData.sourceId, kind: mesh.userData.kind });
        } else setSelected(null);
        schedule();
      };
      renderer.domElement.addEventListener("pointerdown", pointerDown);
      renderer.domElement.addEventListener("pointerup", pointerUp);
      const lost = (e: Event) => {
        e.preventDefault();
        if (!active) return;
        setError(
          "3D-контекст потерян. Переключитесь в 2D и откройте 3D заново.",
        );
        setReady(false);
      };
      renderer.domElement.addEventListener("webglcontextlost", lost);
      queueMicrotask(() => {
        if (active) setReady(true);
      });
      container.dataset.meshes = String(model.group.children.length);
    } catch {
      queueMicrotask(() => {
        if (active) {
          setError(
            "3D недоступен в этом браузере или для текущей геометрии. План и данные доступны в 2D.",
          );
          setReady(false);
        }
      });
    }
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      controls.current = null;
      resize?.disconnect();
      orbit?.dispose();
      if (model) {
        model.group.traverse((o) => {
          if (o instanceof THREE.Mesh && o.userData.originalMaterial)
            o.material = o.userData.originalMaterial;
        });
        disposeModel(model.group);
      }
      for (const m of temporary) m.dispose();
      world.traverse((o) => {
        if (o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
        }
      });
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };
  }, [scene, floor]);
  return (
    <section className="three-viewer" aria-label="Просмотр 3D">
      <div className="three-actions">
        <button disabled={!ready} onClick={() => controls.current?.fit()}>
          Показать всю 3D модель
        </button>
        <button disabled={!ready} onClick={() => controls.current?.top()}>
          Вид сверху
        </button>
        <button disabled={!ready} onClick={() => controls.current?.snap()}>
          Скачать снимок 3D
        </button>
        <label>
          <input
            type="checkbox"
            checked={fill}
            onChange={(e) => {
              setFill(e.target.checked);
              fillRef.current = e.target.checked;
              controls.current?.fill(e.target.checked);
            }}
          />
          Заполнения окон и дверей
        </label>
      </div>
      <p className="muted">
        Этот этаж · вращение левой кнопкой/одним пальцем · масштаб колесом/двумя
        пальцами · перемещение правой кнопкой/двумя пальцами. 3D использует
        текущую модель замера.
      </p>
      {(scene.elements ?? []).some(
        (e) => e.kind === "ramp" || e.kind === "levelChange",
      ) && (
        <p className="muted">
          Пандусы имеют условную толщину 8 см, перепады показаны поверхностями и
          границами. Это визуализация замера.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div ref={host} className="three-canvas" data-testid="three-canvas" />
      {!scene.walls.length && !scene.elements?.length && (
        <p>Добавьте стены или конструкции на 2D плане.</p>
      )}
      {selected && (
        <p role="status">
          Выбрано: {labels[selected.kind] ?? selected.kind}{" "}
          <button onClick={() => onSelect(selected.id)}>
            Открыть выбранный элемент в 2D
          </button>
        </p>
      )}
      <details>
        <summary>Элементы модели и переход в 2D</summary>
        {[
          ...scene.walls,
          ...(scene.elements ?? []),
          ...(scene.rooms ?? []),
        ].map((e, i) => (
          <button key={e.id} onClick={() => onSelect(e.id)}>
            {"kind" in e
              ? labels[e.kind === "opening" ? e.type : e.kind]
              : "Помещение"}{" "}
            №{i + 1} → 2D
          </button>
        ))}
      </details>
      {!!warnings.length && (
        <div role="status">
          <h3>Замечания 3D</h3>
          {warnings.map((w, i) => (
            <p key={`${w.id}-${i}`}>
              {w.message}{" "}
              <button onClick={() => onSelect(w.id)}>Проверить в 2D</button>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
