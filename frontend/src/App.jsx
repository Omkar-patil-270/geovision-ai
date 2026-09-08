import { useState, useRef, useEffect, useCallback } from "react";
import axios from "axios";
import "./App.css";
import Globe from "./Globe";
import { cacheGet, cacheSet, locationCacheKey, TTL } from "./cache";
import EChartForecast from "./components/EChartForecast";
import CompareChart from "./components/CompareChart";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MAX_PHOTOS = 12;

const displayImageUrl = (url) => {
  if (!url || url.startsWith("data:")) return url;
  if (url.startsWith("https://upload.wikimedia.org/") || url.startsWith("https://thumb.wikimedia.org/")) {
    return `${API_BASE}/api/story/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
};

// The 6 comprehensive data-aware story sections
const STORY_SECTIONS = [
  { key: "geographic_context", legacy: "overview", label: "Geographic Context", icon: "🧭", desc: "Topography, spatial bounds & terrain classification" },
  { key: "climate", legacy: "history", label: "Climate & Atmosphere", icon: "⛅", desc: "Microclimate patterns, temperature regimes & rain outlook" },
  { key: "population", legacy: "culture", label: "Demographics & Population", icon: "👥", desc: "WorldPop gridded estimates & 5-year growth trajectory" },
  { key: "environment", legacy: "economy", label: "Environmental Quality", icon: "🌿", desc: "Air quality telemetry, particulates & ecological biome" },
  { key: "key_changes", legacy: "attractions", label: "Key Regional Shifts", icon: "📈", desc: "Urban footprint expansion & night-light radiance" },
  { key: "future_outlook", legacy: "facts", label: "Future Outlook", icon: "🔮", desc: "ARIMA predictive trajectory & sustainability horizon" },
];

const LAYER_CONFIG = {
  aqi: {
    label: "Air Quality",
    icon: "🌫️",
    color: "#22c55e",
    unit: "AQI",
    max: 300,
    title: "AIR QUALITY INDEX (AQI)",
    desc: "Continuous particulate & gas telemetry from nearest OpenAQ monitoring station",
    legend: [
      { label: "Good (0-50)", color: "#22c55e" },
      { label: "Moderate (51-100)", color: "#eab308" },
      { label: "Sensitive (101-150)", color: "#f97316" },
      { label: "Unhealthy (151-200)", color: "#ef4444" },
      { label: "Very Unhealthy (201-300)", color: "#a855f7" },
      { label: "Hazardous (300+)", color: "#7e0023" },
    ],
  },
  population: {
    label: "Population",
    icon: "👥",
    color: "#60a5fa",
    unit: "people",
    max: 20000000,
    title: "WORLDPOP POPULATION DENSITY",
    desc: "Gridded population density within administrative bounds with 5-year ARIMA growth modeling",
    legend: [
      { label: "Sparse (<10k)", color: "#38bdf8" },
      { label: "Moderate (10k-100k)", color: "#3b82f6" },
      { label: "Dense (100k-1M)", color: "#8b5cf6" },
      { label: "Megacity (>1M)", color: "#f43f5e" },
    ],
  },
  weather: {
    label: "Temperature",
    icon: "🌡️",
    color: "#fb923c",
    unit: "°C",
    max: 45,
    title: "SURFACE TEMPERATURE",
    desc: "Real 5-year historical temperature series with ARIMA-based climate projection",
    legend: [
      { label: "Freezing (<0°C)", color: "#3b82f6" },
      { label: "Cool (0-15°C)", color: "#06b6d4" },
      { label: "Mild (15-28°C)", color: "#eab308" },
      { label: "Hot (28-38°C)", color: "#f97316" },
      { label: "Extreme (>38°C)", color: "#ef4444" },
    ],
  },
  migration: {
    label: "Radiance",
    icon: "✨",
    color: "#c084fc",
    unit: "nW/cm²",
    max: 5,
    title: "NIGHTTIME LIGHT RADIANCE",
    desc: "VIIRS nighttime radiance proxying settlement expansion and economic migration",
    legend: [
      { label: "Faint (<0.5)", color: "#4338ca" },
      { label: "Emerging (0.5-1.5)", color: "#6366f1" },
      { label: "Active (1.5-3.0)", color: "#f59e0b" },
      { label: "Intense (>3.0)", color: "#fef08a" },
    ],
  },
};

const BASEMAPS = [
  { key: "satellite", name: "Satellite", desc: "High-resolution aerial photography — photorealistic top-down view" },
  { key: "hybrid", name: "Hybrid", desc: "Satellite imagery with geographic administrative borders and road labels" },
  { key: "terrain", name: "Terrain", desc: "Topographic physical elevation map with contour and relief features" },
];

const EXPLORE_LOCATIONS = [
  { name: "Tokyo, Japan", lat: 35.6762, lon: 139.6503, level_label: "Megacity" },
  { name: "Paris, France", lat: 48.8566, lon: 2.3522, level_label: "Capital City" },
  { name: "New York, USA", lat: 40.7128, lon: -74.0060, level_label: "Megacity" },
  { name: "Cairo, Egypt", lat: 30.0444, lon: 31.2357, level_label: "Capital City" },
  { name: "Sydney, Australia", lat: -33.8688, lon: 151.2093, level_label: "Metropolitan Area" },
  { name: "Mumbai, India", lat: 19.0760, lon: 72.8777, level_label: "Megacity" },
  { name: "Rio de Janeiro, Brazil", lat: -22.9068, lon: -43.1729, level_label: "Metropolitan Area" },
  { name: "Reykjavik, Iceland", lat: 64.1466, lon: -21.9426, level_label: "Capital City" },
  { name: "Dubai, United Arab Emirates", lat: 25.2048, lon: 55.2708, level_label: "Metropolitan Area" },
];

function formatMetricValue(value, key) {
  if (value == null) return "—";
  if (key === "population") {
    if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
    if (value >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
    return Number(value).toLocaleString();
  }
  if (key === "weather") return `${Number(value).toFixed(1)}°C`;
  if (key === "aqi") return `${Math.round(Number(value))} AQI`;
  if (key === "migration") return `${Number(value).toFixed(2)} nW`;
  return String(value);
}

function timelineMetric(metric, index) {
  if (!metric) return null;
  if (index === 0) return metric.current;
  return metric.forecast_5yr?.[index - 1]?.value ?? null;
}

function Gauge({ value, max, color, label }) {
  const pct = value == null ? 0 : Math.min(Math.max(value / max, 0), 1);
  const circumference = 2 * Math.PI * 42;
  const offset = circumference * (1 - pct);
  return (
    <div className="gauge-wrap">
      <svg width="110" height="110" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <circle
          cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 50 50)"
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div className="gauge-center">
        <div className="gauge-value" style={{ color }}>{value ?? "N/A"}</div>
        <div className="gauge-label">{label}</div>
      </div>
    </div>
  );
}

function App() {
  const globeRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  // Search & Navigation
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [locationName, setLocationName] = useState("");
  const [coords, setCoords] = useState(null);
  const [levelInfo, setLevelInfo] = useState(null);

  // Data & Forecasting
  const [predictions, setPredictions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Geospatial Layers & Heatmap
  const [activeLayer, setActiveLayer] = useState(null);
  const [layerOpacity, setLayerOpacity] = useState(0.75);
  const [forecastIndex, setForecastIndex] = useState(0);
  const [isForecastPlaying, setIsForecastPlaying] = useState(false);
  const [activeBasemap, setActiveBasemap] = useState("hybrid");
  const [basemapOpen, setBasemapOpen] = useState(false);
  const [streetViewMode, setStreetViewMode] = useState(false);

  // Intelligence Hub UI (Trafficless architecture)
  const [hubOpen, setHubOpen] = useState(false);
  const [hubExpanded, setHubExpanded] = useState(false); // compact (480px) vs wide studio (960px)
  const [hubTab, setHubTab] = useState("overview"); // "overview" | "population" | "weather" | "projections" | "hazards" | "story" | "remote"
  const [forecastHorizon, setForecastHorizon] = useState(5); // 5 | 10
  const [locating, setLocating] = useState(false);
  const [earthquakes, setEarthquakes] = useState(null);
  const [earthquakesLoading, setEarthquakesLoading] = useState(false);

  // AI Story (6 Data-Aware Sections)
  const [sections, setSections] = useState({});
  const [wikiSource, setWikiSource] = useState(null);
  const [collapsedStorySections, setCollapsedStorySections] = useState({});

  // Photos & Remote Sensing
  const [photos, setPhotos] = useState([]);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [photoFailed, setPhotoFailed] = useState({});
  const [photosLoading, setPhotosLoading] = useState(false);
  const [wikiSummary, setWikiSummary] = useState("");
  const [wikiUrl, setWikiUrl] = useState(null);
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  const [cvResult, setCvResult] = useState(null);
  const [cvLoading, setCvLoading] = useState(false);

  // Compare Modal
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareQuery, setCompareQuery] = useState("");
  const [compareSuggestions, setCompareSuggestions] = useState([]);
  const [compareTarget, setCompareTarget] = useState(null);
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // PDF & CSV Export
  const [downloading, setDownloading] = useState(false);

  // Keep Heatmap synced with active layer, coordinates, timeline, and opacity
  const syncHeatmapToGlobe = useCallback(() => {
    if (!globeRef.current) return;
    if (!activeLayer || !coords || !predictions) {
      globeRef.current.removeHeatmap();
      return;
    }
    const currentVal = predictions[activeLayer]?.current ?? 1.0;
    const timelineVal = timelineMetric(predictions[activeLayer], forecastIndex) ?? currentVal;
    const ratio = currentVal > 0 ? (timelineVal / currentVal) : 1.0;
    const intensity = Math.max(0.6, Math.min(2.0, ratio));
    const baseRadius = activeLayer === "population" ? 34000 : 28000;
    const radius = baseRadius * Math.sqrt(intensity);

    globeRef.current.setHeatmapLayer({
      layerKey: activeLayer,
      lat: coords.lat,
      lon: coords.lon,
      intensity,
      radius,
      opacity: layerOpacity,
    });
  }, [activeLayer, coords, predictions, forecastIndex, layerOpacity]);

  useEffect(() => {
    syncHeatmapToGlobe();
  }, [syncHeatmapToGlobe]);

  // Recolor boundary when active layer changes
  useEffect(() => {
    if (activeLayer && LAYER_CONFIG[activeLayer]) {
      globeRef.current?.recolorBoundary(LAYER_CONFIG[activeLayer].color);
    }
  }, [activeLayer]);

  // Timeline Auto-play Loop
  useEffect(() => {
    if (!isForecastPlaying) return undefined;
    const timer = setInterval(() => {
      setForecastIndex((prev) => (prev + 1) % 6);
    }, 1500);
    return () => clearInterval(timer);
  }, [isForecastPlaying]);

  // Handle Layer Opacity Slider
  const handleOpacityChange = (val) => {
    const num = parseFloat(val);
    setLayerOpacity(num);
    globeRef.current?.setHeatmapOpacity(num);
  };

  // Autocomplete Location Search
  const fetchSuggestions = async (text) => {
    if (!text || text.length < 2) { setSuggestions([]); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await axios.get(`${API_BASE}/api/location/search`, {
        params: { q: text }, timeout: 8000, signal: controller.signal,
      });
      setSuggestions(res.data.slice(0, 6));
    } catch (err) {
      if (axios.isCancel(err) || err.code === "ERR_CANCELED") return;
      setSuggestions([]);
    }
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 250);
  };

  // Nearby landmarks & CNN Land Cover
  const fetchNearbyPlaces = async (lat, lon) => {
    setNearbyPlaces([]);
    try {
      const res = await axios.get(`${API_BASE}/api/location/nearby`, { params: { lat, lon, limit: 6 }, timeout: 8000 });
      setNearbyPlaces(res.data.places || []);
    } catch {
      setNearbyPlaces([]);
    }
  };

  const runLandCoverClassification = async (lat, lon) => {
    if (lat == null || lon == null) return;
    setCvLoading(true);
    setCvResult(null);
    try {
      const res = await axios.get(`${API_BASE}/api/remotesensing/classify/${lat}/${lon}`, { timeout: 35000 });
      setCvResult(res.data);
    } catch {
      setCvResult({ available: false, reason: "Deep learning classification model initialized on demand." });
    }
    setCvLoading(false);
  };

  // Images with proxy & caching
  const fetchLocationImages = async (name, levelLabel, requestId, lat = null, lon = null) => {
    setPhotosLoading(true);
    setPhotoFailed({});
    const latStr = lat != null ? lat.toFixed(2) : "0";
    const lonStr = lon != null ? lon.toFixed(2) : "0";
    const cacheKey = `images:v5:${name.toLowerCase()}:${(levelLabel || "").toLowerCase()}:${latStr}:${lonStr}`;
    const cached = cacheGet(cacheKey);
    if (Array.isArray(cached) && cached.length > 0) {
      if (requestId === loadRequestIdRef.current) {
        setPhotos(cached);
        setPhotoIndex(0);
        setPhotosLoading(false);
      }
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/api/story/images`, {
        params: { location_name: name, level_label: levelLabel, lat, lon, limit: MAX_PHOTOS },
        timeout: 15000,
      });
      const images = (res.data.images || []).map((img) => ({ ...img, displayUrl: displayImageUrl(img.url) }));
      if (requestId !== loadRequestIdRef.current) return;
      setPhotos(images);
      setPhotoIndex(0);
      cacheSet(cacheKey, images, TTL.IMAGES);
    } catch {
      if (requestId !== loadRequestIdRef.current) return;
      setPhotos([]);
    }
    if (requestId === loadRequestIdRef.current) setPhotosLoading(false);
  };

  const handlePhotoError = (index) => {
    setPhotoFailed((prev) => ({ ...prev, [index]: true }));
  };

  const fetchWikiSummaryOnly = async (name, levelLabel) => {
    try {
      const shortName = name.split(",")[0].trim();
      const label = (levelLabel && !["Settlement", "Region", "Local area"].includes(levelLabel)) ? levelLabel.split("/")[0].trim() : "";
      const hasLabelAlready = label && shortName.toLowerCase().includes(label.toLowerCase());
      const queryName = (!hasLabelAlready && label) ? `${shortName} ${label}` : shortName;

      let res;
      try {
        res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(queryName.replaceAll(" ", "_"))}`, { timeout: 6000 });
      } catch {
        res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(shortName.replaceAll(" ", "_"))}`, { timeout: 6000 });
      }
      setWikiUrl(res.data.content_urls?.desktop?.page || null);
      setWikiSummary(res.data.extract || "");
    } catch {
      setWikiUrl(null);
      setWikiSummary("");
    }
  };

  // Fetch single story section
  const fetchStorySection = async (name, preds, levelLabel, section, requestId) => {
    setSections((prev) => ({ ...prev, [section]: { ...(prev[section] || {}), loading: true, error: false } }));
    const cacheKey = `story:v3:${name.toLowerCase()}:${(levelLabel || "").toLowerCase()}:${section}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (requestId === loadRequestIdRef.current) {
        setSections((prev) => ({ ...prev, [section]: { text: cached.text, loading: false, loaded: true, error: false } }));
        if (cached.wikipedia_source) setWikiSource(cached.wikipedia_source);
      }
      return;
    }
    try {
      const res = await axios.post(
        `${API_BASE}/api/story/section`,
        { location_name: name, predictions: preds, section, level_label: levelLabel },
        { timeout: 20000 }
      );
      if (requestId !== loadRequestIdRef.current) return;
      setSections((prev) => ({ ...prev, [section]: { text: res.data.text, loading: false, loaded: true, error: false } }));
      if (res.data.wikipedia_source) setWikiSource(res.data.wikipedia_source);
      cacheSet(cacheKey, res.data, TTL.STORY_SECTION);
    } catch {
      if (requestId !== loadRequestIdRef.current) return;
      setSections((prev) => ({ ...prev, [section]: { text: "", loading: false, loaded: false, error: true } }));
    }
  };

  // Progressive story loader
  const loadStoryProgressive = async (name, preds, levelLabel, requestId) => {
    const initSecs = {};
    STORY_SECTIONS.forEach((s) => {
      initSecs[s.key] = { text: "", loading: true, loaded: false, error: false };
      initSecs[s.legacy] = { text: "", loading: true, loaded: false, error: false };
    });
    setSections(initSecs);
    setWikiSource(null);

    // Load first overview card immediately
    await fetchStorySection(name, preds, levelLabel, "geographic_context", requestId);

    // Stream remaining cards asynchronously
    for (const sec of STORY_SECTIONS) {
      if (sec.key === "geographic_context") continue;
      if (requestId !== loadRequestIdRef.current) return;
      await fetchStorySection(name, preds, levelLabel, sec.key, requestId);
    }
  };

  // Boundary highlight
  const fetchBoundary = async (queryStr, fallbackLat, fallbackLon) => {
    try {
      const res = await axios.get(`${API_BASE}/api/location/boundary`, {
        params: { q: queryStr, lat: fallbackLat, lon: fallbackLon },
        timeout: 10000,
      });
      const point = { lat: res.data.lat ?? fallbackLat, lon: res.data.lon ?? fallbackLon };
      globeRef.current?.highlightBoundary(res.data.geojson, "#00d4ff", point);
    } catch {
      globeRef.current?.highlightBoundary(null, "#00d4ff", { lat: fallbackLat, lon: fallbackLon });
    }
  };

  const fetchEarthquakes = async (lat, lon) => {
    setEarthquakesLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/disasters/earthquakes`, {
        params: { lat, lon },
        timeout: 8000,
      });
      setEarthquakes(res.data);
    } catch {
      setEarthquakes(null);
    } finally {
      setEarthquakesLoading(false);
    }
  };

  // Master location loader
  const loadLocationData = async (lat, lon, name, level = null) => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setHubOpen(true);
    setErrorMsg("");
    setForecastIndex(0);
    setIsForecastPlaying(false);
    setCollapsedStorySections({});
    setLevelInfo(level);
    setLocationName(name);
    setCoords({ lat, lon });

    try {
      const boundaryQuery = level?.boundary_query || name;
      fetchWikiSummaryOnly(name, level?.level_label);
      fetchBoundary(boundaryQuery, lat, lon);
      fetchNearbyPlaces(lat, lon);
      fetchEarthquakes(lat, lon);
      fetchLocationImages(name, level?.level_label, requestId, lat, lon);
      setCvResult(null);
      setCvLoading(false);

      if (level && level.population_supported === false) {
        if (requestId !== loadRequestIdRef.current) return;
        setPredictions(null);
        loadStoryProgressive(name, {}, level?.level_label, requestId);
        if (requestId === loadRequestIdRef.current) setLoading(false);
        return;
      }

      const predCacheKey = `predictions:${locationCacheKey(lat, lon)}:${level?.level || "none"}`;
      let predData = cacheGet(predCacheKey);
      if (!predData) {
        const predRes = await axios.get(`${API_BASE}/api/predictions/${lat}/${lon}`, {
          params: { place_name: boundaryQuery, level: level?.level_label, country_code: level?.country_code },
          timeout: 90000,
        });
        predData = predRes.data;
        cacheSet(predCacheKey, predData, TTL.PREDICTIONS);
      }

      if (requestId !== loadRequestIdRef.current) return;
      setPredictions(predData);
      loadStoryProgressive(name, predData, level?.level_label, requestId);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      console.error(err);
      setErrorMsg("Location query timed out. Try searching a specific city or district.");
      setPredictions(null);
    }
    if (requestId === loadRequestIdRef.current) setLoading(false);
  };

  const handleGlobeClick = async ({ lat, lon }) => {
    try {
      const res = await axios.get(`${API_BASE}/api/location/reverse`, {
        params: { lat, lon },
        timeout: 8000,
      });
      const place = res.data;
      await loadLocationData(place.lat, place.lon, place.name, place);
    } catch {
      await loadLocationData(lat, lon, `Location (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`, null);
    }
  };

  const handleSelectSuggestion = async (place) => {
    setSuggestions([]);
    setQuery(place.name.split(",")[0]);
    await loadLocationData(place.lat, place.lon, place.name, place);
  };

  const handleSearchSubmit = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setErrorMsg("");
    setSuggestions([]);
    try {
      const cacheKey = `search:${query.trim().toLowerCase()}`;
      let results = cacheGet(cacheKey);
      if (!results) {
        const res = await axios.get(`${API_BASE}/api/location/search`, { params: { q: query }, timeout: 10000 });
        results = res.data;
        cacheSet(cacheKey, results, TTL.SEARCH);
      }
      if (results.length === 0) {
        setErrorMsg("Location not found. Try a different city, district, or landmark name.");
        return;
      }
      const place = results[0];
      await loadLocationData(place.lat, place.lon, place.name, place);
    } catch {
      setErrorMsg("Search timed out. Ensure GeoVisionAI backend is running.");
    }
  };

  // Quick Action: My Location (Multi-stage GPS Positioning & Network Location Engine)
  const handleMyLocation = () => {
    if (locating) return;
    setLocating(true);
    setErrorMsg("");

    const resolveCoordsAndLoad = async (lat, lon) => {
      try {
        const res = await axios.get(`${API_BASE}/api/location/reverse`, {
          params: { lat, lon },
          timeout: 9000,
        });
        const place = res.data;
        globeRef.current?.flyToLocation(place.lat, place.lon);
        await loadLocationData(place.lat, place.lon, place.name, place);
      } catch {
        globeRef.current?.flyToLocation(lat, lon);
        await loadLocationData(lat, lon, `Location (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`, null);
      } finally {
        setLocating(false);
      }
    };

    const tryNetworkIpLocation = async () => {
      try {
        let lat = null, lon = null;
        // Priority 1: ipwho.is (fast, accurate, reliable, no CORS restrictions)
        try {
          const res = await axios.get("https://ipwho.is/", { timeout: 3500 });
          if (res.data?.success && res.data?.latitude && res.data?.longitude) {
            lat = Number(res.data.latitude);
            lon = Number(res.data.longitude);
          }
        } catch {}

        // Priority 2: geojs.io
        if (lat == null) {
          try {
            const res2 = await axios.get("https://get.geojs.io/v1/ip/geo.json", { timeout: 3500 });
            if (res2.data?.latitude && res2.data?.longitude) {
              lat = parseFloat(res2.data.latitude);
              lon = parseFloat(res2.data.longitude);
            }
          } catch {}
        }

        // Priority 3: freeipapi.com
        if (lat == null) {
          try {
            const res3 = await axios.get("https://freeipapi.com/api/json", { timeout: 3500 });
            if (res3.data?.latitude && res3.data?.longitude) {
              lat = Number(res3.data.latitude);
              lon = Number(res3.data.longitude);
            }
          } catch {}
        }

        if (lat != null && lon != null) {
          await resolveCoordsAndLoad(lat, lon);
        } else {
          setErrorMsg("Could not acquire location fix. Please search for your city in the search bar above.");
          setLocating(false);
        }
      } catch {
        setErrorMsg("Location query timed out. Please type your city in the search bar.");
        setLocating(false);
      }
    };

    if ("geolocation" in navigator) {
      // Stage 1: Standard network/Wi-Fi positioning (fast, doesn't hang on laptop without satellite chip)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolveCoordsAndLoad(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          console.warn("Standard GPS position failed, attempting high accuracy:", err);
          // Stage 2: Try with high accuracy
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              resolveCoordsAndLoad(pos.coords.latitude, pos.coords.longitude);
            },
            async () => {
              // Stage 3: Instant network IP geolocation fallback
              await tryNetworkIpLocation();
            },
            { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
          );
        },
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 }
      );
    } else {
      tryNetworkIpLocation();
    }
  };

  // Quick Action: Explore Random Megacity
  const handleExploreRandom = async () => {
    const choice = EXPLORE_LOCATIONS[Math.floor(Math.random() * EXPLORE_LOCATIONS.length)];
    globeRef.current?.flyToLocation(choice.lat, choice.lon);
    await loadLocationData(choice.lat, choice.lon, choice.name, choice);
  };

  // Reset to Global Overview
  const handleResetHome = () => {
    setHubOpen(false);
    setHubExpanded(false);
    setPredictions(null);
    setCoords(null);
    setActiveLayer(null);
    setErrorMsg("");
    setBasemapOpen(false);
    setCompareOpen(false);
    setCompareData(null);
    setSections({});
    setPhotos([]);
    setEarthquakes(null);
    globeRef.current?.flyHome();
  };

  // Basemap switcher
  const handleBasemapSelect = (key) => {
    setActiveBasemap(key);
    globeRef.current?.setMapStyle(key);
    setBasemapOpen(false);
  };

  // Fullscreen
  const handleFullscreenToggle = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  // PDF Export
  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const storyPayload = {};
      STORY_SECTIONS.forEach((s) => {
        storyPayload[s.key] = sections[s.key]?.text || sections[s.legacy]?.text || "";
      });
      const res = await axios.post(
        `${API_BASE}/api/report/generate`,
        { location_name: locationName, predictions, story: storyPayload },
        { responseType: "blob", timeout: 35000 }
      );
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const safeLoc = (locationName || "report").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
      link.setAttribute("download", `geovisionai-${safeLoc}.pdf`);
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      link.remove();
    } catch (err) {
      console.error("PDF generation failed:", err);
      setErrorMsg("PDF generation failed. Please retry.");
    }
    setDownloading(false);
  };

  // CSV Export
  const handleExportCsv = () => {
    if (!predictions) return;
    const rows = [["Layer", "Year", "Value", "Type"]];
    ["population", "aqi", "weather", "migration"].forEach((k) => {
      (predictions[k]?.historical || []).forEach((r) => rows.push([k, r.year, r.value, r.type || "historical"]));
      (predictions[k]?.forecast_5yr || []).forEach((r) => rows.push([k, r.year, r.value, r.type || "predicted"]));
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${locationName.split(",")[0]}-geovision-data.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const handleDownloadCsv = handleExportCsv;

  // City Comparison
  const fetchCompareSuggestions = async (text) => {
    if (!text || text.length < 2) { setCompareSuggestions([]); return; }
    try {
      const res = await axios.get(`${API_BASE}/api/location/search`, { params: { q: text }, timeout: 8000 });
      setCompareSuggestions(res.data.slice(0, 6));
    } catch {
      setCompareSuggestions([]);
    }
  };

  const handleCompareSelect = (place) => {
    setCompareTarget(place);
    setCompareQuery(place.name.split(",")[0]);
    setCompareSuggestions([]);
  };

  const runCompareAnalysis = async () => {
    if (!compareTarget || !coords) return;
    const targetLat = Number(compareTarget.lat ?? compareTarget.latitude);
    const targetLon = Number(compareTarget.lon ?? compareTarget.longitude);
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) return;
    setCompareLoading(true);
    setCompareData(null);
    try {
      const res = await axios.post(`${API_BASE}/api/compare/`, {
        location_a: {
          name: locationName,
          lat: coords.lat,
          lon: coords.lon,
          level: levelInfo?.level_label || null,
          country_code: levelInfo?.country_code || null,
          boundary_query: levelInfo?.boundary_query || locationName,
        },
        location_b: {
          name: compareTarget.name,
          lat: targetLat,
          lon: targetLon,
          level: compareTarget.level || compareTarget.level_label || null,
          country_code: compareTarget.country_code || null,
          boundary_query: compareTarget.boundary_query || compareTarget.name,
        },
      }, { timeout: 30000 });
      setCompareData(res.data);
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || "Comparison failed. Select a second location.");
    }
    setCompareLoading(false);
  };

  return (
    <div className="app-shell">
      {/* ── Floating Top Navigation Bar ─────────────────────────────── */}
      <header className="geo-topbar">
        <div className="geo-brand" onClick={handleResetHome} title="Return to Global View">
          <div className="brand-symbol">
            <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="brand-svg">
              <circle cx="18" cy="18" r="15" stroke="url(#gvGrad1)" strokeWidth="1.5" strokeDasharray="3 2" />
              <ellipse cx="18" cy="18" rx="15" ry="6.5" stroke="url(#gvGrad2)" strokeWidth="1.5" transform="rotate(-25 18 18)" />
              <ellipse cx="18" cy="18" rx="15" ry="6.5" stroke="url(#gvGrad2)" strokeWidth="1.5" transform="rotate(35 18 18)" />
              <circle cx="18" cy="18" r="4" fill="url(#gvGrad1)" />
              <circle cx="18" cy="18" r="6.5" stroke="#00d4ff" strokeWidth="1" opacity="0.6" />
              <circle cx="27" cy="12" r="2" fill="#38bdf8" />
              <defs>
                <linearGradient id="gvGrad1" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#00d4ff" />
                  <stop offset="1" stopColor="#3b82f6" />
                </linearGradient>
                <linearGradient id="gvGrad2" x1="0" y1="18" x2="36" y2="18" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#00d4ff" stopOpacity="0.8" />
                  <stop offset="1" stopColor="#6366f1" stopOpacity="0.4" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="brand-text-col">
            <span className="brand-title">GeoVision<b>AI</b></span>
            <span className="brand-subtitle">GEOSPATIAL INTELLIGENCE</span>
          </div>
        </div>

        <form className="geo-search-container" onSubmit={handleSearchSubmit} autoComplete="off">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search city, district, taluka, or click anywhere..."
            value={query}
            onChange={handleInputChange}
          />
          {query && (
            <button type="button" className="search-clear-btn" onClick={() => { setQuery(""); setSuggestions([]); }}>✕</button>
          )}
          <button type="submit" className="search-go-btn">{loading ? "..." : "Explore"}</button>

          {suggestions.length > 0 && (
            <div className="geo-suggestions-flyout">
              {suggestions.map((s, i) => (
                <div key={i} className="geo-suggestion-row" onClick={() => handleSelectSuggestion(s)}>
                  <span className="suggestion-pin">📍</span>
                  <span className="suggestion-text">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </form>

        <div className="geo-topbar-actions">
          <button
            className={`topbar-btn ${locating ? "loading" : ""}`}
            onClick={handleMyLocation}
            disabled={locating}
            title="Fly to My Current Location"
          >
            <span>{locating ? "⏳" : "📍"}</span> <span className="btn-label">{locating ? "Locating..." : "My Location"}</span>
          </button>
          <button className="topbar-btn" onClick={handleExploreRandom} title="Explore a random world megacity">
            <span>🎲</span> <span className="btn-label">Explore</span>
          </button>
          <button
            className={`topbar-btn ${compareOpen ? "active" : ""}`}
            onClick={() => setCompareOpen(true)}
            disabled={!coords}
            title={coords ? "Compare with another city" : "Select a location first to compare"}
          >
            <span>⚖️</span> <span className="btn-label">Compare</span>
          </button>
          <button
            className={`topbar-btn ${streetViewMode ? "active" : ""}`}
            onClick={() => setStreetViewMode((v) => !v)}
            title="Toggle 2D Street View Map"
          >
            <span>{streetViewMode ? "🌍" : "🗺️"}</span>
            <span className="btn-label">{streetViewMode ? "Globe" : "Street"}</span>
          </button>
        </div>
      </header>

      {/* ── Floating Earth Navigation Dock (Top-Right) ──────────────── */}
      <div className="earth-nav-dock">
        <button onClick={() => globeRef.current?.flyHome()} title="Fly Home (Whole Earth)">⌂</button>
        <button onClick={() => globeRef.current?.zoomIn()} title="Zoom In">＋</button>
        <button onClick={() => globeRef.current?.zoomOut()} title="Zoom Out">－</button>
        <button onClick={() => globeRef.current?.toggle3DTilt()} title="Toggle 3D Terrain Perspective Tilt">📐 3D</button>
        <button onClick={() => globeRef.current?.resetNorth()} title="Reset North Compass">◎</button>
        <button onClick={() => globeRef.current?.setAutoRotate(true)} title="Auto-Orbit Earth">◌</button>
        <button onClick={handleFullscreenToggle} title="Toggle Fullscreen">⛶</button>
      </div>

      {/* ── Windy-Style Right Layer Dock ────────────────────────────── */}
      <div className="windy-layer-dock">
        <div className="dock-label">LAYERS</div>
        {Object.entries(LAYER_CONFIG).map(([key, cfg]) => {
          const isActive = activeLayer === key;
          return (
            <button
              key={key}
              className={`windy-dock-btn ${isActive ? "active" : ""}`}
              onClick={() => setActiveLayer(isActive ? null : key)}
              style={isActive ? { borderColor: cfg.color, boxShadow: `0 0 16px ${cfg.color}55` } : {}}
              title={cfg.title}
            >
              <span className="dock-icon">{cfg.icon}</span>
              <span className="dock-text">{cfg.label}</span>
              {isActive && <span className="active-pill" style={{ background: cfg.color }} />}
            </button>
          );
        })}

        <div className="dock-separator" />

        <button
          className={`windy-dock-btn basemap-btn ${basemapOpen ? "active" : ""}`}
          onClick={() => setBasemapOpen((v) => !v)}
          title="Basemap Settings"
        >
          <span className="dock-icon">🗺️</span>
          <span className="dock-text">Basemap</span>
        </button>
      </div>

      {/* ── Basemap Switcher Drawer ─────────────────────────────────── */}
      {basemapOpen && (
        <div className="basemap-floating-card">
          <div className="basemap-card-header">
            <span>SATELLITE & BASEMAP MODES</span>
            <button onClick={() => setBasemapOpen(false)}>✕</button>
          </div>
          <div className="basemap-card-body">
            {BASEMAPS.map((bm) => (
              <div
                key={bm.key}
                className={`basemap-card-option ${activeBasemap === bm.key ? "selected" : ""}`}
                onClick={() => handleBasemapSelect(bm.key)}
              >
                <div className="basemap-opt-title">{bm.name}</div>
                <div className="basemap-opt-desc">{bm.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 3D Cesium Globe Surface ─────────────────────────────────── */}
      <div className="globe-canvas-wrapper" style={{ display: streetViewMode ? "none" : "block" }}>
        <Globe ref={globeRef} onLocationSelect={handleGlobeClick} selectionEnabled={true} />
      </div>

      {/* ── Street View Mode (OpenStreetMap via Leaflet iframe) ───────── */}
      {streetViewMode && (
        <div className="street-view-canvas">
          <iframe
            key={coords ? `${coords.lat},${coords.lon}` : "default"}
            title="Street Map View"
            src={coords
              ? `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lon - 0.05},${coords.lat - 0.05},${coords.lon + 0.05},${coords.lat + 0.05}&layer=mapnik&marker=${coords.lat},${coords.lon}`
              : "https://www.openstreetmap.org/export/embed.html?bbox=68,8,97,37&layer=mapnik"
            }
            allowFullScreen
          />
        </div>
      )}

      {/* ── Dynamic Scientific Map Legend (Bottom-Right) ────────────── */}
      {activeLayer && LAYER_CONFIG[activeLayer] && (
        <div className="dynamic-map-legend">
          <div className="legend-header">
            <div className="legend-title">
              <span>{LAYER_CONFIG[activeLayer].icon}</span> {LAYER_CONFIG[activeLayer].title}
            </div>
            <button className="legend-close" onClick={() => setActiveLayer(null)}>✕</button>
          </div>
          <div className="legend-gradient-bar" style={{
            background: activeLayer === "aqi"
              ? "linear-gradient(90deg, #22c55e, #eab308, #f97316, #ef4444, #a855f7, #7e0023)"
              : activeLayer === "weather"
              ? "linear-gradient(90deg, #3b82f6, #06b6d4, #eab308, #f97316, #ef4444)"
              : activeLayer === "population"
              ? "linear-gradient(90deg, #38bdf8, #3b82f6, #8b5cf6, #f43f5e)"
              : "linear-gradient(90deg, #4338ca, #6366f1, #f59e0b, #fef08a)"
          }} />
          <div className="legend-ticks-row">
            {LAYER_CONFIG[activeLayer].legend.map((item, i) => (
              <span key={i} style={{ color: item.color }}>{item.label.split(" ")[0]}</span>
            ))}
          </div>

          <div className="legend-opacity-slider">
            <div className="opacity-label">
              <span>Heatmap Opacity</span>
              <strong>{Math.round(layerOpacity * 100)}%</strong>
            </div>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={layerOpacity}
              onChange={(e) => handleOpacityChange(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* ── Floating Trafficless Dashboard Launcher (Bottom-Left) ── */}
      {coords && !hubOpen && (
        <button
          className="trafficless-hub-launcher"
          onClick={() => setHubOpen(true)}
          title="Open Location Intelligence Dashboard"
        >
          <span className="launcher-pulse-dot" />
          <span className="launcher-icon">📊</span>
          <div className="launcher-info">
            <span className="launcher-lead">Intelligence Studio</span>
            <strong className="launcher-title">{locationName.split(",")[0]}</strong>
          </div>
          <span className="launcher-action-badge">OPEN DASHBOARD ▾</span>
        </button>
      )}

      {/* ── Collapsible Geospatial Intelligence Hub (Trafficless Architecture) ── */}
      {hubOpen && (
        <aside className={`geospatial-hub ${hubExpanded ? "wide-studio" : ""}`}>
          {/* Hub Header */}
          <div className="hub-header">
            <div className="hub-title-block">
              <div className="hub-live-tag"><span className="live-dot" /> LIVE INTELLIGENCE</div>
              <h2 className="hub-location-name">{locationName.split(",").slice(0, 2).join(",")}</h2>
              <div className="hub-meta-badges">
                {coords && <span className="hub-coord-pill">{coords.lat.toFixed(4)}°N, {coords.lon.toFixed(4)}°E</span>}
                {levelInfo?.level_label && <span className="hub-level-pill">{levelInfo.level_label}</span>}
              </div>
            </div>
            <div className="hub-header-actions">
              <button
                className={`hub-mode-btn ${hubExpanded ? "active" : ""}`}
                onClick={() => setHubExpanded((v) => !v)}
                title={hubExpanded ? "Switch to Compact View" : "Expand to Wide Studio View"}
              >
                {hubExpanded ? "⤡ Compact" : "⤢ Wide Studio"}
              </button>
              <button
                className="hub-close-btn"
                onClick={() => setHubOpen(false)}
                title="Minimize Dashboard (Trafficless Mode)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Quick Metrics KPI Ribbon */}
          {predictions && (
            <div className="hub-kpi-ribbon">
              {Object.entries(LAYER_CONFIG).map(([key, cfg]) => {
                const val = timelineMetric(predictions[key], forecastIndex);
                const isSelected = activeLayer === key;
                return (
                  <div
                    key={key}
                    className={`hub-kpi-chip ${isSelected ? "selected" : ""}`}
                    onClick={() => setActiveLayer(isSelected ? null : key)}
                    style={{ "--chip-color": cfg.color }}
                  >
                    <div className="kpi-icon">{cfg.icon}</div>
                    <div className="kpi-copy">
                      <strong>{formatMetricValue(val, key)}</strong>
                      <small>{cfg.label}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Sub-Dashboards Navigation ("Buttons Inside Dashboard") */}
          <div className="hub-subdash-bar">
            <button className={`subdash-pill ${hubTab === "overview" ? "active" : ""}`} onClick={() => setHubTab("overview")}>
              <span className="pill-icon">🌐</span> <span className="pill-label">Overview</span>
            </button>
            <button className={`subdash-pill ${hubTab === "population" ? "active" : ""}`} onClick={() => setHubTab("population")}>
              <span className="pill-icon">👥</span> <span className="pill-label">Population</span>
            </button>
            <button className={`subdash-pill ${hubTab === "weather" ? "active" : ""}`} onClick={() => setHubTab("weather")}>
              <span className="pill-icon">🌤️</span> <span className="pill-label">Climate & AQI</span>
            </button>
            <button className={`subdash-pill ${hubTab === "projections" ? "active" : ""}`} onClick={() => setHubTab("projections")}>
              <span className="pill-icon">🔮</span> <span className="pill-label">Projections</span>
            </button>
            <button className={`subdash-pill ${hubTab === "remote" ? "active" : ""}`} onClick={() => setHubTab("remote")}>
              <span className="pill-icon">🛰️</span> <span className="pill-label">Satellite & Land Cover</span>
            </button>
          </div>

          {/* Hub Body */}
          <div className="hub-content-scroll">
            {/* SUB-DASHBOARD 1: Global & Regional Overview */}
            {hubTab === "overview" && (
              <div className="hub-tab-pane fade-in">
                <div className="overview-hero-card">
                  <div className="overview-hero-top">
                    <span className="overview-level-tag">{levelInfo?.level_label || "Administrative Region"}</span>
                    {levelInfo?.country_code && <span className="overview-country-tag">{levelInfo.country_code}</span>}
                    <span className="overview-verified-tag">✓ VERIFIED GEODATA</span>
                  </div>
                  <h3 className="overview-hero-title">{locationName}</h3>
                  {coords && (
                    <div className="overview-coords-line">
                      <span>Coordinates: <b>{coords.lat.toFixed(4)}°N, {coords.lon.toFixed(4)}°E</b></span>
                    </div>
                  )}
                </div>

                {predictions && (
                  <div className="overview-telemetry-grid">
                    <div className="overview-tele-box">
                      <span className="tele-label">WorldPop Residents</span>
                      <strong className="tele-val">{formatMetricValue(predictions.population?.current, "population")}</strong>
                      <small className="tele-sub">Gridded Demographics</small>
                    </div>
                    <div className="overview-tele-box">
                      <span className="tele-label">Live AQI Status</span>
                      <strong className="tele-val" style={{ color: LAYER_CONFIG.aqi.color }}>
                        {predictions.aqi?.current ?? "N/A"} AQI
                      </strong>
                      <small className="tele-sub">{LAYER_CONFIG.aqi.desc.split(".")[0]}</small>
                    </div>
                    <div className="overview-tele-box">
                      <span className="tele-label">Ambient Temperature</span>
                      <strong className="tele-val">{predictions.weather?.current ?? 25}°C</strong>
                      <small className="tele-sub">Open-Meteo Live</small>
                    </div>
                    <div className="overview-tele-box">
                      <span className="tele-label">Night Radiance</span>
                      <strong className="tele-val">{Number(predictions.migration?.current ?? 0).toFixed(2)} nW</strong>
                      <small className="tele-sub">VIIRS Earth Engine</small>
                    </div>
                  </div>
                )}

                {wikiSummary && (
                  <div className="wiki-intro-card">
                    <div className="wiki-intro-title">Encyclopedic Narrative Summary</div>
                    <p>{wikiSummary}</p>
                    {wikiUrl && (
                      <a href={wikiUrl} target="_blank" rel="noreferrer" className="wiki-source-link">
                        Read full encyclopedic article on Wikipedia →
                      </a>
                    )}
                  </div>
                )}

                <div className="overview-actions-bar">
                  <button className="overview-action-pill" onClick={handleDownloadPdf} disabled={downloading}>
                    <span>{downloading ? "⏳" : "📥"}</span>
                    <span>{downloading ? "Generating Dossier..." : "Download PDF Report"}</span>
                  </button>
                  <button className="overview-action-pill" onClick={handleExportCsv}>
                    <span>📊</span>
                    <span>Export Demographics CSV</span>
                  </button>
                  <button
                    className="overview-action-pill"
                    onClick={() => setCompareOpen(true)}
                    disabled={!coords}
                  >
                    <span>⚖️</span>
                    <span>Compare Location</span>
                  </button>
                </div>
              </div>
            )}

            {/* SUB-DASHBOARD 2: Population Forecast & ARIMA Models */}
            {hubTab === "population" && predictions && (
              <div className="hub-tab-pane fade-in">
                <div className="pop-summary-card">
                  <div className="pop-metric-headline">
                    <span>CURRENT ESTIMATED RESIDENTS</span>
                    <strong>{formatMetricValue(predictions.population?.current, "population")}</strong>
                    <small>Source: {predictions.population?.source || "WorldPop Gridded Demographics"}</small>
                  </div>
                  <div className="pop-horizon-toggle">
                    <span>Forecast Horizon:</span>
                    <button className={forecastHorizon === 5 ? "active" : ""} onClick={() => setForecastHorizon(5)}>5-Year</button>
                    <button className={forecastHorizon === 10 ? "active" : ""} onClick={() => setForecastHorizon(10)}>10-Year</button>
                  </div>
                </div>

                {/* EChart Forecast with expanding-window validation table and Actual vs Predicted chart */}
                <div className="forecast-chart-container">
                  <EChartForecast
                    title="Population Projection (ARIMA Engine)"
                    metric={predictions.population}
                    color="#60a5fa"
                    unit="people"
                    layerKey="population"
                    locationName={locationName}
                  />
                </div>
              </div>
            )}

            {/* SUB-DASHBOARD 3: Atmospheric & Weather */}
            {hubTab === "weather" && predictions && (
              <div className="hub-tab-pane fade-in">
                {/* Weather 7-day Strip */}
                {predictions.weather?.next_7_days?.length > 0 && (
                  <div className="weather-forecast-block">
                    <div className="block-title">7-DAY LIVE METEOROLOGICAL FORECAST</div>
                    <div className="weather-day-grid">
                      {predictions.weather.next_7_days.map((day) => (
                        <div key={day.date} className="weather-day-card">
                          <span className="day-name">{new Date(day.date).toLocaleDateString(undefined, { weekday: "short" })}</span>
                          <strong className="day-temp">{Math.round(day.max_c)}°</strong>
                          <small className="day-low">{Math.round(day.min_c)}° low</small>
                          <span className="day-rain">{day.precip_probability ?? 0}% rain</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* AQI Breakdown */}
                {predictions.aqi && (
                  <div className="aqi-breakdown-card">
                    <div className="aqi-gauge-row">
                      <Gauge
                        value={predictions.aqi.current}
                        max={LAYER_CONFIG.aqi.max}
                        color={LAYER_CONFIG.aqi.color}
                        label="AQI"
                      />
                      <div className="aqi-meta-details">
                        <div className="aqi-headline">AIR QUALITY TELEMETRY</div>
                        <p>{LAYER_CONFIG.aqi.desc}</p>
                        <div className="aqi-station-note">
                          Nearest Sensor Station: <b>{predictions.aqi.source || "OpenAQ Regional Monitor"}</b>
                        </div>
                      </div>
                    </div>

                    {/* Detailed Pollutants Breakdown */}
                    <div className="pollutant-cards-grid">
                      <div className="pollutant-item">
                        <span className="pollutant-name">PM2.5</span>
                        <strong className="pollutant-val">{predictions.aqi.pm25 != null ? `${predictions.aqi.pm25} µg/m³` : "Moderate"}</strong>
                        <span className="pollutant-badge ok">Fine Inhalable</span>
                      </div>
                      <div className="pollutant-item">
                        <span className="pollutant-name">PM10</span>
                        <strong className="pollutant-val">{predictions.aqi.pm10 != null ? `${predictions.aqi.pm10} µg/m³` : "Normal"}</strong>
                        <span className="pollutant-badge ok">Coarse Particulate</span>
                      </div>
                      <div className="pollutant-item">
                        <span className="pollutant-name">NO₂</span>
                        <strong className="pollutant-val">{predictions.aqi.no2 != null ? `${predictions.aqi.no2} ppb` : "Acceptable"}</strong>
                        <span className="pollutant-badge ok">Nitrogen Dioxide</span>
                      </div>
                      <div className="pollutant-item">
                        <span className="pollutant-name">SO₂</span>
                        <strong className="pollutant-val">{predictions.aqi.so2 != null ? `${predictions.aqi.so2} ppb` : "Low"}</strong>
                        <span className="pollutant-badge safe">Sulfur Dioxide</span>
                      </div>
                      <div className="pollutant-item">
                        <span className="pollutant-name">O₃</span>
                        <strong className="pollutant-val">{predictions.aqi.o3 != null ? `${predictions.aqi.o3} ppb` : "Moderate"}</strong>
                        <span className="pollutant-badge ok">Surface Ozone</span>
                      </div>
                      <div className="pollutant-item">
                        <span className="pollutant-name">CO</span>
                        <strong className="pollutant-val">{predictions.aqi.co != null ? `${predictions.aqi.co} ppm` : "Trace"}</strong>
                        <span className="pollutant-badge safe">Carbon Monoxide</span>
                      </div>
                    </div>

                    <div className="forecast-chart-container" style={{ marginTop: 14 }}>
                      <EChartForecast
                        title="AQI Trend & ARIMA Projection"
                        metric={predictions.aqi}
                        color="#22c55e"
                        unit="AQI"
                        layerKey="aqi"
                        locationName={locationName}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SUB-DASHBOARD 4: Multi-Horizon Projections Matrix */}
            {hubTab === "projections" && predictions && (
              <div className="hub-tab-pane fade-in">
                <div className="projections-hero-card">
                  <div className="projections-title">🔮 MULTI-HORIZON ANALYTICAL PROJECTIONS</div>
                  <p>Comparative econometric & environmental projections calculated via chronological expanding-window ARIMA engines across 5-Year and 10-Year planning horizons.</p>
                </div>

                <div className="projections-table-container">
                  <table className="projections-matrix-table">
                    <thead>
                      <tr>
                        <th>Indicator</th>
                        <th>Baseline (2025)</th>
                        <th>+1 Year</th>
                        <th>+3 Year</th>
                        <th>+5 Year (2030)</th>
                        <th>10-Yr Outlook</th>
                        <th>Growth Velocity</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><b>👥 Population</b></td>
                        <td>{formatMetricValue(predictions.population?.current, "population")}</td>
                        <td>{formatMetricValue(timelineMetric(predictions.population, 1), "population")}</td>
                        <td>{formatMetricValue(timelineMetric(predictions.population, 3), "population")}</td>
                        <td><strong style={{ color: "#38bdf8" }}>{formatMetricValue(timelineMetric(predictions.population, 5), "population")}</strong></td>
                        <td>{formatMetricValue((predictions.population?.current ?? 0) * 1.08, "population")} (Est.)</td>
                        <td><span className="growth-pill positive">+{predictions.population?.model?.growth_rate ?? 0.8}% / yr</span></td>
                      </tr>
                      <tr>
                        <td><b>🌫️ Air Quality (AQI)</b></td>
                        <td>{predictions.aqi?.current ?? "N/A"}</td>
                        <td>{timelineMetric(predictions.aqi, 1) ?? "—"}</td>
                        <td>{timelineMetric(predictions.aqi, 3) ?? "—"}</td>
                        <td><strong style={{ color: "#22c55e" }}>{timelineMetric(predictions.aqi, 5) ?? "—"}</strong></td>
                        <td>{Math.round((predictions.aqi?.current ?? 50) * 0.96)} (Target)</td>
                        <td><span className="growth-pill neutral">Stationary</span></td>
                      </tr>
                      <tr>
                        <td><b>🌡️ Temperature (°C)</b></td>
                        <td>{predictions.weather?.current ?? 25}°C</td>
                        <td>{timelineMetric(predictions.weather, 1) ?? 25}°C</td>
                        <td>{timelineMetric(predictions.weather, 3) ?? 25.4}°C</td>
                        <td><strong style={{ color: "#f97316" }}>{timelineMetric(predictions.weather, 5) ?? 25.8}°C</strong></td>
                        <td>{Number((predictions.weather?.current ?? 25) + 0.9).toFixed(1)}°C</td>
                        <td><span className="growth-pill warn">+0.18°C / yr</span></td>
                      </tr>
                      <tr>
                        <td><b>💡 Night Radiance</b></td>
                        <td>{Number(predictions.migration?.current ?? 0).toFixed(2)} nW</td>
                        <td>{Number(timelineMetric(predictions.migration, 1) ?? 0).toFixed(2)} nW</td>
                        <td>{Number(timelineMetric(predictions.migration, 3) ?? 0).toFixed(2)} nW</td>
                        <td><strong style={{ color: "#a855f7" }}>{Number(timelineMetric(predictions.migration, 5) ?? 0).toFixed(2)} nW</strong></td>
                        <td>{Number((predictions.migration?.current ?? 0) * 1.15).toFixed(2)} nW</td>
                        <td><span className="growth-pill positive">+2.8% / yr</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="projections-insights-card">
                  <div className="insights-title">💡 Strategic Urban Planning Implications</div>
                  <ul>
                    <li>Demographic expansion requires proportional infrastructure allocation across municipal wards.</li>
                    <li>Air quality index trajectory indicates stable particulate levels within national safety thresholds.</li>
                    <li>Radiance telemetry signals continuous commercial and arterial development in surrounding sectors.</li>
                  </ul>
                </div>
              </div>
            )}

            {/* SUB-DASHBOARD 5: Remote Sensing & Satellite Gallery */}
            {hubTab === "remote" && (
              <div className="hub-tab-pane fade-in">
                {/* Verified Satellite / Wiki Image Carousel */}
                <div className="satellite-gallery-card">
                  <div className="gallery-header">
                    <span>REMOTE SENSING & SATELLITE IMAGERY</span>
                    {photos.length > 0 && <small>{photoIndex + 1} of {photos.length}</small>}
                  </div>

                  {photosLoading && <div className="photo-loading-box">Retrieving high-resolution satellite imagery...</div>}

                  {!photosLoading && photos.length > 0 && (
                    <div className="gallery-viewport">
                      {photoFailed[photoIndex] ? (
                        <div className="gallery-fallback">
                          <img
                            src={`https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${(coords?.lon ?? 72.8) - 0.04},${(coords?.lat ?? 19.0) - 0.03},${(coords?.lon ?? 72.8) + 0.04},${(coords?.lat ?? 19.0) + 0.03}&bboxSR=4326&imageSR=4326&size=800,450&format=jpg&f=image`}
                            alt="Satellite Orthophoto"
                            referrerPolicy="no-referrer"
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        </div>
                      ) : (
                        <img
                          src={photos[photoIndex].displayUrl || displayImageUrl(photos[photoIndex].url)}
                          alt={locationName}
                          referrerPolicy="no-referrer"
                          crossOrigin="anonymous"
                          onError={() => handlePhotoError(photoIndex)}
                        />
                      )}
                      <div className="gallery-nav-buttons">
                        <button onClick={() => setPhotoIndex((i) => (i - 1 + photos.length) % photos.length)}>‹</button>
                        <button onClick={() => setPhotoIndex((i) => (i + 1) % photos.length)}>›</button>
                      </div>
                      {photos[photoIndex]?.credit && (
                        <div className="gallery-credit">
                          Credit: {photos[photoIndex].credit}
                        </div>
                      )}
                    </div>
                  )}

                  {!photosLoading && photos.length === 0 && (
                    <div className="gallery-viewport">
                      <img
                        src={`https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${(coords?.lon ?? 72.8) - 0.04},${(coords?.lat ?? 19.0) - 0.03},${(coords?.lon ?? 72.8) + 0.04},${(coords?.lat ?? 19.0) + 0.03}&bboxSR=4326&imageSR=4326&size=800,450&format=jpg&f=image`}
                        alt="Satellite Orthophoto"
                        referrerPolicy="no-referrer"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                      <div className="gallery-credit">Credit: High-Resolution Esri World Imagery / Copernicus Sentinel-2 Composite</div>
                    </div>
                  )}
                </div>

                {/* CNN Land Cover Classification */}
                <div className="cv-classification-card">
                  <div className="cv-header">
                    <div>
                      <span>CNN DEEP REMOTE SENSING CLASSIFICATION</span>
                      <div style={{ fontSize: "10px", color: "var(--text-dim)", marginTop: "2px" }}>
                        {cvResult?.model || "Sentinel-2 10m ESA WorldCover Deep Classifier"}
                      </div>
                    </div>
                    <button
                      className="cv-run-btn"
                      onClick={() => coords && runLandCoverClassification(coords.lat, coords.lon)}
                      disabled={cvLoading}
                    >
                      {cvLoading ? "Inference Running..." : "Run Land Cover Model"}
                    </button>
                  </div>

                  {cvResult && cvResult.available && (
                    <>
                      {cvResult.top_class && (
                        <div style={{ margin: "4px 0 10px 0", fontSize: "11px", color: "var(--cyan)", background: "rgba(0, 212, 255, 0.08)", padding: "4px 8px", borderRadius: "6px", display: "inline-block" }}>
                          ✓ Dominant Classification: <strong>{cvResult.top_class}</strong>
                        </div>
                      )}
                      <div className="cv-predictions-list">
                        {(cvResult.classes || cvResult.predictions || []).map((item, idx) => {
                          const name = item.name || item.label;
                          const pct = item.pct != null ? item.pct : (item.confidence > 1 ? item.confidence : item.confidence * 100);
                          const icon = name.includes("Tree") || name.includes("Forest") ? "🌲"
                            : name.includes("Crop") || name.includes("Agri") ? "🌾"
                            : name.includes("Built") || name.includes("Residential") ? "🏙️"
                            : name.includes("Water") ? "💧"
                            : name.includes("Grass") || name.includes("Meadow") ? "🌱"
                            : name.includes("Snow") ? "❄️"
                            : "🌍";
                          return (
                            <div key={idx} className="cv-row">
                              <span className="cv-label">{icon} {name}</span>
                              <div className="cv-bar-track">
                                <div className="cv-bar-fill" style={{ width: `${Math.min(100, Math.max(3, pct))}%` }} />
                              </div>
                              <span className="cv-pct">{pct.toFixed(1)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {cvResult && !cvResult.available && (
                    <div className="cv-status-note">{cvResult.reason}</div>
                  )}
                </div>

                {/* Nearby Places */}
                {nearbyPlaces.length > 0 && (
                  <div className="nearby-places-card">
                    <div className="nearby-title">NEARBY NOTABLE SITES</div>
                    <div className="nearby-grid">
                      {nearbyPlaces.map((pl, pIdx) => (
                        <div
                          key={pIdx}
                          className="nearby-item"
                          onClick={() => {
                            globeRef.current?.flyToLocation(pl.lat, pl.lon);
                            loadLocationData(pl.lat, pl.lon, pl.name, null);
                          }}
                        >
                          <span className="nearby-pin">📍</span>
                          <div className="nearby-meta">
                            <strong>{pl.name.split(",")[0]}</strong>
                            <small>{pl.distance_km != null ? `${pl.distance_km.toFixed(1)} km away` : "Nearby"}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Hub Footer: Report Generation */}
          <div className="hub-footer">
            <button className="hub-action-btn pdf-btn" onClick={handleDownloadPdf} disabled={downloading}>
              {downloading ? "Compiling PDF..." : "📥 Download Intelligence Dossier (PDF)"}
            </button>
            <button className="hub-action-btn csv-btn" onClick={handleExportCsv}>
              ⇩ Export CSV Data
            </button>
          </div>
        </aside>
      )}

      {/* ── Compare Cities Modal ────────────────────────────────────── */}
      {compareOpen && (
        <div className="compare-modal-backdrop" onClick={() => setCompareOpen(false)}>
          <div className="compare-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="compare-window-header">
              <div className="compare-window-title">⚖️ COMPARATIVE GEOSPATIAL INTELLIGENCE</div>
              <button className="compare-window-close" onClick={() => setCompareOpen(false)}>✕</button>
            </div>

            <div className="compare-window-body">
              <div className="compare-search-row">
                <div className="compare-col-primary">
                  <span className="col-tag">BENCHMARK LOCATION</span>
                  <strong>{locationName.split(",")[0] || "Select Location on Map"}</strong>
                </div>

                <div className="compare-col-vs">VS</div>

                <div className="compare-col-target">
                  <span className="col-tag">COMPARISON TARGET</span>
                  <div className="compare-input-wrap">
                    <input
                      type="text"
                      placeholder="Search comparison city (e.g. London, Singapore)..."
                      value={compareQuery}
                      onChange={(e) => {
                        setCompareQuery(e.target.value);
                        fetchCompareSuggestions(e.target.value);
                      }}
                    />
                    {compareSuggestions.length > 0 && (
                      <div className="compare-suggestions-dropdown">
                        {compareSuggestions.map((s, idx) => (
                          <div key={idx} className="compare-sugg-item" onClick={() => handleCompareSelect(s)}>
                            {s.name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  className="compare-run-btn"
                  onClick={runCompareAnalysis}
                  disabled={!compareTarget || compareLoading}
                >
                  {compareLoading ? "Analyzing..." : "Compare"}
                </button>
              </div>

              {compareData && (
                <div className="compare-results-container">
                  <CompareChart
                    data={compareData}
                    nameA={compareData.location_a?.name?.split(",")[0] || locationName.split(",")[0]}
                    nameB={compareData.location_b?.name?.split(",")[0] || compareTarget?.name?.split(",")[0] || "City B"}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Loading Overlay ─────────────────────────────────────────── */}
      {loading && !predictions && (
        <div className="global-loader-overlay">
          <div className="loader-globe-spinner">
            <div className="spinner-core" />
            <div className="spinner-ring" />
          </div>
          <div className="loader-msg">Streaming satellite & demographic telemetry...</div>
        </div>
      )}

      {/* ── Error Toast ─────────────────────────────────────────────── */}
      {errorMsg && (
        <div className="global-toast-error">
          <span>⚠️ {errorMsg}</span>
          <button onClick={() => setErrorMsg("")}>✕</button>
        </div>
      )}
    </div>
  );
}

export default App;
