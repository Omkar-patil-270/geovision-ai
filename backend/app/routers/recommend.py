import os
from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq
from .agentic import get_monthly_climate_normals, pick_best_months


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


class RecommendRequest(BaseModel):
    location_name: str
    lat: float
    lon: float


@router.post("/")
async def recommend(req: RecommendRequest):
    """
    AI-generated travel recommendations. Unlike the prediction/disaster endpoints,
    most of this content (similar destinations, hidden places, food, budget) draws
    on the model's general knowledge rather than a live dataset — clearly labeled
    as AI suggestions, not verified real-time facts.
    """
    monthly_normals = await get_monthly_climate_normals(req.lat, req.lon)
    best_months = pick_best_months(monthly_normals)

    prompt = (
        f"Location: {req.location_name} (lat {req.lat}, lon {req.lon}). "
        f"Best-climate months (from real 5-year temperature data): {best_months}. "
        f"Give recommendations in exactly this format, no extra commentary:\n"
        f"SIMILAR_DESTINATIONS: <2-3 comma-separated place names, briefly why each is similar>\n"
        f"HIDDEN_PLACES: <2 lesser-known nearby spots, one line each>\n"
        f"LOCAL_FOOD: <3 dishes or food specialties typical of this region>\n"
        f"NEARBY_ATTRACTIONS: <3 well-known attractions near this location>\n"
        f"BUDGET_ESTIMATE: <one of Budget/Mid-range/Luxury with a rough daily cost range and currency>\n"
        f"BEST_SEASON: <state the best months and briefly why, referencing the climate data given>"
    )
    try:
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
        )
        text = res.choices[0].message.content
    except Exception:
        text = None

    parsed = {}
    if text:
        for line in text.splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip().lower()
                if key in {"similar_destinations", "hidden_places", "local_food", "nearby_attractions", "budget_estimate", "best_season"}:
                    parsed[key] = value.strip()

    return {
        "location_name": req.location_name,
        "best_travel_months": best_months,
        "recommendations": parsed if parsed else {"raw": text},
        "note": "Destinations, food, and attractions are AI-generated suggestions based on general knowledge, not a verified live dataset.",
    }