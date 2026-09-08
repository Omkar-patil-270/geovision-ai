import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression

df = pd.read_csv("bengaluru_aqi.csv", parse_dates=["date"])
df = df.sort_values("date")

df["day_number"] = (df["date"] - df["date"].min()).dt.days

X = df[["day_number"]].values
y = df["aqi"].values

model = LinearRegression()
model.fit(X, y)

last_day = df["day_number"].max()
last_date = df["date"].max()

future_days = np.array([last_day + (i * 365) for i in range(1, 6)]).reshape(-1, 1)
future_predictions = model.predict(future_days)

print("5-Year AQI Forecast for Bengaluru:")
for i, pred in enumerate(future_predictions, start=1):
    year = last_date.year + i
    print(f"{year}: {round(pred, 1)} AQI")

results = pd.DataFrame({
    "year": [last_date.year + i for i in range(1, 6)],
    "predicted_aqi": [round(p, 1) for p in future_predictions]
})
results.to_csv("bengaluru_aqi_forecast.csv", index=False)
print()
print("Saved to bengaluru_aqi_forecast.csv")