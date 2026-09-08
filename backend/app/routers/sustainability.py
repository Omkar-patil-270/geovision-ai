import os
import httpx
from fastapi import APIRouter
from groq import Groq
from .predictions import get_predictions, _EE_READY

try:
    import ee
except Exception:
    ee = None


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
_groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))


def get_ndvi(lat, lon):
    """Real vegetation index from MODIS via Earth Engine. Returns None honestly if EE isn't available."""
    if not _EE_READY or ee is None:
        return None
    try:
        point = ee.Geometry.Point([lon, lat]).buffer(2000)
        collection = ee.ImageCollection("MODIS/006/MOD13Q1").filterDate("2023-01-01", "2023-12-31").select("NDVI")
        image = collection.mean()
        value = image.reduceRegion(reducer=ee.Reducer.mean(), geometry=point, scale=250).get("NDVI").getInfo()
        return round(value / 10000, 3) if value is not None else None  # MODIS NDVI is scaled x10000
    except Exception:
        return None


async def get_annual_precipitation(lat, lon):
    """Real total rainfall for the last full year, from Open-Meteo (free, no key)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://archive-api.open-meteo.com/v1/archive",
                params={
                    "latitude": lat, "longitude": lon,
                    "start_date": "2023-01-01", "end_date": "2023-12-31",
                    "daily": "precipitation_sum", "timezone": "auto",
                },
            )
            if res.status_code != 200:
                return None
            data = res.json()
            values = data.get("daily", {}).get("precipitation_sum", [])
            values = [v for v in values if v is not None]
            return round(sum(values), 1) if values else None
    except Exception:
        return None


def score_pollution(aqi_now):
    """0-100, higher is better (less pollution)."""
    if aqi_now is None:
        return None
    return round(100 - min(aqi_now / 300, 1) * 100, 1)


def score_green_index(ndvi):
    """0-100, higher is more vegetated. NDVI typically ranges -1 (bare/water) to 1 (dense forest)."""
    if ndvi is None:
        return None
    return round(max(0, min((ndvi + 1) / 2, 1)) * 100, 1)


def score_water_availability(annual_precip_mm):
    """0-100, scaled against 1500mm/yr as a comfortable regional benchmark."""
    if annual_precip_mm is None:
        return None
    return round(min(annual_precip_mm / 1500, 1) * 100, 1)


@router.get("/{lat}/{lon}")
async def get_sustainability(lat: float, lon: float, location_name: str = "this location"):
    predictions = await get_predictions(lat, lon)
    aqi_now = predictions.get("aqi", {}).get("current")

    ndvi = get_ndvi(lat, lon)
    annual_precip = await get_annual_precipitation(lat, lon)

    pollution_score = score_pollution(aqi_now)
    green_score = score_green_index(ndvi)
    water_score = score_water_availability(annual_precip)

    real_scores = {
        "green_index": {"score": green_score, "basis": "MODIS NDVI (satellite vegetation index)" if green_score is not None else "unavailable"},
        "pollution": {"score": pollution_score, "basis": "Live AQI reading" if pollution_score is not None else "unavailable"},
        "water_availability": {"score": water_score, "basis": f"{annual_precip}mm annual rainfall (2023)" if water_score is not None else "unavailable"},
    }

    # Waste management and renewable energy have no reliable free global
    # per-coordinate dataset, so we're honest that these are AI qualitative
    # estimates (not measured), clearly labeled as such — not invented numbers.
    qualitative_prompt = (
        f"For {location_name} (lat {lat}, lon {lon}), give a brief qualitative estimate "
        f"(one of: Low, Medium, High) for 'waste management infrastructure' and 'renewable "
        f"energy adoption', based on general regional/national context you know. "
        f"Respond in exactly this format with no extra text:\n"
        f"waste_management: <Low/Medium/High> | <one sentence reasoning>\n"
        f"renewable_energy: <Low/Medium/High> | <one sentence reasoning>"
    )
    waste_label, waste_reason, renewable_label, renewable_reason = None, None, None, None
    try:
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": qualitative_prompt}],
        )
        text = res.choices[0].message.content
        for line in text.splitlines():
            if line.lower().startswith("waste_management"):
                _, rest = line.split(":", 1)
                parts = rest.split("|")
                waste_label = parts[0].strip()
                waste_reason = parts[1].strip() if len(parts) > 1 else None
            if line.lower().startswith("renewable_energy"):
                _, rest = line.split(":", 1)
                parts = rest.split("|")
                renewable_label = parts[0].strip()
                renewable_reason = parts[1].strip() if len(parts) > 1 else None
    except Exception:
        pass

    recommendation_prompt = (
        f"Location: {location_name}. Real sustainability data: {real_scores}. "
        f"AI-estimated waste management: {waste_label}. AI-estimated renewable energy adoption: {renewable_label}. "
        f"Write 3 short, practical, specific sustainability recommendations for this location, "
        f"grounded in the data given. No headings, just 3 short sentences."
    )
    recommendations = None
    try:
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": recommendation_prompt}],
        )
        recommendations = res.choices[0].message.content
    except Exception:
        pass

    return {
        "location": {"name": location_name, "lat": lat, "lon": lon},
        "green_index": real_scores["green_index"],
        "pollution": real_scores["pollution"],
        "water_availability": real_scores["water_availability"],
        "waste_management": {"estimate": waste_label, "reasoning": waste_reason, "basis": "AI qualitative estimate, not measured"},
        "renewable_energy": {"estimate": renewable_label, "reasoning": renewable_reason, "basis": "AI qualitative estimate, not measured"},
        "recommendations": recommendations,
    }