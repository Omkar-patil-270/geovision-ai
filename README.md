# GeoVisionAI — Location Intelligence

GeoVisionAI is a Cesium-based geospatial intelligence dashboard. Search a place such as **Kolhapur**, confirm its coordinates and country, then explore real data, visual storytelling, and forecast layers from the selected location.

## Confirmed prediction layers

| Layer | Current signal | Forecast | Method / source |
|---|---|---|---|
| AQI | Nearest OpenAQ station or Open-Meteo coordinate model | Current modeled value when no station is nearby | OpenAQ observation first; Open-Meteo Air Quality fallback for villages |
| Population | Local administrative estimate | Chronological ARIMA one-year-ahead forecasts with expanding-window validation | WorldPop local administrative boundary estimate; nearest-city CSV fallback only when Earth Engine is unavailable |
| Weather | Current/recent temperature context | Real next seven days plus longer historical trend | Open-Meteo forecast API + archive history |
| Migration Signal | Night-light radiance proxy | Five-year settlement-growth trend | DMSP/VIIRS night lights + ARIMA |

All response points are labeled as historical, estimated, or predicted. A missing upstream dataset is returned as unavailable instead of fabricated.

## Storytelling and visuals

Each selected location loads a progressive six-part story: Overview, History, Culture, Economy, Attractions, and Facts. The image carousel uses the backend Wikimedia/Wikipedia resolver with exact-location and administrative-level fallbacks, and each location receives its own visual gallery. The final intelligence surface combines a satellite-first Cesium 3D Earth, smooth camera flights, Earth home/zoom/north/orbit/fullscreen controls, Windy-inspired signal controls, floating story chapters, a seven-day weather strip, Compare, and downloadable PDF/CSV reports. The primary product surface intentionally keeps only Population, AQI, Weather, Migration, and Compare.

## Run locally

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in GROQ_API_KEY, OPENAQ_API_KEY, and optional Earth Engine credentials.
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_API_URL=http://localhost:8000` when the frontend and backend are hosted on different origins. Do not commit real API keys or service-account JSON; use `backend/.env.example` and deployment environment variables. Population metrics are never hardcoded: unavailable source years remain unavailable.

## API example

```bash
curl "http://localhost:8000/api/location/search?q=Kolhapur"
curl "http://localhost:8000/api/predictions/16.7050/74.2433?place_name=Kolhapur&level=District&country_code=IN"
```

The prediction response contains `aqi`, `population`, `weather`, and `migration`. The `weather.next_7_days` array contains real daily forecast values when Open-Meteo is available. A village without an OpenAQ monitor receives a real coordinate-based modeled AQI and the source is labeled. The PDF report downloads as `GEOVISION-AI-FINAL-2026.pdf`.
