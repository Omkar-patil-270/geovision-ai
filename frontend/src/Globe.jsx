import { useState, useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

const LABELS_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png";
const ROADMAP_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const LABEL_VISIBLE_HEIGHT = 800000;
const IDLE_RESUME_MS = 6000;

function createHeatmapCanvas(layerKey, intensity = 1.0, size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size / 2;
  const radius = size / 2;

  const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius);

  // Layer-specific palettes with scientifically tuned color stops
  if (layerKey === "aqi") {
    // Air Quality: Good (Green) -> Moderate (Yellow) -> Unhealthy (Orange/Red) -> Hazardous (Purple/Maroon)
    gradient.addColorStop(0, "rgba(126, 0, 35, 0.95)");
    gradient.addColorStop(0.25, "rgba(239, 68, 68, 0.88)");
    gradient.addColorStop(0.5, "rgba(249, 115, 22, 0.78)");
    gradient.addColorStop(0.75, "rgba(234, 179, 8, 0.6)");
    gradient.addColorStop(0.92, "rgba(34, 197, 94, 0.35)");
    gradient.addColorStop(1, "rgba(34, 197, 94, 0)");
  } else if (layerKey === "weather" || layerKey === "temperature") {
    // Temperature: Scorching Red -> Amber -> Cyan -> Deep Blue
    gradient.addColorStop(0, "rgba(239, 68, 68, 0.95)");
    gradient.addColorStop(0.3, "rgba(249, 115, 22, 0.85)");
    gradient.addColorStop(0.6, "rgba(234, 179, 8, 0.7)");
    gradient.addColorStop(0.85, "rgba(6, 182, 212, 0.45)");
    gradient.addColorStop(1, "rgba(59, 130, 246, 0)");
  } else if (layerKey === "population") {
    // Population Density: Deep Crimson -> Radiant Violet -> Electric Blue
    gradient.addColorStop(0, "rgba(244, 63, 94, 0.96)");
    gradient.addColorStop(0.3, "rgba(168, 85, 247, 0.85)");
    gradient.addColorStop(0.65, "rgba(59, 130, 246, 0.65)");
    gradient.addColorStop(0.88, "rgba(6, 182, 212, 0.35)");
    gradient.addColorStop(1, "rgba(6, 182, 212, 0)");
  } else if (layerKey === "migration" || layerKey === "radiance") {
    // Night-light radiance / Settlement Growth: Core Golden White -> Amber -> Indigo
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.98)");
    gradient.addColorStop(0.2, "rgba(253, 224, 71, 0.9)");
    gradient.addColorStop(0.5, "rgba(234, 88, 12, 0.75)");
    gradient.addColorStop(0.8, "rgba(99, 102, 241, 0.4)");
    gradient.addColorStop(1, "rgba(67, 56, 202, 0)");
  } else {
    // Default geospatial cyan-blue radar glow
    gradient.addColorStop(0, "rgba(0, 212, 255, 0.95)");
    gradient.addColorStop(0.4, "rgba(0, 102, 255, 0.7)");
    gradient.addColorStop(0.8, "rgba(168, 85, 247, 0.35)");
    gradient.addColorStop(1, "rgba(0, 212, 255, 0)");
  }

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

const Globe = forwardRef(({ onLocationSelect, selectionEnabled }, ref) => {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const markerRef = useRef(null);
  const boundaryEntityRef = useRef(null);
  const boundaryMarkerRef = useRef(null);
  const pulseHandlerRef = useRef(null);
  const labelsLayerRef = useRef(null);
  const pendingFlyRef = useRef(null);
  const isReadyRef = useRef(false);
  const selectionEnabledRef = useRef(selectionEnabled);
  const onLocationSelectRef = useRef(onLocationSelect);
  const autoRotateRef = useRef(false);
  const idleTimerRef = useRef(null);
  const heatmapEntityRef = useRef(null);
  const heatmapParamsRef = useRef(null);
  const [webglError, setWebglError] = useState(false);

  useEffect(() => { selectionEnabledRef.current = selectionEnabled; }, [selectionEnabled]);
  useEffect(() => { onLocationSelectRef.current = onLocationSelect; }, [onLocationSelect]);

  const scheduleResume = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (selectionEnabledRef.current) autoRotateRef.current = true;
    }, IDLE_RESUME_MS);
  };

  useEffect(() => {
    if (viewerRef.current) return;
    let cancelled = false;

    async function init() {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = "";

      let imageryProvider;
      try {
        imageryProvider = await Cesium.IonImageryProvider.fromAssetId(3);
      } catch {
        imageryProvider = new Cesium.UrlTemplateImageryProvider({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        });
      }

      const fallbackImagery = new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      });
      if (cancelled || !containerRef.current) return;

      let viewer;
      try {
        viewer = new Cesium.Viewer(containerRef.current, {
          baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
          navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
          infoBox: false, selectionIndicator: false,
          baseLayer: new Cesium.ImageryLayer(imageryProvider),
          terrainProvider: new Cesium.EllipsoidTerrainProvider(),
          contextOptions: { webgl: { powerPreference: "high-performance" } },
        });
      } catch (err) {
        console.error("Cesium.Viewer initialization failed:", err);
        setWebglError(true);
        return;
      }

      if (cancelled) {
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        return;
      }

      viewer.scene.globe.enableLighting = true;
      viewer.scene.fog.enabled = true;
      viewer.scene.fog.density = 0.00018;
      viewer.scene.skyAtmosphere.show = true;
      viewer.scene.skyAtmosphere.brightnessShift = 0.05;
      viewer.scene.sun.show = true;
      viewer.scene.moon.show = true;
      viewer.scene.globe.maximumScreenSpaceError = 2;
      viewer.scene.globe.tileCacheSize = 1000;
      viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.5);
      viewer.targetFrameRate = 60;

      let baseErrorCount = 0;
      const baseLayer = viewer.imageryLayers.get(0);
      baseLayer.imageryProvider.errorEvent?.addEventListener(() => {
        baseErrorCount += 1;
        if (baseErrorCount === 5) {
          viewer.imageryLayers.remove(baseLayer, false);
          viewer.imageryLayers.add(fallbackImagery, 0);
        }
      });

      try {
        const bloom = viewer.scene.postProcessStages.bloom;
        bloom.enabled = true;
        bloom.uniforms.glowOnly = false;
        bloom.uniforms.contrast = 140;
        bloom.uniforms.brightness = -0.3;
        bloom.uniforms.delta = 1.0;
        bloom.uniforms.sigma = 3.0;
        bloom.uniforms.stepSize = 1.0;
      } catch {
        // bloom unavailable — safe to skip
      }

      const controller = viewer.scene.screenSpaceCameraController;
      controller.enableRotate = true;
      controller.enableTranslate = true;
      controller.enableZoom = true;
      controller.enableTilt = true;
      controller.enableLook = true;
      controller.minimumZoomDistance = 1;
      controller.maximumZoomDistance = 40000000;

      const labelsLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({ url: LABELS_URL, subdomains: ["a", "b", "c", "d"] })
      );
      labelsLayer.alpha = 0.9;
      labelsLayer.show = false;
      labelsLayerRef.current = labelsLayer;

      viewer.camera.changed.addEventListener(() => {
        const height = viewer.camera.positionCartographic.height;
        labelsLayer.show = height < LABEL_VISIBLE_HEIGHT;
      });
      viewer.camera.percentageChanged = 0.02;

      const planets = [
        { name: "Mars", color: Cesium.Color.fromCssColorString("#c1440e"), pos: [4.0e8, 1.0e8, 5.0e7], size: 12 },
        { name: "Jupiter", color: Cesium.Color.fromCssColorString("#d8ca9d"), pos: [-5.0e8, -2.0e8, 1.0e8], size: 22 },
        { name: "Saturn", color: Cesium.Color.fromCssColorString("#e3c16f"), pos: [3.0e8, -4.0e8, -1.0e8], size: 18 },
      ];
      planets.forEach((p) => {
        viewer.entities.add({
          name: p.name, position: new Cesium.Cartesian3(...p.pos),
          point: { pixelSize: p.size, color: p.color, outlineColor: Cesium.Color.WHITE.withAlpha(0.3), outlineWidth: 1 },
          label: { text: p.name, font: "12px sans-serif", fillColor: Cesium.Color.WHITE.withAlpha(0.7), pixelOffset: new Cesium.Cartesian2(0, -18), showBackground: false },
        });
      });

      viewer.camera.flyHome(0);

      viewer.clock.onTick.addEventListener(() => {
        if (!autoRotateRef.current) return;
        viewer.scene.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0006);
      });

      const pauseAndScheduleResume = () => {
        autoRotateRef.current = false;
        scheduleResume();
      };
      viewer.screenSpaceEventHandler.setInputAction(pauseAndScheduleResume, Cesium.ScreenSpaceEventType.LEFT_DOWN);
      viewer.screenSpaceEventHandler.setInputAction(pauseAndScheduleResume, Cesium.ScreenSpaceEventType.WHEEL);

      viewer.screenSpaceEventHandler.setInputAction((click) => {
        if (!selectionEnabledRef.current) return;
        const cartesian = viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
        if (cartesian) {
          const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
          const lat = Cesium.Math.toDegrees(cartographic.latitude);
          const lon = Cesium.Math.toDegrees(cartographic.longitude);
          flyToLocation(lat, lon);
          onLocationSelectRef.current({ lat, lon });
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      viewerRef.current = viewer;
      isReadyRef.current = true;
      autoRotateRef.current = true;

      if (pendingFlyRef.current) {
        const { lat, lon, height } = pendingFlyRef.current;
        pendingFlyRef.current = null;
        flyToLocation(lat, lon, height);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        try {
          viewerRef.current.destroy();
        } catch {
          // ignore
        }
        viewerRef.current = null;
        isReadyRef.current = false;
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, []);

  const _haversineKm = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = Cesium.Math.toRadians(lat2 - lat1);
    const dLon = Cesium.Math.toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(Cesium.Math.toRadians(lat1)) * Math.cos(Cesium.Math.toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  };

  const flyToLocation = (lat, lon, height = 8000) => {
    autoRotateRef.current = false;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!isReadyRef.current || !viewerRef.current) {
      pendingFlyRef.current = { lat, lon, height };
      return;
    }
    const viewer = viewerRef.current;
    if (markerRef.current) viewer.entities.remove(markerRef.current);
    markerRef.current = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 14, color: Cesium.Color.DODGERBLUE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
    });

    let duration = 2.5;
    try {
      const cameraCarto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      const fromLat = Cesium.Math.toDegrees(cameraCarto.latitude);
      const fromLon = Cesium.Math.toDegrees(cameraCarto.longitude);
      const distKm = _haversineKm(fromLat, fromLon, lat, lon);
      duration = Math.min(5.5, Math.max(1.8, 1.8 + Math.sqrt(distKm / 20000) * 3.7));
    } catch {
      // default duration
    }

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => {
        viewer.scene.globe.maximumScreenSpaceError = 2;
      },
    });

    viewer.scene.globe.maximumScreenSpaceError = 6;
  };

  const clearBoundary = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (boundaryEntityRef.current) {
      viewer.dataSources.remove(boundaryEntityRef.current, true);
      boundaryEntityRef.current = null;
    }
    if (boundaryMarkerRef.current) {
      viewer.entities.remove(boundaryMarkerRef.current);
      boundaryMarkerRef.current = null;
    }
    if (pulseHandlerRef.current) {
      viewer.clock.onTick.removeEventListener(pulseHandlerRef.current);
      pulseHandlerRef.current = null;
    }
  };

  const highlightBoundary = async (geojson, colorHex, point) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    clearBoundary();

    if (geojson) {
      try {
        const dataSource = await Cesium.GeoJsonDataSource.load(geojson, {
          stroke: Cesium.Color.fromCssColorString(colorHex),
          fill: Cesium.Color.fromCssColorString(colorHex).withAlpha(0.18),
          strokeWidth: 3,
          clampToGround: true,
        });
        await viewer.dataSources.add(dataSource);
        boundaryEntityRef.current = dataSource;
        return;
      } catch {
        // fall through to point marker
      }
    }

    if (point && point.lat != null && point.lon != null) {
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        ellipse: {
          semiMinorAxis: 300, semiMajorAxis: 300, height: 0, outline: false,
          material: Cesium.Color.fromCssColorString(colorHex).withAlpha(0.35),
        },
      });
      boundaryMarkerRef.current = entity;
      let t = 0;
      const handler = () => {
        t += 0.04;
        const pulse = 0.2 + Math.sin(t) * 0.15;
        entity.ellipse.material = Cesium.Color.fromCssColorString(colorHex).withAlpha(Math.max(0.1, pulse));
      };
      viewer.clock.onTick.addEventListener(handler);
      pulseHandlerRef.current = handler;
    }
  };

  const recolorBoundary = (colorHex) => {
    const color = Cesium.Color.fromCssColorString(colorHex);
    if (boundaryEntityRef.current) {
      boundaryEntityRef.current.entities.values.forEach((e) => {
        if (e.polygon) {
          e.polygon.material = color.withAlpha(0.18);
          e.polygon.outlineColor = color;
        }
        if (e.polyline) e.polyline.material = color;
      });
    }
    if (boundaryMarkerRef.current?.ellipse) {
      boundaryMarkerRef.current.ellipse.material = color.withAlpha(0.3);
    }
  };

  const setMapStyle = async (styleKey) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.imageryLayers.removeAll();

    let baseProvider;
    let useLabels = false;
    let useRealTerrain = false;

    if (styleKey === "roadmap") {
      baseProvider = new Cesium.UrlTemplateImageryProvider({ url: ROADMAP_URL, subdomains: ["a", "b", "c", "d"] });
    } else if (styleKey === "satellite") {
      try { baseProvider = await Cesium.IonImageryProvider.fromAssetId(3); }
      catch { baseProvider = new Cesium.UrlTemplateImageryProvider({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" }); }
    } else if (styleKey === "hybrid") {
      try { baseProvider = await Cesium.IonImageryProvider.fromAssetId(3); }
      catch { baseProvider = new Cesium.UrlTemplateImageryProvider({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" }); }
      useLabels = true;
    } else if (styleKey === "terrain") {
      try { baseProvider = await Cesium.IonImageryProvider.fromAssetId(3); }
      catch { baseProvider = new Cesium.UrlTemplateImageryProvider({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}" }); }
      useLabels = true;
      useRealTerrain = true;
    }

    viewer.imageryLayers.addImageryProvider(baseProvider);

    if (useLabels) {
      const labelsLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({ url: LABELS_URL, subdomains: ["a", "b", "c", "d"] })
      );
      labelsLayer.alpha = 0.9;
      const height = viewer.camera.positionCartographic.height;
      labelsLayer.show = height < LABEL_VISIBLE_HEIGHT;
      labelsLayerRef.current = labelsLayer;
    }

    viewer.scene.globe.terrainProvider = useRealTerrain
      ? await Cesium.createWorldTerrainAsync().catch(() => new Cesium.EllipsoidTerrainProvider())
      : new Cesium.EllipsoidTerrainProvider();

    viewer.scene.requestRender();
  };

  const removeHeatmap = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (heatmapEntityRef.current) {
      viewer.entities.remove(heatmapEntityRef.current);
      heatmapEntityRef.current = null;
    }
    heatmapParamsRef.current = null;
  };

  const setHeatmapLayer = ({ layerKey, lat, lon, intensity = 1.0, radius = 28000, opacity = 0.75 }) => {
    const viewer = viewerRef.current;
    if (!viewer || lat == null || lon == null) return;
    removeHeatmap();

    const canvas = createHeatmapCanvas(layerKey, intensity);
    heatmapParamsRef.current = { layerKey, lat, lon, intensity, radius, opacity, canvas };

    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius,
        material: new Cesium.ImageMaterialProperty({
          image: canvas,
          transparent: true,
          color: Cesium.Color.WHITE.withAlpha(opacity),
        }),
        classificationType: Cesium.ClassificationType ? Cesium.ClassificationType.BOTH : undefined,
      },
    });
    heatmapEntityRef.current = entity;
    viewer.scene.requestRender();
  };

  const setHeatmapOpacity = (opacityVal) => {
    const viewer = viewerRef.current;
    if (!viewer || !heatmapEntityRef.current) return;
    const clampedOpacity = Math.max(0, Math.min(1, opacityVal));
    if (heatmapParamsRef.current) {
      heatmapParamsRef.current.opacity = clampedOpacity;
    }
    if (heatmapEntityRef.current.ellipse?.material) {
      heatmapEntityRef.current.ellipse.material.color = Cesium.Color.WHITE.withAlpha(clampedOpacity);
      viewer.scene.requestRender();
    }
  };

  const toggle3DTilt = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pitch = viewer.camera.pitch;
    const is2D = Math.abs(pitch - Cesium.Math.toRadians(-90)) < 0.15;
    const targetPitch = is2D ? Cesium.Math.toRadians(-45) : Cesium.Math.toRadians(-90);
    const targetHeading = is2D ? Cesium.Math.toRadians(25) : 0;
    viewer.camera.flyTo({
      destination: viewer.camera.position,
      orientation: {
        heading: targetHeading,
        pitch: targetPitch,
        roll: 0,
      },
      duration: 1.5,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  };

  const flyHome = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (markerRef.current) { viewer.entities.remove(markerRef.current); markerRef.current = null; }
    clearBoundary();
    removeHeatmap();
    viewer.camera.flyHome(2);
    autoRotateRef.current = true;
  };

  const zoomIn = () => viewerRef.current?.camera.zoomIn(Math.max(viewerRef.current.camera.positionCartographic.height * 0.35, 100));
  const zoomOut = () => viewerRef.current?.camera.zoomOut(Math.max(viewerRef.current.camera.positionCartographic.height * 0.35, 100));
  const resetNorth = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const carto = viewer.camera.positionCartographic;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
      orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 },
    });
  };
  const setAutoRotate = (enabled) => { autoRotateRef.current = enabled; };

  useImperativeHandle(ref, () => ({
    flyToLocation, setMapStyle, flyHome, zoomIn, zoomOut, resetNorth, setAutoRotate, highlightBoundary, recolorBoundary, clearBoundary,
    setHeatmapLayer, setHeatmapOpacity, removeHeatmap, toggle3DTilt,
  }));

  if (webglError) {
    return (
      <div style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 50% 50%, #0c1427 0%, #050811 100%)",
        color: "#94a3b8",
        padding: "30px",
        textAlign: "center"
      }}>
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>🌐</div>
        <h3 style={{ color: "#00d4ff", marginBottom: "8px", fontSize: "20px" }}>3D Earth Visualization</h3>
        <p style={{ maxWidth: "460px", fontSize: "14px", lineHeight: "1.6", marginBottom: "20px" }}>
          Cesium 3D WebGL context could not be acquired or hardware acceleration is restricted. You can toggle to 2D Street View map mode from the top bar or reload.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: "linear-gradient(135deg, #00d4ff, #3b82f6)",
            border: "none",
            color: "#ffffff",
            padding: "10px 24px",
            borderRadius: "8px",
            cursor: "pointer",
            fontWeight: "600"
          }}
        >
          Reload 3D Engine
        </button>
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});

export default Globe;
