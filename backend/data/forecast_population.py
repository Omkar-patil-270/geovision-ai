import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression

df = pd.read_csv("bengaluru_population.csv")

X = df[["year"]].values
y = df["population"].values

model = LinearRegression()
model.fit(X, y)

last_year = df["year"].max()
future_years = np.array([last_year + i for i in range(1, 6)]).reshape(-1, 1)
predictions = model.predict(future_years)

print("5-Year Population Forecast:")
for year, pred in zip(future_years.flatten(), predictions):
    print(f"{year}: {int(pred):,}")