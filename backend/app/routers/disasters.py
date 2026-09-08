# backend/app/routers/disasters.py
import os
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq


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


@router.get("/earthquakes")
async def get_earthquakes(lat: float, lon: float):
    """Real earthquakes within 300km, last 5 years, from USGS (free, no key)."""
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(
            "https://earthquake.usgs.gov/fdsnws/event/1/query",
            params={
                "format": "geojson",
                "latitude": lat, "longitude": lon,
                "maxradiuskm": 300,
                "starttime": "2020-01-01",
                "minmagnitude": 3.0,
                "limit": 50,
            },
        )
        if res.status_code != 200:
            return {"count": 0, "max_magnitude": None, "recent": [], "risk_level": "unknown"}
        data = res.json()

    features = data.get("features", [])
    if not features:
        return {"count": 0, "max_magnitude": None, "recent": [], "risk_level": "low"}

    mags = [f["properties"]["mag"] for f in features if f["properties"].get("mag")]
    max_mag = max(mags) if mags else None
    risk = "high" if (max_mag or 0) >= 6 else "moderate" if (max_mag or 0) >= 4.5 else "low"

    recent = [
        {"magnitude": f["properties"]["mag"], "place": f["properties"]["place"], "time": f["properties"]["time"]}
        for f in features[:5]
    ]

    return {"count": len(features), "max_magnitude": max_mag, "recent": recent, "risk_level": risk}

@router.get("/flood")
async def get_flood(lat: float, lon: float):
    """Real river discharge risk from Open-Meteo Flood API (GloFAS), free, no key."""
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(
            "https://flood-api.open-meteo.com/v1/flood",
            params={"latitude": lat, "longitude": lon, "daily": "river_discharge", "forecast_days": 7},
        )
        if res.status_code != 200:
            return {"risk_level": "unavailable", "discharge": None}
        data = res.json()

    discharge = data.get("daily", {}).get("river_discharge", [])
    if not discharge or discharge[0] is None:
        return {"risk_level": "unavailable", "discharge": None}

    current = discharge[0]
    risk = "high" if current > 1000 else "moderate" if current > 300 else "low"
    return {"risk_level": risk, "discharge": current, "unit": "m³/s", "forecast_7day": discharge}


class ExplainRequest(BaseModel):
    location_name: str
    disaster_type: str  # "earthquake" | "flood" | "cyclone" | "wildfire"
    data: dict


@router.post("/explain")
async def explain_disaster(req: ExplainRequest):
    """AI explains causes, risk level, and safety tips for a real disaster reading — grounded only in the data passed in."""
    prompt = (
        f"Location: {req.location_name}. Disaster type: {req.disaster_type}. "
        f"Real data: {req.data}. "
        f"Write three short sections using ONLY this real data: "
        f"1) Causes (1-2 sentences on why this risk exists here), "
        f"2) Risk level (1 sentence, plain language, no invented numbers), "
        f"3) Safety tips (2-3 concrete, practical tips for residents). "
        f"Do not invent facts not supported by the data. No headings with markdown symbols, just three short paragraphs."
    )
    res = _groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
    )
    return {"explanation": res.choices[0].message.content}