import pandas as pd

df = pd.read_csv("aqi_all_india.csv")

bengaluru = df[df["city"].str.contains("Bengaluru|Bangalore", case=False, na=False)]

bengaluru = bengaluru.sort_values("date")

bengaluru.to_csv("bengaluru_aqi.csv", index=False)

print("Total rows found:", len(bengaluru))
print(bengaluru.head())