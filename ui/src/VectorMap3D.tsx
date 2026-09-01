import { useEffect, useId, useRef, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  VectorVisualizationPoint,
  VectorVisualizationProps,
} from "./vector-visualization";

export type VectorMap3DPoint = VectorVisualizationPoint;
export type VectorMap3DProps = VectorVisualizationProps;

type SceneSelection = {
  byId: Map<string, VectorMap3DPoint>;
  geometry: BufferGeometry;
  marker: Points;
};

const FALLBACK_PALETTE = {
  accent: "#78d49f",
  user: "#7aa2f7",
  assistant: "#e8b04b",
  tool: "#bb9af7",
  result: "#8b949e",
  focus: "#f0c674",
  background: "#07090b",
};

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function roleColor(role: string): string {
  const normalized = role.toLowerCase();
  if (normalized.includes("human") || normalized.includes("user")) {
    return cssColor("--user", FALLBACK_PALETTE.user);
  }
  if (normalized.includes("assistant") || normalized.includes("agent") || normalized.includes("summary")) {
    return cssColor("--assistant", FALLBACK_PALETTE.assistant);
  }
  if (normalized.includes("tool_evidence") || normalized.includes("result")) {
    return cssColor("--result", FALLBACK_PALETTE.result);
  }
  if (normalized.includes("tool")) {
    return cssColor("--tool", FALLBACK_PALETTE.tool);
  }
  return cssColor("--accent", FALLBACK_PALETTE.accent);
}

function circularPointTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(32, 32, 28, 0, Math.PI * 2);
    context.fill();
  }
  return new CanvasTexture(canvas);
}

function updateSelection(selection: SceneSelection, selectedEventId: string): void {
  const selected = selection.byId.get(selectedEventId);
  selection.marker.visible = Boolean(selected);
  if (!selected) return;

  const positions = selection.geometry.getAttribute("position") as BufferAttribute;
  positions.setXYZ(0, selected.x, selected.y, selected.z ?? 0);
  positions.needsUpdate = true;
}

/**
 * A pointer-driven 3D companion to the accessible event evidence list.
 * Keep the list in the parent UI: this canvas intentionally does not replace it.
 */
export function VectorMap3D({
  points,
  selectedEventId,
  onSelect,
  config,
  reducedMotion = false,
  onUnavailable,
  ariaLabel = "Interactive 3D vector map. Use the adjacent event list for keyboard navigation.",
  className,
}: VectorMap3DProps) {
  const spin = config?.spin === true && !reducedMotion;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionRef = useRef<SceneSelection | null>(null);
  const invalidateRef = useRef<(() => void) | null>(null);
  const selectedEventIdRef = useRef(selectedEventId);
  const onSelectRef = useRef(onSelect);
  const onUnavailableRef = useRef(onUnavailable);
  const selectionDescriptionId = useId();
  const [error, setError] = useState("");

  selectedEventIdRef.current = selectedEventId;
  onSelectRef.current = onSelect;
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      powerPreference: "high-performance",
    });
    if (!context) {
      const message = "3D vector map unavailable: this browser or device does not provide WebGL 2.";
      setError(message);
      onUnavailableRef.current?.(message);
      return;
    }

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, context, antialias: true });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const message = `3D vector map could not start: ${detail}`;
      setError(message);
      onUnavailableRef.current?.(message);
      return;
    }

    setError("");
    const scene = new Scene();
    const camera = new PerspectiveCamera(48, 1, 0.01, 1_000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.autoRotate = spin;
    controls.autoRotateSpeed = 0.45;

    let contextLost = false;
    let disposed = false;
    let isIntersecting = true;
    let isDocumentVisible = document.visibilityState !== "hidden";
    let animationFrame: number | null = null;

    const canRender = () =>
      !disposed && !contextLost && isIntersecting && isDocumentVisible;
    const cancelScheduledRender = () => {
      if (animationFrame === null) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    };
    const renderFrame = () => {
      animationFrame = null;
      if (!canRender()) return;
      const dampingChangedCamera = controls.update();
      renderer.render(scene, camera);
      if ((dampingChangedCamera || controls.autoRotate) && animationFrame === null) {
        animationFrame = requestAnimationFrame(renderFrame);
      }
    };
    const invalidate = () => {
      if (!canRender() || animationFrame !== null) return;
      animationFrame = requestAnimationFrame(renderFrame);
    };
    invalidateRef.current = invalidate;
    controls.addEventListener("change", invalidate);

    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    const byId = new Map<string, VectorMap3DPoint>();
    points.forEach((point, index) => {
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z ?? 0;
      byId.set(point.event_id, point);
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const pointTexture = circularPointTexture();
    const material = new PointsMaterial({
      size: 6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      map: pointTexture,
      alphaTest: 0.4,
    });
    const cloud = new Points(geometry, material);
    scene.add(cloud);

    const markerGeometry = new BufferGeometry();
    markerGeometry.setAttribute("position", new BufferAttribute(new Float32Array(3), 3));
    const markerMaterial = new PointsMaterial({
      color: FALLBACK_PALETTE.focus,
      size: 14,
      sizeAttenuation: false,
      depthTest: false,
      map: pointTexture,
      alphaTest: 0.4,
    });
    const marker = new Points(markerGeometry, markerMaterial);
    marker.renderOrder = 2;
    marker.frustumCulled = false;
    scene.add(marker);

    const hoverGeometry = new BufferGeometry();
    hoverGeometry.setAttribute("position", new BufferAttribute(new Float32Array(3), 3));
    const hoverMaterial = new PointsMaterial({
      color: FALLBACK_PALETTE.accent,
      size: 10,
      sizeAttenuation: false,
      depthTest: false,
      map: pointTexture,
      alphaTest: 0.4,
    });
    const hoverMarker = new Points(hoverGeometry, hoverMaterial);
    hoverMarker.visible = false;
    hoverMarker.renderOrder = 1;
    hoverMarker.frustumCulled = false;
    scene.add(hoverMarker);

    const selection: SceneSelection = { byId, geometry: markerGeometry, marker };
    selectionRef.current = selection;
    updateSelection(selection, selectedEventIdRef.current);

    const bounds = geometry.boundingSphere;
    const center = bounds?.center ?? new Vector3();
    const radius = Math.max(bounds?.radius ?? 1, 0.5);
    controls.target.copy(center);
    camera.position.set(center.x + radius * 0.35, center.y + radius * 0.2, center.z + radius * 2.8);
    camera.near = Math.max(radius / 1_000, 0.001);
    camera.far = Math.max(radius * 20, 100);
    camera.updateProjectionMatrix();
    camera.lookAt(center);

    const applyTheme = () => {
      const colorAttribute = geometry.getAttribute("color") as BufferAttribute;
      points.forEach((point, index) => {
        const color = new Color(roleColor(point.semantic_role));
        colorAttribute.setXYZ(index, color.r, color.g, color.b);
      });
      colorAttribute.needsUpdate = true;
      markerMaterial.color.set(cssColor("--focus", FALLBACK_PALETTE.focus));
      hoverMaterial.color.set(cssColor("--accent", FALLBACK_PALETTE.accent));
      renderer.setClearColor(cssColor("--panel-deep", FALLBACK_PALETTE.background), 1);
      invalidate();
    };
    applyTheme();

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry?.isIntersecting ?? true;
      if (isIntersecting) invalidate();
      else cancelScheduledRender();
    });
    intersectionObserver.observe(host);

    const handleVisibilityChange = () => {
      isDocumentVisible = document.visibilityState !== "hidden";
      if (isDocumentVisible) invalidate();
      else cancelScheduledRender();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const raycaster = new Raycaster();
    raycaster.params.Points = { threshold: radius / 35 };
    const pointer = new Vector2();
    let pointerStart: { x: number; y: number } | null = null;
    const hitAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return undefined;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(cloud, false)[0];
    };
    const handlePointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    };
    const handlePointerMove = (event: PointerEvent) => {
      const hit = hitAt(event);
      const point = hit?.index === undefined ? undefined : points[hit.index];
      hoverMarker.visible = Boolean(point);
      canvas.style.cursor = point ? "pointer" : "grab";
      canvas.title = point
        ? `${point.semantic_role || point.block_type || "evidence"}: ${point.text_preview || point.event_id}`
        : "";
      if (point) {
        const positions = hoverGeometry.getAttribute("position") as BufferAttribute;
        positions.setXYZ(0, point.x, point.y, point.z ?? 0);
        positions.needsUpdate = true;
      }
      invalidate();
    };
    const handlePointerLeave = () => {
      hoverMarker.visible = false;
      canvas.style.cursor = "grab";
      canvas.title = "";
      invalidate();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) {
        pointerStart = null;
        return;
      }
      pointerStart = null;
      const hit = hitAt(event);
      if (hit?.index === undefined) return;
      const selected = points[hit.index];
      if (selected) onSelectRef.current(selected.event_id);
    };
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointerup", handlePointerUp);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelScheduledRender();
      const message = "3D vector map stopped because the WebGL context was lost.";
      setError(message);
      onUnavailableRef.current?.(message);
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    const handleContextRestored = () => {
      contextLost = false;
      setError("");
      invalidate();
    };
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    invalidate();

    return () => {
      disposed = true;
      cancelScheduledRender();
      controls.removeEventListener("change", invalidate);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      intersectionObserver.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      hoverGeometry.dispose();
      hoverMaterial.dispose();
      pointTexture.dispose();
      scene.clear();
      renderer.dispose();
      selectionRef.current = null;
      invalidateRef.current = null;
    };
  }, [points, spin]);

  useEffect(() => {
    const selection = selectionRef.current;
    if (selection) {
      updateSelection(selection, selectedEventId);
      invalidateRef.current?.();
    }
  }, [selectedEventId]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 260 }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={selectionDescriptionId}
        hidden={Boolean(error)}
        style={{ display: "block", width: "100%", height: "100%", touchAction: "none" }}
      />
      <span
        id={selectionDescriptionId}
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {selectedEventId ? `Selected event ${selectedEventId}` : "No vector event selected"}
      </span>
      {error ? <p role="status">{error}</p> : null}
    </div>
  );
}
