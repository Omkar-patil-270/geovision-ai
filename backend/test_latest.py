import os
import httpx

with open(".env", "r") as f:
    for line in f:
        line = line.strip()
        if line and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k] = v

key = os.getenv("OPENAQ_API_KEY", "")
print("KEY:", key[:6], "...")

headers = {"X-API-Key": key}

loc_res = httpx.get(
    "https://api.openaq.org/v3/locations",
    params={"coordinates": "48.8566,2.3522", "radius": 50000, "limit": 1},
    headers=headers,
)
print("LOCATIONS RAW:", loc_res.json())