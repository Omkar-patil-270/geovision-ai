import os
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq
from .predictions import get_predictions
from .disasters import get_earthquakes, get_flood
from .sustainability import get_sustainability


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


class AgentRequest(BaseModel):
    location_name: str
    lat: float
    lon: float


async def get_monthly_climate_normals(lat, lon):
    """Real 5-year monthly average temperatures, used to suggest the mildest travel months."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://archive-api.open-meteo.com/v1/archive",
                params={
                    "latitude": lat, "longitude": lon,
                    "start_date": "2020-01-01", "end_date": "2024-12-31",
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

    import pandas as pd
    df = pd.DataFrame({"date": pd.to_datetime(dates), "temp": temps}).dropna()
    df["month"] = df["date"].dt.month
    monthly = df.groupby("month")["temp"].mean().round(1)
    return {int(m): float(v) for m, v in monthly.items()}


def pick_best_months(monthly_normals, ideal=22.0, top_n=3):
    if not monthly_normals:
        return []
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    ranked = sorted(monthly_normals.items(), key=lambda kv: abs(kv[1] - ideal))
    return [month_names[m - 1] for m, _ in ranked[:top_n]]


@router.post("/analyze")
async def agentic_analyze(req: AgentRequest):
    """
    One request triggers a chain of real actions: predictions, disaster risk,
    sustainability scoring, climate-based travel window, and a final AI-written
    report tying it all together — the 'analyze a city' agentic flow.
    """
    actions_performed = []

    predictions = await get_predictions(req.lat, req.lon)
    actions_performed.append("Collected population/AQI/weather/migration data + 5yr forecasts")

    try:
        earthquakes = await get_earthquakes(req.lat, req.lon)
    except Exception:
        earthquakes = {"count": 0, "risk_level": "unknown"}
    try:
        flood = await get_flood(req.lat, req.lon)
    except Exception:
        flood = {"risk_level": "unavailable"}
    actions_performed.append("Checked earthquake and flood risk")

    sustainability = await get_sustainability(req.lat, req.lon, location_name=req.location_name)
    actions_performed.append("Calculated sustainability scores (green index, pollution, water)")

    monthly_normals = await get_monthly_climate_normals(req.lat, req.lon)
    best_months = pick_best_months(monthly_normals)
    actions_performed.append("Derived best travel months from 5-year climate data")

    report_prompt = (
        f"You are an AI geospatial analyst. Location: {req.location_name}. "
        f"Real data collected — predictions: {predictions}. "
        f"Earthquake risk: {earthquakes}. Flood risk: {flood}. "
        f"Sustainability: {sustainability}. Best travel months (by climate): {best_months}. "
        f"Write a structured briefing with these exact section labels, each 2-3 sentences, "
        f"using ONLY the real data given, no invented facts:\n"
        f"SUMMARY:\nENVIRONMENTAL CHALLENGES:\nTRAVEL RECOMMENDATION:\nOUTLOOK (NEXT 5 YEARS):"
    )
    try:
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": report_prompt}],
        )
        report = res.choices[0].message.content
    except Exception:
        report = None
    actions_performed.append("Generated final AI briefing report")

    return {
        "location_name": req.location_name,
        "actions_performed": actions_performed,
        "predictions": predictions,
        "disaster_risk": {"earthquakes": earthquakes, "flood": flood},
        "sustainability": sustainability,
        "best_travel_months": best_months,
        "report": report,
    }