# backend/app/routers/clusters.py
import numpy as np
from fastapi import APIRouter
from sklearn.cluster import KMeans

router = APIRouter()


def generate_grid(lat, lon, radius_km=10, n_points=36):
    """Real grid of coordinates around the center point, not random noise."""
    points = []
    rings = 3
    per_ring = n_points // rings
    for ring in range(1, rings + 1):
        r = (radius_km / rings) * ring
        for i in range(per_ring):
            angle = (2 * np.pi / per_ring) * i
            dlat = (r / 111.0) * np.cos(angle)
            dlon = (r / (111.0 * np.cos(np.radians(lat)))) * np.sin(angle)
            points.append((lat + dlat, lon + dlon))
    points.append((lat, lon))
    return points


def estimate_stress_at_point(center_value, distance_km, decay=0.06):
    """
    Values decay outward from the real measured center value using an
    exponential distance-decay model — deterministic, no randomness, so
    the same input always produces the same output.
    """
    if center_value is None:
        center_value = 50
    factor = np.exp(-decay * distance_km)
    return max(0, center_value * factor)


@router.post("/clusters")
async def get_clusters(payload: dict):
    """
    payload: { lat, lon, aqi_current, population_current, migration_current }
    Returns k-means zone classification (k=3) around the location.
    """
    lat = payload.get("lat")
    lon = payload.get("lon")
    aqi_now = payload.get("aqi_current") or 50
    pop_now = payload.get("population_current") or 500000
    migration_now = payload.get("migration_current") or 1

    grid = generate_grid(lat, lon, radius_km=10, n_points=36)

    features = []
    coords = []
    for (glat, glon) in grid:
        dist = 111.0 * np.sqrt((glat - lat) ** 2 + (glon - lon) ** 2)
        aqi_val = estimate_stress_at_point(aqi_now, dist)
        pop_val = estimate_stress_at_point(pop_now, dist, decay=0.1)
        mig_val = estimate_stress_at_point(migration_now, dist, decay=0.08)
        features.append([aqi_val, pop_val, mig_val])
        coords.append((glat, glon))

    X = np.array(features)
    X_norm = (X - X.min(axis=0)) / (X.max(axis=0) - X.min(axis=0) + 1e-9)

    k = 3
    kmeans = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = kmeans.fit_predict(X_norm)

    zone_names = ["Zone Alpha — High Stress", "Zone Beta — Transition", "Zone Gamma — Low Stress"]
    cluster_stress = []
    for c in range(k):
        mask = labels == c
        avg_norm_stress = float(X_norm[mask].mean()) if mask.any() else 0
        cluster_stress.append((c, avg_norm_stress))
    cluster_stress.sort(key=lambda x: x[1], reverse=True)
    rank_to_name = {cluster_id: zone_names[i] for i, (cluster_id, _) in enumerate(cluster_stress)}

    zones = []
    for c in range(k):
        mask = labels == c
        count = int(mask.sum())
        if count == 0:
            continue
        avg_score = round(float(X_norm[mask].mean()) * 100, 1)
        zones.append({
            "name": rank_to_name[c],
            "point_count": count,
            "score": avg_score,
            "sample_points": [
                {"lat": coords[i][0], "lon": coords[i][1]}
                for i in range(len(coords)) if labels[i] == c
            ][:8],
        })

    zones.sort(key=lambda z: z["score"], reverse=True)

    return {
        "algorithm": "K-Means",
        "k": k,
        "total_points": len(grid),
        "zones": zones,
    }