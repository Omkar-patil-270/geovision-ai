import asyncio
from fastapi import APIRouter
from .predictions import _EE_READY
from .ml_utils import arima_forecast

try:
    import ee
except Exception:
    ee = None

router = APIRouter()

YEARS = [2000, 2010, 2020, 2030]


def _year_ndvi(lat, lon, year):
    if not _EE_READY or ee is None or year > 2020:
        return None
    try:
        start = max(year, 2000)
        end = min(year + 1, 2021)
        collection = (
            ee.ImageCollection("MODIS/006/MOD13Q1")
            .filterDate(f"{start}-01-01", f"{end}-12-31")
            .select("NDVI")
        )
        value = collection.mean().reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=ee.Geometry.Point([lon, lat]).buffer(2000),
            scale=250,
            maxPixels=1e9,
        ).get("NDVI").getInfo()
        if value is None:
            return None
        ndvi = value / 10000
        return round(max(0, min((ndvi + 1) / 2, 1)) * 100, 1)
    except Exception:
        return None


def _year_night_light(lat, lon, year):
    if not _EE_READY or ee is None:
        return None
    if year >= 2012:
        collection_id = "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
    else:
        collection_id = "NOAA/DMSP-OLS/NIGHTTIME_LIGHTS"
    try:
        if year >= 2012:
            collection = (
                ee.ImageCollection(collection_id)
                .filterDate(f"{year}-01-01", f"{year}-12-31")
                .select("avg_rad")
            )
            band = "avg_rad"
        else:
            collection = ee.ImageCollection(collection_id).filter(ee.Filter.eq("system:index", f"F{year % 100:02d}18"))
            band = "stable_lights"
        image = collection.mean() if year >= 2012 else collection.first()
        value = image.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=ee.Geometry.Point([lon, lat]).buffer(2000),
            scale=1000,
            maxPixels=1e9,
        ).get(band).getInfo()
        return round(float(value), 2) if value is not None else None
    except Exception:
        return None


@router.get("/{lat}/{lon}")
async def time_machine(lat: float, lon: float):
    """Time-series snapshot for 2000, 2010, 2020 (real) and 2030 (predicted)."""

    async def get_metrics(year):
        ndvi = await asyncio.to_thread(_year_ndvi, lat, lon, year)
        nl = await asyncio.to_thread(_year_night_light, lat, lon, year)
        return {"year": year, "green_cover": ndvi, "infrastructure_proxy": nl}

    snapshots = await asyncio.gather(*[get_metrics(y) for y in [2000, 2010, 2020]])

    nl_series = [s["infrastructure_proxy"] for s in snapshots if s["infrastructure_proxy"] is not None]
    green_series = [s["green_cover"] for s in snapshots if s["green_cover"] is not None]

    predicted_2030 = {"year": 2030, "green_cover": None, "infrastructure_proxy": None, "population_proxy": None}
    if len(nl_series) >= 2:
        result = arima_forecast(nl_series, forecast_steps=1)
        predicted_2030["infrastructure_proxy"] = round(result["forecast"][0], 2)
        predicted_2030["infrastructure_rmse"] = result.get("rmse")
    if len(green_series) >= 2:
        result = arima_forecast(green_series, forecast_steps=1)
        predicted_2030["green_cover"] = round(result["forecast"][0], 1)

    return {
        "location": {"lat": lat, "lon": lon},
        "timeline": snapshots + [predicted_2030],
        "labels": {
            "green_cover": "Vegetation / green cover (0-100)",
            "infrastructure_proxy": "Night-light infrastructure proxy",
            "population_proxy": "Derived from urban growth trends",
        },
        "note": "2000–2020 use satellite archives; 2030 is an ML projection from observed trends.",
    }
