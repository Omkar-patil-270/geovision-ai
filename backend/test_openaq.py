import os
import httpx
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("OPENAQ_API_KEY", "")
print("Key loaded:", key[:6] + "..." if key else "EMPTY")

headers = {"X-API-Key": key}
params = {"coordinates": "48.8566,2.3522", "radius": 25000, "limit": 1}

res = httpx.get("https://api.openaq.org/v3/locations", params=params, headers=headers)
print("Status:", res.status_code)
print("Response:", res.text[:500])