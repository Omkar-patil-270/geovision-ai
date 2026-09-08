import ee
import pandas as pd

ee.Initialize(project="geovisionai-500715")

bengaluru = ee.Geometry.Point([77.5946, 12.9716])

years = list(range(2015, 2024))
results = []

for year in years:
    start = f"{year}-01-01"
    end = f"{year}-12-31"

    collection = (
        ee.ImageCollection("MODIS/061/MOD13A2")
        .filterDate(start, end)
        .select("NDVI")
    )

    mean_image = collection.mean()
    value = mean_image.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=bengaluru,
        scale=1000
    ).get("NDVI").getInfo()

    ndvi_value = value / 10000 if value else None
    results.append({"year": year, "ndvi": ndvi_value})
    print(year, ndvi_value)

df = pd.DataFrame(results)
df.to_csv("bengaluru_ndvi.csv", index=False)
print("Saved to bengaluru_ndvi.csv")