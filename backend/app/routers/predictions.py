import os
import math
import asyncio
import httpx
import pandas as pd
from fastapi import APIRouter
from .ml_utils import arima_forecast, sarima_forecast, expanding_window_validation, rolling_population_validation
from . import cache_utils


def load_env():
    try:
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()
    except FileNotFoundError:
        pass


load_env()

router = APIRouter()

OPENAQ_KEY = os.getenv("OPENAQ_API_KEY", "")
OPENAQ_BASE = "https://api.openaq.org/v3"
WORLDBANK_BASE = "https://api.worldbank.org/v2"

AQI_CACHE_TTL = 60 * 30           # 30 min — air quality changes fast
WEATHER_CACHE_TTL = 60 * 60 * 24  # 1 day — 15yr history barely moves day to day
MIGRATION_CACHE_TTL = 60 * 60 * 24
POPULATION_CACHE_TTL = 60 * 60 * 24 * 7  # 1 week — population data is slow-moving

CITIES_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "worldcities.csv")
_cities_df = pd.read_csv(CITIES_PATH)

_EE_READY = False
try:
    import ee
    import json

    ee_sa_key = os.getenv("EE_SERVICE_ACCOUNT_KEY", "").strip()
    ee_sa_email = os.getenv("EE_SERVICE_ACCOUNT_EMAIL", "").strip()
    ee_project = os.getenv("EE_PROJECT", "").strip()

    if ee_sa_key and ee_sa_email:
        # Validate the JSON, then pass the original JSON string to Earth Engine.
        # Earth Engine's key_data parameter expects a string, not a dict.
        json.loads(ee_sa_key)
        credentials = ee.ServiceAccountCredentials(
            email=ee_sa_email,
            key_data=ee_sa_key,
        )
        ee.Initialize(credentials=credentials, project=ee_project)
    elif ee_project:
        # Local dev fallback: use credentials from `earthengine authenticate`.
        ee.Initialize(project=ee_project)
    else:
        raise RuntimeError("EE_PROJECT is missing from backend/.env")

    _EE_READY = True
    print("Earth Engine initialized successfully")
except Exception as e:
    print("Earth Engine failed to initialize at startup:", e)
    _EE_READY = False


def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# AQI (unchanged logic, now cached)
# ---------------------------------------------------------------------------
async def get_aqi_open_meteo(lat, lon):
    """Coordinate-based modeled AQI fallback for villages without a station."""
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            res = await client.get(
                "https://air-quality-api.open-meteo.com/v1/air-quality",
                params={
                    "latitude": lat, "longitude": lon,
                    "hourly": "us_aqi,pm2_5,pm10",
                    "past_days": 5, "forecast_days": 1, "timezone": "auto",
                },
            )
            if res.status_code != 200:
                return None
            hourly = res.json().get("hourly", {})
            times = hourly.get("time", [])
            aqi_values = hourly.get("us_aqi", [])
            records = [{"date": t, "value": v} for t, v in zip(times, aqi_values) if v is not None]
            if not records:
                return None
            df = pd.DataFrame(records)
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
            df = df.dropna(subset=["date"])
            daily = df.groupby(df["date"].dt.date)["value"].mean().reset_index()
            points = [{"period": str(row["date"]), "value": round(float(row["value"]), 1)} for _, row in daily.iterrows()]
            return {
                "current": round(float(records[-1]["value"]), 1),
                "monthly": points,
                "station": "Open-Meteo modeled AQI at coordinates",
            }
    except Exception:
        return None


async def get_aqi_global(lat, lon):
    """Real AQI: live current reading + real recent monthly time series for ARIMA."""
    key = cache_utils.make_key("aqi", round(lat, 3), round(lon, 3))

    async def _fetch():
        headers = {"X-API-Key": OPENAQ_KEY}
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                loc_res = await client.get(
                    f"{OPENAQ_BASE}/locations",
                    params={"coordinates": f"{lat},{lon}", "radius": 25000, "limit": 1},
                    headers=headers,
                )
                if loc_res.status_code != 200 or not loc_res.json().get("results"):
                    return None
                location = loc_res.json()["results"][0]
                location_id = location["id"]

                latest_res = await client.get(f"{OPENAQ_BASE}/locations/{location_id}/latest", headers=headers)
                if latest_res.status_code != 200 or not latest_res.json().get("results"):
                    return None
                latest = latest_res.json()["results"][0]
                current_value = latest["value"]
                sensor_id = latest.get("sensorsId") or latest.get("sensorId")

                monthly_points = []
                if sensor_id:
                    meas_res = await client.get(
                        f"{OPENAQ_BASE}/sensors/{sensor_id}/measurements",
                        params={"limit": 1000},
                        headers=headers,
                    )
                    if meas_res.status_code == 200:
                        rows = meas_res.json().get("results", [])
                        records = []
                        for r in rows:
                            dt = r.get("period", {}).get("datetimeFrom", {}).get("utc")
                            val = r.get("value")
                            if dt and val is not None:
                                records.append({"date": dt, "value": val})
                        if records:
                            df = pd.DataFrame(records)
                            df["date"] = pd.to_datetime(df["date"], errors="coerce")
                            df = df.dropna(subset=["date"])
                            df["month"] = df["date"].dt.to_period("M")
                            monthly = df.groupby("month")["value"].mean().reset_index()
                            monthly_points = [
                                {"period": str(m), "value": round(float(v), 1)}
                                for m, v in zip(monthly["month"], monthly["value"])
                            ]
        except Exception:
            return None

        return {"current": round(current_value, 1), "monthly": monthly_points, "station": location.get("name")}

    result = await cache_utils.get_or_set(key, AQI_CACHE_TTL, _fetch)
    if not result:
        result = await get_aqi_open_meteo(lat, lon)
    if not result:
        return None, [], None
    return result["current"], result["monthly"], result["station"]


# ---------------------------------------------------------------------------
# Boundary lookup shared by population + migration/AQI radius fallback
# ---------------------------------------------------------------------------
async def _get_place_boundary_geojson(lat, lon, query: str = None):
    """
    Fetches the real administrative boundary polygon for the region.
    If `query` is supplied, Nominatim search is tried first.
    Falls back to reverse-geocoding at zoom=8 (district/county level).
    """
    headers = {"User-Agent": "GeoVisionAI/1.0"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if query:
                try:
                    params = {"q": query, "format": "json", "polygon_geojson": 1, "limit": 3, "accept-language": "en"}
                    res = await client.get("https://nominatim.openstreetmap.org/search", params=params, headers=headers)
                    if res.status_code == 200 and res.json():
                        candidates = [c for c in res.json() if c.get("geojson")]
                        if candidates:
                            top = min(candidates, key=lambda r: haversine(lat, lon, float(r["lat"]), float(r["lon"])))
                            if top.get("geojson"):
                                return top["geojson"]
                except Exception:
                    pass

            # Nominatim reverse geocode at zoom=8 returns district / county boundary
            try:
                params = {"lat": lat, "lon": lon, "format": "json", "polygon_geojson": 1, "zoom": 8, "accept-language": "en"}
                res = await client.get("https://nominatim.openstreetmap.org/reverse", params=params, headers=headers)
                if res.status_code == 200:
                    data = res.json()
                    return data.get("geojson")
            except Exception:
                pass
    except Exception:
        return None
    return None


async def _get_worldpop_year_boundary(geojson, year):
    """
    Sums real WorldPop population within the ACTUAL administrative
    boundary polygon (district/taluka/state) — not a guessed circle.
    """
    def _sync_call():
        try:
            geom = ee.Geometry(geojson)
            image = (
                ee.ImageCollection("WorldPop/GP/100m/pop")
                .filterDate(f"{year}-01-01", f"{year}-12-31")
                .mosaic()
            )
            value = image.reduceRegion(
                reducer=ee.Reducer.sum(), geometry=geom, scale=100, maxPixels=1e10
            ).get("population").getInfo()
            return {"year": year, "value": round(float(value), 1)} if value else None
        except Exception:
            return None
    return await asyncio.to_thread(_sync_call)


async def _get_worldpop_year(lat, lon, year, radius_m=15000):
    """Fallback: real gridded population sum in a 15km radius."""
    def _sync_call():
        try:
            point = ee.Geometry.Point([lon, lat]).buffer(radius_m)
            image = (
                ee.ImageCollection("WorldPop/GP/100m/pop")
                .filterDate(f"{year}-01-01", f"{year}-12-31")
                .mosaic()
            )
            value = image.reduceRegion(
                reducer=ee.Reducer.sum(), geometry=point, scale=100, maxPixels=1e9
            ).get("population").getInfo()
            return {"year": year, "value": round(float(value), 1)} if value else None
        except Exception:
            return None
    return await asyncio.to_thread(_sync_call)


async def get_population_worldpop_series(lat, lon, boundary_query: str = None, use_boundary: bool = True):
    """
    Real multi-year population history (2015-2020) from WorldPop, summed
    within the REAL administrative boundary polygon for the selected
    District/Taluka/State (or a 15km-radius circle only when no boundary
    polygon can be found at all).
    """
    if not _EE_READY:
        return None

    years = [2015, 2016, 2017, 2018, 2019, 2020]
    geojson = await _get_place_boundary_geojson(lat, lon, query=boundary_query) if use_boundary else None

    if geojson:
        results = await asyncio.gather(*[_get_worldpop_year_boundary(geojson, y) for y in years])
        series = [r for r in results if r is not None]
        if len(series) >= 2:
            series.sort(key=lambda r: r["year"])
            return series

    results = await asyncio.gather(*[_get_worldpop_year(lat, lon, y) for y in years])
    series = [r for r in results if r is not None]
    series.sort(key=lambda r: r["year"])
    return series if len(series) >= 2 else None


def get_population_nearest_city(lat, lon):
    """
    Honest fallback used when WorldPop's real multi-year series isn't
    available (e.g. Earth Engine not configured or unavailable).
    Falls back to worldcities.csv nearest city, clearly labeled as Reference dataset (fallback).
    """
    df = _cities_df.copy()
    df["distance"] = df.apply(lambda row: haversine(lat, lon, row["lat"], row["lng"]), axis=1)
    nearby = df[df["distance"] <= 50].sort_values("population", ascending=False)
    nearest = nearby.iloc[0] if not nearby.empty else df.sort_values("distance").iloc[0]

    current_pop = int(nearest["population"]) if not pd.isna(nearest["population"]) else None
    source_label = "Reference dataset (fallback)"
    if not current_pop:
        return None, [], [], source_label, {"method": "unavailable", "rmse": None, "mae": None, "order": None}

    historical = [{"year": 2025, "value": current_pop, "type": "estimated"}]
    model_info = {
        "method": "reference_dataset_fallback",
        "nearest_city": nearest.get("city"),
        "rmse": None, "mae": None, "order": None,
    }
    return current_pop, historical, [], source_label, model_info


# ---------------------------------------------------------------------------
# World Bank — real country-level population, used ONLY at country level.
# Sub-country regions (state/district/taluka) never borrow this number —
# they use the WorldPop boundary sum below instead, so we never pretend a
# country total is a district's population.
# ---------------------------------------------------------------------------
async def get_population_worldbank(country_code: str):
    """
    Real historical population (SP.POP.TOTL indicator) for a country from
    the World Bank Open Data API, ARIMA-forecast 5 years forward the same
    way every other real time series in this app is forecast.
    """
    if not country_code:
        return None

    key = cache_utils.make_key("worldbank_pop", country_code.upper())

    async def _fetch():
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.get(
                    f"{WORLDBANK_BASE}/country/{country_code}/indicator/SP.POP.TOTL",
                    params={"format": "json", "per_page": 100, "date": "1960:2024"},
                )
                if res.status_code != 200:
                    return None
                payload = res.json()
                if not isinstance(payload, list) or len(payload) < 2 or not payload[1]:
                    return None
                rows = payload[1]
        except Exception:
            return None

        points = [
            {"year": int(r["date"]), "value": float(r["value"])}
            for r in rows if r.get("value") is not None
        ]
        if len(points) < 4:
            return None
        points.sort(key=lambda p: p["year"])
        return points

    return await cache_utils.get_or_set(key, POPULATION_CACHE_TTL, _fetch)


async def get_population_predictions(lat, lon, level: str = None, country_code: str = None, boundary_query: str = None):
    """
    Population source is chosen by the SELECTED administrative level:
      Country                -> World Bank (SP.POP.TOTL), real reported
                                 national statistics, ARIMA-forecast forward.
      State/District/Taluka  -> WorldPop 100m gridded population within
                                 the real boundary polygon (district boundary).
      Fallback               -> worldcities.csv nearest city, clearly labeled
                                 as 'Reference dataset (fallback)'.
    """
    # 1. Country level only: use World Bank SP.POP.TOTL
    if level == "Country" and country_code:
        wb_series = await get_population_worldbank(country_code)
        if wb_series:
            values = [p["value"] for p in wb_series]
            years = [p["year"] for p in wb_series]
            current_pop = int(values[-1])
            ml_result = arima_forecast(values, forecast_steps=5)
            validation = expanding_window_validation(values, years, min_train=5)
            last_year = wb_series[-1]["year"]
            forecast = [
                {"year": last_year + i + 1, "value": int(v), "type": "predicted"}
                for i, v in enumerate(ml_result["forecast"])
            ]
            historical = [{"year": p["year"], "value": int(p["value"]), "type": "historical"} for p in wb_series]
            if validation:
                ml_result["validation"] = validation
            return (
                current_pop, historical, forecast,
                "World Bank (National statistics)",
                ml_result,
            )

    # 2. Sub-national level: District / Taluka / State / etc.
    # MUST use WorldPop gridded sum within administrative boundary polygon (Nominatim zoom=8)
    series = None
    if _EE_READY:
        series = await get_population_worldpop_series(lat, lon, boundary_query=boundary_query)

    # Safety check against accidentally receiving country-sized data for a local query
    if series and level != "Country":
        local_caps = {"District": 30_000_000, "Taluka/Tehsil": 10_000_000, "Settlement": 5_000_000}
        cap = local_caps.get(level)
        if cap and series[-1]["value"] > cap:
            radius_series = await get_population_worldpop_series(lat, lon, boundary_query=None, use_boundary=False)
            if radius_series and radius_series[-1]["value"] <= cap:
                series = radius_series
            else:
                series = None

    if series and len(series) >= 4:
        values = [p["value"] for p in series]
        years = [p["year"] for p in series]
        current_pop = int(values[-1])

        ml_result = arima_forecast(values, forecast_steps=5)
        validation = expanding_window_validation(values, years, min_train=3)
        if validation:
            ml_result["validation"] = validation

        last_year = series[-1]["year"]
        forecast = [
            {"year": last_year + i + 1, "value": int(v), "type": "predicted"}
            for i, v in enumerate(ml_result["forecast"])
        ]
        historical = [{"year": p["year"], "value": int(p["value"]), "type": "estimated"} for p in series]
        source_label = "WorldPop (District boundary)"
        return current_pop, historical, forecast, source_label, ml_result

    # 3. If Earth Engine is unavailable or WorldPop has insufficient points:
    # Fall back to worldcities.csv nearest city (NOT World Bank country data)
    return get_population_nearest_city(lat, lon)


# ---------------------------------------------------------------------------
# Weather (unchanged logic, now cached)
# ---------------------------------------------------------------------------
async def get_weather_7day(lat, lon):
    """Real next-seven-day daily forecast from Open-Meteo."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lon,
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
                "forecast_days": 7, "timezone": "auto",
            })
            if res.status_code != 200: return []
            daily = res.json().get("daily", {})
            return [{"date": d, "max_c": hi, "min_c": lo, "precip_probability": rain, "weather_code": code}
                    for d, hi, lo, rain, code in zip(daily.get("time", []), daily.get("temperature_2m_max", []),
                                                       daily.get("temperature_2m_min", []), daily.get("precipitation_probability_max", []),
                                                       daily.get("weather_code", []))]
    except Exception:
        return []

async def get_weather_global(lat, lon):
    """Real monthly series over 15 years so SARIMA has enough real history."""
    key = cache_utils.make_key("weather", round(lat, 3), round(lon, 3))

    async def _fetch():
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.get(
                    "https://archive-api.open-meteo.com/v1/archive",
                    params={
                        "latitude": lat, "longitude": lon,
                        "start_date": "2010-01-01", "end_date": "2024-12-31",
                        "daily": "temperature_2m_mean", "timezone": "auto",
                    },
                )
                if res.status_code != 200:
                    return None
                data = res.json()
                dates = data.get("daily", {}).get("time", [])
                temps = data.get("daily", {}).get("temperature_2m_mean", [])
        except Exception:
            return None

        if not dates or not temps:
            return None

        return {"dates": dates, "temps": temps}

    raw = await cache_utils.get_or_set(key, WEATHER_CACHE_TTL, _fetch)
    if not raw:
        return None, [], [], None

    df = pd.DataFrame({"date": pd.to_datetime(raw["dates"]), "temp": raw["temps"]}).dropna()

    df["year"] = df["date"].dt.year
    yearly = df.groupby("year")["temp"].mean().round(1)
    yearly_series = [{"year": int(y), "value": float(v)} for y, v in yearly.items()]
    current_avg = yearly_series[-1]["value"] if yearly_series else None

    df["month"] = df["date"].dt.to_period("M")
    monthly = df.groupby("month")["temp"].mean().round(2)
    monthly_values = monthly.tolist()

    result = sarima_forecast(monthly_values, forecast_steps=24, seasonal_period=12)

    last_year = yearly_series[-1]["year"] if yearly_series else 2025
    fc = result["forecast"]
    forecast = []
    for i in range(0, len(fc), 12):
        chunk = fc[i : i + 12]
        if chunk:
            forecast.append({"year": last_year + 1 + i // 12, "value": round(sum(chunk) / len(chunk), 1)})

    return current_avg, yearly_series, forecast, result


async def _get_night_light_year(lat, lon, year):
    def _sync_call():
        try:
            point = ee.Geometry.Point([lon, lat])
            collection = (
                ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG")
                .filterDate(f"{year}-01-01", f"{year}-12-31")
                .select("avg_rad")
            )
            mean_image = collection.mean()
            value = mean_image.reduceRegion(reducer=ee.Reducer.mean(), geometry=point, scale=1000).get("avg_rad").getInfo()
            return {"year": year, "value": round(value, 2)} if value is not None else None
        except Exception:
            return None
    return await asyncio.to_thread(_sync_call)


async def get_migration_proxy(lat, lon):
    """Real 5-point yearly series (2014,2016,2018,2020,2022), now cached."""
    key = cache_utils.make_key("migration", round(lat, 3), round(lon, 3))

    async def _fetch():
        if not _EE_READY:
            return None
        years = [2014, 2016, 2018, 2020, 2022]
        results = await asyncio.gather(*[_get_night_light_year(lat, lon, y) for y in years])
        years_data = [r for r in results if r is not None]
        years_data.sort(key=lambda r: r["year"])
        return years_data if len(years_data) >= 2 else None

    years_data = await cache_utils.get_or_set(key, MIGRATION_CACHE_TTL, _fetch)
    if not years_data:
        return None, [], [], None

    current = years_data[-1]["value"]
    result = arima_forecast([p["value"] for p in years_data], forecast_steps=5)
    last_year = years_data[-1]["year"]
    forecast = [{"year": last_year + i + 1, "value": v} for i, v in enumerate(result["forecast"])]

    return current, years_data, forecast, result


@router.get("/{lat}/{lon}")
async def get_predictions(lat: float, lon: float, place_name: str = None, level: str = None, country_code: str = None):
    """
    level: one of "Country" / "State/Province" / "District" / "Taluka/Tehsil"
    (as returned by /api/location/search's `level_label`). Determines which
    real dataset backs the population figure — see get_population_predictions.
    country_code: ISO alpha-2, required to use World Bank at country level.
    place_name/boundary_query (place_name reused here) anchors the WorldPop
    boundary sum to the FULL selected region rather than a reverse-geocode
    guess from the point.
    """
    try:
        aqi_result, weather_result, migration_result, population_result, seven_day = await asyncio.wait_for(
            asyncio.gather(
                get_aqi_global(lat, lon),
                get_weather_global(lat, lon),
                get_migration_proxy(lat, lon),
                get_population_predictions(lat, lon, level=level, country_code=country_code, boundary_query=place_name),
                get_weather_7day(lat, lon),
            ),
            # First Earth Engine/WorldPop lookups may be slow and uncached.
            timeout=90,
        )
    except asyncio.TimeoutError:
        aqi_result = (None, [], None)
        weather_result = (None, [], [], None)
        migration_result = (None, [], [], None)
        population_result = get_population_nearest_city(lat, lon)
        seven_day = []

    aqi_now, aqi_hist, aqi_station = aqi_result
    temp_now, temp_hist, temp_fc, weather_ml = weather_result
    migration_now, migration_hist, migration_fc, migration_ml = migration_result
    pop_now, pop_hist, pop_fc, pop_source, pop_ml = population_result

    # Final display guard. If a client omits `level` but searches a clearly
    # local administrative place, never let a country-scale result through.
    place_label = (place_name or "").lower()
    inferred_local = level != "Country" and any(token in place_label for token in ("district", "taluka", "tehsil", "village", "town", "city"))
    cap = {"District": 30_000_000, "Taluka/Tehsil": 10_000_000, "Settlement": 5_000_000}.get(level)
    if cap is None and inferred_local:
        cap = 30_000_000 if "district" in place_label else 10_000_000
    if level != "Country" and cap and pop_now is not None and pop_now > cap:
        pop_now, pop_hist, pop_fc, pop_source, pop_ml = get_population_nearest_city(lat, lon)

    if aqi_station == "Open-Meteo modeled AQI at coordinates":
        aqi_ml = {"method": "real_coordinate_model", "source": "Open-Meteo Air Quality API", "rmse": None, "mae": None, "order": None}
        aqi_fc = []
    elif aqi_hist and len(aqi_hist) >= 4:
        aqi_ml = arima_forecast([p["value"] for p in aqi_hist], forecast_steps=5)
        last_period = str(aqi_hist[-1].get("period", ""))
        last_year = int(last_period[:4]) if last_period[:4].isdigit() else 2025
        aqi_fc = [{"year": last_year + i + 1, "value": v} for i, v in enumerate(aqi_ml["forecast"])]
    else:
        aqi_ml = {"method": "insufficient_data", "rmse": None, "mae": None, "order": None}
        aqi_fc = []

    return {
        "location": {"lat": lat, "lon": lon},
        "level": level,
        "nearest_city": pop_source if level not in ("Country",) else None,
        "aqi_station": aqi_station,
        "population": {
            "current": pop_now, "historical": pop_hist, "forecast_5yr": pop_fc,
            "unit": "people", "model": pop_ml, "source": pop_source, "level": level,
        },
        "aqi": {
            "current": aqi_now, "historical": aqi_hist, "forecast_5yr": aqi_fc,
            "unit": "AQI index", "model": aqi_ml,
        },
        "weather": {
            "current": temp_now, "historical": temp_hist, "forecast_5yr": temp_fc,
            "next_7_days": seven_day, "unit": "°C avg", "model": weather_ml,
        },
        "migration": {
            "current": migration_now, "historical": migration_hist, "forecast_5yr": migration_fc,
            "unit": "night-light radiance", "model": migration_ml,
        },
    }
