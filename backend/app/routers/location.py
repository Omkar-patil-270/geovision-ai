# backend/app/routers/location.py
import math
import httpx
from fastapi import APIRouter
from . import cache_utils

router = APIRouter()

NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
PHOTON_SEARCH_URL = "https://photon.komoot.io/api"
PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse"
HEADERS = {
    "User-Agent": "GeoVisionAI-Platform/2.0 (https://geovisionai.org; contact@geovisionai.org)",
    "Accept": "application/json",
}

SEARCH_CACHE_TTL = 60 * 60 * 6       # 6h — place names don't move
BOUNDARY_CACHE_TTL = 60 * 60 * 24     # 24h — boundary polygons are static
NEARBY_CACHE_TTL = 60 * 60 * 6

import os
import pandas as pd

_CITIES_CSV = os.path.join(os.path.dirname(__file__), "..", "..", "data", "worldcities.csv")
_local_cities = None

def _get_nearest_city_fallback(lat: float, lon: float):
    global _local_cities
    if _local_cities is None:
        try:
            _local_cities = pd.read_csv(_CITIES_CSV)
        except Exception:
            _local_cities = pd.DataFrame()
    if _local_cities.empty:
        return None
    try:
        df = _local_cities.copy()
        box = df[(df["lat"].between(lat - 2.5, lat + 2.5)) & (df["lng"].between(lon - 2.5, lon + 2.5))].copy()
        if box.empty:
            box = df.copy()
        box["dist_sq"] = (box["lat"] - lat)**2 + (box["lng"] - lon)**2
        top = box.sort_values("dist_sq").iloc[0]
        city = top.get("city", "Selected Location")
        admin = top.get("admin_name", "")
        country = top.get("country", "")
        code = str(top.get("iso2", "")).upper()
        clean = f"{city}, {admin}, {country}" if admin and admin != city else f"{city}, {country}"
        return {
            "name": clean,
            "lat": float(top["lat"]),
            "lon": float(top["lng"]),
            "boundary_query": f"{city}, {country}",
            "level": 5,
            "level_label": "District",
            "country_code": code,
            "display_name": clean,
            "population_supported": True,
            "resolved_from": city,
        }
def _search_worldcities_local(q: str, limit: int = 5):
    global _local_cities
    if _local_cities is None:
        try:
            _local_cities = pd.read_csv(_CITIES_CSV)
        except Exception:
            _local_cities = pd.DataFrame()
    if _local_cities.empty:
        return []
    try:
        df = _local_cities
        q_lower = q.lower().strip()
        matches = df[df["city"].astype(str).str.lower().str.contains(q_lower, na=False) |
                     df["city_ascii"].astype(str).str.lower().str.contains(q_lower, na=False)].copy()
        if matches.empty:
            return []
        matches = matches.sort_values("population", ascending=False).head(limit)
        results = []
        for _, row in matches.iterrows():
            city = row.get("city", "")
            admin = row.get("admin_name", "")
            country = row.get("country", "")
            code = str(row.get("iso2", "")).upper()
            name = f"{city}, {admin}, {country}" if admin and admin != city else f"{city}, {country}"
            results.append({
                "name": name,
                "lat": float(row["lat"]),
                "lon": float(row["lng"]),
                "level": 5,
                "level_label": "District",
                "boundary_query": f"{city}, {country}",
                "country_code": code,
                "population_supported": True,
                "resolved_from": city,
            })
        return results
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Administrative level model
# ---------------------------------------------------------------------------
# GeoVisionAI intentionally supports population/navigation ONLY at these
# levels: Continent -> Country -> State/Province -> District -> Taluka/Tehsil.
# Individual villages/cities/towns are never treated as the final answer —
# a search for a settlement is always resolved "up" to the smallest
# supported administrative region that contains it (e.g. "Gadhinglaj" the
# town resolves to "Gadhinglaj Taluka").
#
# OSM/Nominatim tags administrative boundaries with an `admin_level` (via
# extratags). In India (GeoVisionAI's primary use case) this typically maps:
#   2 -> Country        4 -> State/Province   5/6 -> District
#   7   -> Taluka/Tehsil/Mandal      8+  -> village/town/city panchayat (NOT supported)
# Other countries vary, so we treat this as a best-effort classification
# and always show the user the detected level rather than silently guessing.
ADMIN_LEVEL_LABELS = {
    2: "Country",
    3: "Country",
    4: "State/Province",
    5: "District",
    6: "District",
    7: "Taluka/Tehsil",
}

SETTLEMENT_TYPES = {"city", "town", "village", "hamlet", "suburb", "municipality", "isolated_dwelling"}

TYPE_PRIORITY = {
    "country": 100, "state": 90, "region": 85, "province": 85,
    "city": 80, "town": 70, "village": 60, "hamlet": 50, "administrative": 75,
}

# A handful of continents don't exist as Nominatim boundaries at all — we
# support them only as coarse navigation targets (fly-to), never for
# population, and say so explicitly.
CONTINENTS = {
    "africa": {"lat": 2.0, "lon": 20.0},
    "antarctica": {"lat": -82.0, "lon": 0.0},
    "asia": {"lat": 34.0, "lon": 100.0},
    "europe": {"lat": 54.0, "lon": 15.0},
    "north america": {"lat": 45.0, "lon": -100.0},
    "south america": {"lat": -15.0, "lon": -60.0},
    "oceania": {"lat": -25.0, "lon": 140.0},
    "australia": {"lat": -25.0, "lon": 133.0},
}


def _haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _detect_level(item):
    """
    Returns (admin_level:int|None, level_label:str, is_settlement:bool).
    """
    class_ = item.get("class", "")
    type_ = item.get("type", "")
    extratags = item.get("extratags") or {}

    if class_ == "boundary" and type_ == "administrative":
        raw_level = extratags.get("admin_level")
        try:
            level = int(raw_level) if raw_level is not None else None
        except (TypeError, ValueError):
            level = None
        if level is not None:
            if level >= 8:
                return level, "Local area", True
            label = ADMIN_LEVEL_LABELS.get(level)
            if label:
                return level, label, False
        # boundary/administrative but no usable admin_level tag — infer coarsely
        return None, "Region", False

    if type_ in SETTLEMENT_TYPES or class_ == "place":
        return None, "Settlement", True

    return None, "Region", False


def format_clean_label(item):
    """
    Builds a clean 'Name, District, State' label from Nominatim's structured
    address fields — instead of the raw verbose display_name string.
    """
    addr = item.get("address", {})
    name = (
        addr.get("village") or addr.get("town") or addr.get("city")
        or addr.get("county") or addr.get("state_district")
        or addr.get("state") or item.get("display_name", "").split(",")[0]
    )
    district = addr.get("state_district") or addr.get("county")
    state = addr.get("state")
    country = addr.get("country")

    parts = [name]
    if district and district != name:
        parts.append(district)
    if state and state != district and state != name:
        parts.append(state)
    if country:
        parts.append(country)
    return ", ".join(parts)


def score_result(item):
    place_type = item.get("type", "")
    class_ = item.get("class", "")
    base = TYPE_PRIORITY.get(place_type, 40)
    if class_ == "boundary":
        base += 10
    importance = float(item.get("importance", 0))
    return base + importance


def _region_resolution(addr: dict):
    """
    Given a Nominatim `address` dict for a settlement (village/town/city),
    picks the smallest SUPPORTED administrative region that contains it:
    Taluka/Tehsil > District > State > Country.

    Heuristic mapping used across most of Nominatim's India data:
      addr.county          -> Taluka/Tehsil/Mandal (finer subdivision)
      addr.state_district  -> District
      addr.state           -> State/Province
      addr.country          -> Country
    For countries where `county` isn't populated, this naturally falls
    back to District, then State, then Country — never the raw settlement.
    """
    taluka = addr.get("county")
    district = addr.get("state_district")
    state = addr.get("state")
    country = addr.get("country")
    country_code = (addr.get("country_code") or "").upper()

    if taluka:
        return "Taluka/Tehsil", taluka, ", ".join(p for p in [taluka, district, state, country] if p), country_code
    if district:
        return "District", district, ", ".join(p for p in [district, state, country] if p), country_code
    if state:
        return "State/Province", state, ", ".join(p for p in [state, country] if p), country_code
    if country:
        return "Country", country, country, country_code
    return None, None, None, country_code


def _photon_to_nominatim(feature):
    props = feature.get("properties", {})
    coords = feature.get("geometry", {}).get("coordinates", [0, 0])
    name = props.get("name", "")
    city = props.get("city") or props.get("town") or props.get("village") or name
    state = props.get("state")
    country = props.get("country")
    parts = [name]
    if city and city != name: parts.append(city)
    if state and state != name: parts.append(state)
    if country: parts.append(country)
    return {
        "lat": str(coords[1]),
        "lon": str(coords[0]),
        "display_name": ", ".join(parts),
        "class": "place",
        "type": props.get("type", "city"),
        "importance": 0.85,
        "address": {
            "city": city,
            "state": state,
            "country": country,
            "country_code": (props.get("countrycode") or "").lower(),
            "county": props.get("district") or props.get("county"),
            "state_district": props.get("district"),
        }
    }


async def _nominatim_search(client: httpx.AsyncClient, q: str, limit: int = 5, extra: dict = None):
    params = {
        "q": q, "format": "json", "addressdetails": 1, "extratags": 1,
        "limit": limit, "accept-language": "en",
    }
    if extra:
        params.update(extra)
    try:
        res = await client.get(NOMINATIM_SEARCH_URL, params=params, headers=HEADERS, timeout=5)
        if res.status_code == 200:
            data = res.json()
            if data:
                return data
    except Exception:
        pass

    # Reliable OpenStreetMap Photon Geocoding fallback
    try:
        p_res = await client.get(PHOTON_SEARCH_URL, params={"q": q, "limit": limit}, headers=HEADERS, timeout=5)
        if p_res.status_code == 200:
            features = p_res.json().get("features", [])
            if features:
                return [_photon_to_nominatim(f) for f in features]
    except Exception:
        pass
    return []


async def _resolve_settlement(client: httpx.AsyncClient, item: dict):
    """
    A settlement match (village/town/city) is re-resolved to the whole
    supported administrative region that contains it, by re-querying
    Nominatim for that region's own boundary — so the map fits and the
    population figure represent the FULL district/taluka, not the point.
    """
    addr = item.get("address", {})
    level_label, region_name, region_query, country_code = _region_resolution(addr)
    if not region_name:
        return None

    candidates = await _nominatim_search(
        client, region_query, limit=3,
        extra={"polygon_geojson": 0},
    )
    # Prefer an actual administrative boundary match among the candidates.
    boundary_candidates = [c for c in candidates if c.get("class") == "boundary" and c.get("type") == "administrative"]
    top = boundary_candidates[0] if boundary_candidates else (candidates[0] if candidates else None)
    if not top:
        return None

    detected_level, detected_label, _ = _detect_level(top)
    return {
        "name": format_clean_label(top) or region_query,
        "lat": float(top["lat"]),
        "lon": float(top["lon"]),
        "boundary_query": region_query,
        "level": detected_level,
        "level_label": detected_label if detected_label != "Settlement" else level_label,
        "country_code": country_code,
        "resolved_from": item.get("display_name", "").split(",")[0],
    }


@router.get("/search")
async def search_location(q: str):
    key = cache_utils.make_key("search", q.strip().lower())

    async def _do_search():
        try:
            q_clean = q.strip()

            # Continents: coarse navigation only, no population.
            if q_clean.lower() in CONTINENTS:
                c = CONTINENTS[q_clean.lower()]
                return [{
                    "name": q_clean.title(),
                    "lat": c["lat"], "lon": c["lon"],
                    "level": 1, "level_label": "Continent",
                    "boundary_query": None, "country_code": None,
                    "population_supported": False,
                    "resolved_from": None,
                }]

            async with httpx.AsyncClient() as client:
                results = await _nominatim_search(client, q_clean, limit=10)
                if not results:
                    return _search_worldcities_local(q_clean, limit=8)

                results.sort(key=score_result, reverse=True)

                seen_coords = set()
                output = []
                for r in results:
                    coord_key = (round(float(r["lat"]), 2), round(float(r["lon"]), 2))
                    if coord_key in seen_coords:
                        continue
                    seen_coords.add(coord_key)

                    level, level_label, is_settlement = _detect_level(r)
                    addr = r.get("address", {})
                    country_code = (addr.get("country_code") or "").upper()

                    if is_settlement:
                        resolved = await _resolve_settlement(client, r)
                        if resolved:
                            output.append({**resolved, "population_supported": True})
                            continue
                        output.append({
                            "name": format_clean_label(r),
                            "lat": float(r["lat"]), "lon": float(r["lon"]),
                            "level": None, "level_label": "Settlement (unresolved)",
                            "boundary_query": None, "country_code": country_code,
                            "population_supported": False,
                            "resolved_from": None,
                        })
                        continue

                    output.append({
                        "name": format_clean_label(r),
                        "lat": float(r["lat"]), "lon": float(r["lon"]),
                        "level": level, "level_label": level_label,
                        "boundary_query": r.get("display_name") or format_clean_label(r),
                        "country_code": country_code,
                        "population_supported": level_label in ADMIN_LEVEL_LABELS.values(),
                        "resolved_from": None,
                    })

                return output[:8] if output else _search_worldcities_local(q_clean, limit=8)
        except Exception as e:
            print("search_location error:", repr(e))
            return _search_worldcities_local(q_clean, limit=8)

    return await cache_utils.get_or_set(key, SEARCH_CACHE_TTL, _do_search)


@router.get("/boundary")
async def get_boundary(q: str, lat: float = None, lon: float = None):
    """
    Returns the real administrative boundary polygon for the FULL region
    (district/taluka/state/country) — not a single settlement point.
    Point-only places (no polygon in OSM) still return lat/lon so the
    frontend can show a marker instead of nothing.

    When the caller passes the already-known lat/lon (from /search's
    resolved result), we fetch several candidates and pick the one
    geographically closest to that point, since a text-only match for
    `q` can occasionally resolve to a same-named place elsewhere.
    """
    key = cache_utils.make_key("boundary", q, lat, lon)

    async def _do_boundary():
        if q is None:
            return {"geojson": None, "lat": lat, "lon": lon}
        limit = 5 if (lat is not None and lon is not None) else 1
        params = {"q": q, "format": "json", "polygon_geojson": 1, "limit": limit, "accept-language": "en"}
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get(NOMINATIM_SEARCH_URL, params=params, headers=HEADERS, timeout=10)
                if res.status_code != 200:
                    return {"geojson": None, "lat": lat, "lon": lon}
                results = res.json()
        except Exception:
            return {"geojson": None, "lat": lat, "lon": lon}

        if not results:
            return {"geojson": None, "lat": lat, "lon": lon}

        if lat is not None and lon is not None:
            top = min(results, key=lambda r: _haversine_km(lat, lon, float(r["lat"]), float(r["lon"])))
        else:
            top = results[0]

        return {
            "geojson": top.get("geojson"),
            "lat": float(top["lat"]) if top.get("lat") else lat,
            "lon": float(top["lon"]) if top.get("lon") else lon,
        }

    return await cache_utils.get_or_set(key, BOUNDARY_CACHE_TTL, _do_boundary)


@router.get("/nearby")
async def get_nearby_places(lat: float, lon: float, limit: int = 8):
    """
    Real nearby cities/towns/landmarks via Wikipedia geosearch, each with
    a real thumbnail when Wikipedia has one for that article. This is
    purely a navigation aid ("places near here") — it doesn't drive
    population numbers, which stay at the district/taluka level.
    """
    key = cache_utils.make_key("nearby", round(lat, 3), round(lon, 3), limit)

    async def _do_nearby():
        params = {
            "action": "query",
            "generator": "geosearch",
            "ggscoord": f"{lat}|{lon}",
            "ggsradius": 25000,
            "ggslimit": limit + 2,
            "prop": "pageimages|coordinates",
            "piprop": "thumbnail",
            "pithumbsize": 300,
            "format": "json",
        }
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                res = await client.get("https://en.wikipedia.org/w/api.php", params=params, headers=HEADERS)
                if res.status_code != 200:
                    return {"places": []}
                pages = res.json().get("query", {}).get("pages", {})
        except Exception:
            return {"places": []}

        places = []
        for p in pages.values():
            coords = p.get("coordinates", [{}])[0]
            if not coords.get("lat") or not coords.get("lon"):
                continue
            dist = _haversine_km(lat, lon, coords["lat"], coords["lon"])
            if dist < 0.3:
                continue
            places.append({
                "name": p.get("title"),
                "lat": coords["lat"],
                "lon": coords["lon"],
                "thumbnail": p.get("thumbnail", {}).get("source"),
                "distance_km": round(dist, 1),
            })

        places.sort(key=lambda x: x["distance_km"])
        return {"places": places[:limit]}

    return await cache_utils.get_or_set(key, NEARBY_CACHE_TTL, _do_nearby)


@router.get("/reverse")
async def reverse_geocode(lat: float, lon: float):
    """
    Reverse geocode (lat, lon) to a clean administrative entity.
    Resolves settlements up to their enclosing district or taluka so that
    WorldPop demographics, boundaries, weather, and AI story models work seamlessly.
    """
    key = cache_utils.make_key("reverse", round(lat, 4), round(lon, 4))

    async def _do_reverse():
        params = {
            "lat": lat,
            "lon": lon,
            "format": "json",
            "addressdetails": 1,
            "extratags": 1,
            "zoom": 14,
            "accept-language": "en",
        }
        data = None
        try:
            async with httpx.AsyncClient(timeout=4) as client:
                res = await client.get(NOMINATIM_REVERSE_URL, params=params, headers=HEADERS)
                if res.status_code == 200:
                    data = res.json()
                else:
                    p_res = await client.get(PHOTON_REVERSE_URL, params={"lat": lat, "lon": lon}, headers=HEADERS, timeout=4)
                    if p_res.status_code == 200:
                        feats = p_res.json().get("features", [])
                        if feats:
                            data = _photon_to_nominatim(feats[0])
        except Exception as e:
            data = None

        if not data or not isinstance(data, dict) or "address" not in data:
            fallback = _get_nearest_city_fallback(lat, lon)
            if fallback:
                return fallback
            return None

        addr = data.get("address", {})
        clean_name = format_clean_label(data)
        detected_level, detected_label, is_settlement = _detect_level(data)
        level_label, region_name, region_query, country_code = _region_resolution(addr)

        final_label = detected_label if (detected_label and detected_label != "Settlement") else (level_label or "District")
        final_query = region_query or clean_name or f"{lat:.4f},{lon:.4f}"

        return {
            "name": clean_name or region_query or f"Location ({lat:.3f}°, {lon:.3f}°)",
            "lat": float(data.get("lat", lat)),
            "lon": float(data.get("lon", lon)),
            "boundary_query": final_query,
            "level": detected_level,
            "level_label": final_label,
            "country_code": country_code or (addr.get("country_code") or "").upper(),
            "display_name": data.get("display_name"),
            "population_supported": True,
            "resolved_from": data.get("display_name", "").split(",")[0],
        }

    res = await cache_utils.get_or_set(key, SEARCH_CACHE_TTL, _do_reverse)
    if not res:
        fallback = _get_nearest_city_fallback(lat, lon)
        if fallback:
            return fallback
        return {
            "name": f"Coordinates ({lat:.3f}°, {lon:.3f}°)",
            "lat": lat,
            "lon": lon,
            "boundary_query": f"{lat},{lon}",
            "level": None,
            "level_label": "Local area",
            "country_code": None,
            "population_supported": True,
            "resolved_from": None,
        }
    return res

