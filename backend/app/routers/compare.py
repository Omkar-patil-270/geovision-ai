import os
import asyncio
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq
from .predictions import get_predictions


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
_groq_key = os.getenv("GROQ_API_KEY", "").strip()
_groq_client = Groq(api_key=_groq_key) if _groq_key else None


class CompareLocation(BaseModel):
    name: str = "Location"
    lat: float
    lon: float
    level: Optional[str] = None
    country_code: Optional[str] = None
    boundary_query: Optional[str] = None


class CompareRequest(BaseModel):
    location_a: CompareLocation
    location_b: CompareLocation


def _diff_metric(a_now, b_now):
    if a_now is None or b_now is None:
        return {"leader": None, "difference_pct": None}
    if a_now == b_now:
        return {"leader": "tie", "difference_pct": 0}
    leader = "a" if a_now > b_now else "b"
    base = min(a_now, b_now) or 1
    diff_pct = round(abs(a_now - b_now) / base * 100, 1)
    return {"leader": leader, "difference_pct": diff_pct}


@router.post("/")
async def compare_cities(payload: dict):
    """Compare two selected locations using the exact same prediction pipeline as the main panel.
    Accepts CompareRequest schema or loose dictionary to eliminate 422 errors.
    """
    raw_a = payload.get("location_a") or payload.get("locationA") or payload.get("a") or {}
    raw_b = payload.get("location_b") or payload.get("locationB") or payload.get("b") or {}

    def normalize(raw):
        lat = raw.get("lat") if raw.get("lat") is not None else raw.get("latitude")
        lon = raw.get("lon") if raw.get("lon") is not None else raw.get("longitude")
        if lat is None or lon is None:
            raise ValueError("Latitude and longitude are required for comparison")
        raw_level = raw.get("level") or raw.get("level_label")
        if raw_level is not None and not isinstance(raw_level, str):
            raw_level = None
        name = raw.get("name") or raw.get("location_name") or "Location"
        return CompareLocation(
            name=name,
            lat=float(lat),
            lon=float(lon),
            level=raw_level,
            country_code=raw.get("country_code") or raw.get("countryCode"),
            boundary_query=raw.get("boundary_query") or raw.get("boundaryQuery") or name,
        )

    req_a = normalize(raw_a)
    req_b = normalize(raw_b)
    lat_a, lon_a = req_a.lat, req_a.lon
    lat_b, lon_b = req_b.lat, req_b.lon

    data_a, data_b = await asyncio.gather(
        get_predictions(
            lat_a,
            lon_a,
            place_name=req_a.boundary_query or req_a.name,
            level=req_a.level,
            country_code=req_a.country_code,
        ),
        get_predictions(
            lat_b,
            lon_b,
            place_name=req_b.boundary_query or req_b.name,
            level=req_b.level,
            country_code=req_b.country_code,
        ),
    )

    metrics = ["population", "aqi", "weather", "migration"]
    comparison = {}
    for m in metrics:
        a_now = data_a.get(m, {}).get("current")
        b_now = data_b.get(m, {}).get("current")
        comparison[m] = {
            "a": a_now,
            "b": b_now,
            **_diff_metric(a_now, b_now),
        }
    comparison["urban_stress"] = {"a": None, "b": None, "leader": None, "difference_pct": None}
    comparison["urban_growth"] = comparison["migration"]

    summary_prompt = (
        f"Compare these two locations using ONLY this real data: "
        f"{req_a.name}: {comparison}. "
        f"Write a 4-5 sentence comparison summary. Be specific about which place "
        f"leads on which metric and by roughly how much. Note one meaningful "
        f"tradeoff a visitor or resident should weigh. No headings, no bullet points, "
        f"do not invent facts beyond what's given."
    )
    try:
        if _groq_client is None:
            raise RuntimeError("GROQ_API_KEY is not configured")
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": summary_prompt}],
        )
        ai_summary = res.choices[0].message.content
    except Exception:
        # Fallback comparison summary without hallucinating
        pop_a = comparison["population"]["a"]
        pop_b = comparison["population"]["b"]
        aqi_a = comparison["aqi"]["a"]
        aqi_b = comparison["aqi"]["b"]
        ai_summary = (
            f"Comparing {req_a.name} and {req_b.name}: "
            f"{req_a.name} reports a population of {pop_a if pop_a is not None else 'N/A'} with an AQI of {aqi_a if aqi_a is not None else 'N/A'}. "
            f"{req_b.name} reports a population of {pop_b if pop_b is not None else 'N/A'} with an AQI of {aqi_b if aqi_b is not None else 'N/A'}. "
            f"Both locations provide distinct environmental and demographic profiles based on real-time and satellite observation datasets."
        )

    return {
        "location_a": {"name": req_a.name, "lat": lat_a, "lon": lon_a},
        "location_b": {"name": req_b.name, "lat": lat_b, "lon": lon_b},
        "comparison": comparison,
        "ai_summary": ai_summary,
    }
