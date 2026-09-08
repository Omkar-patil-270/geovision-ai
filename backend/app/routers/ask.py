# backend/app/routers/ask.py
from groq import Groq
from fastapi import APIRouter
from pydantic import BaseModel
import os

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
client = Groq(api_key=os.getenv("GROQ_API_KEY"))


class AskRequest(BaseModel):
    location_name: str
    question: str
    predictions: dict


@router.post("/ask")
async def ask_anything(req: AskRequest):
    prompt = (
        f"Location: {req.location_name}. Real data: {req.predictions}. "
        f"User question: {req.question}. "
        f"Answer in 2-3 sentences using ONLY this real data. "
        f"If the data can't answer it, say so honestly."
    )
    res = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
    )
    return {"answer": res.choices[0].message.content}