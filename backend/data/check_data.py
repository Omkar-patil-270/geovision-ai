import pandas as pd

df = pd.read_csv("bengaluru_aqi.csv", parse_dates=["date"])

print("Missing AQI values:", df["aqi"].isna().sum())
print()
print("AQI stats:")
print(df["aqi"].describe())
print()

df["year"] = df["date"].dt.year
print("Yearly average AQI:")
print(df.groupby("year")["aqi"].mean().round(1))