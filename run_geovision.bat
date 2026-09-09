@echo off
title GeoVisionAI Launcher
echo ===================================================
echo Starting GeoVisionAI Platform (Backend + Frontend)
echo ===================================================

start "GeoVisionAI Backend (Port 8000)" cmd /k "cd /d %~dp0backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

start "GeoVisionAI Frontend (Port 5173)" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 2 >nul
start http://localhost:5173

