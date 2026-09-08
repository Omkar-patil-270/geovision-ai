# backend/app/routers/ml_utils.py
import warnings
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", message=".*convergence.*", category=RuntimeWarning)
warnings.filterwarnings("ignore")


def arima_forecast(values, forecast_steps=5, test_size=None):
    """
    Fits a real ARIMA model on a time series and returns:
      - forecast: list of future predicted values
      - rmse, mae: real accuracy metrics from a train/test holdout split
      - order: the (p,d,q) ARIMA order actually used

    values: list of floats, in chronological order (oldest first)
    forecast_steps: how many future periods to predict
    test_size: how many of the most recent real points to hold out for
               validation (defaults to ~20% of the series, min 1, max 3)
    """
    from statsmodels.tsa.arima.model import ARIMA

    values = [v for v in values if v is not None]
    n = len(values)

    if n < 4:
        return _fallback_linear(values, forecast_steps)

    if test_size is None:
        test_size = max(1, min(3, n // 5))

    train = values[: n - test_size]
    test = values[n - test_size :]

    order_candidates = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (1, 0, 0)]
    best_model = None
    best_order = None
    for order in order_candidates:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                model = ARIMA(train, order=order).fit()
            best_model = model
            best_order = order
            break
        except Exception:
            continue

    if best_model is None:
        return _fallback_linear(values, forecast_steps)

    try:
        test_forecast = best_model.forecast(steps=len(test))
        rmse = float(np.sqrt(np.mean((np.array(test) - np.array(test_forecast)) ** 2)))
        mae = float(np.mean(np.abs(np.array(test) - np.array(test_forecast))))
    except Exception:
        rmse, mae = None, None

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            full_model = ARIMA(values, order=best_order).fit()
        forecast = full_model.forecast(steps=forecast_steps)
        forecast = [round(float(f), 3) for f in forecast]
    except Exception:
        return _fallback_linear(values, forecast_steps)

    return {
        "forecast": forecast,
        "rmse": round(rmse, 3) if rmse is not None else None,
        "mae": round(mae, 3) if mae is not None else None,
        "order": best_order,
        "method": "ARIMA",
    }


def sarima_forecast(values, forecast_steps=24, seasonal_period=12, test_size=None):
    """
    Fits SARIMA — ARIMA plus a seasonal term — for series with a strong
    yearly cycle (temperature is the clear case). Falls back to plain
    ARIMA if there isn't enough history for a real seasonal fit.
    """
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    values = [v for v in values if v is not None]
    n = len(values)

    # A seasonal ARIMA with (1,1,1)x(1,1,1,s) needs more than two complete
    # seasonal cycles. With shorter histories statsmodels cannot estimate the
    # starting ARMA parameters and emits EstimationWarning; plain ARIMA is
    # the honest non-seasonal fallback for those locations.
    if n < max(seasonal_period * 3, 24):
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    if test_size is None:
        test_size = min(seasonal_period * 2, max(1, n // 5))

    train = values[: n - test_size]
    test = values[n - test_size :]

    order = (1, 1, 1)
    seasonal_order = (1, 1, 1, seasonal_period)

    try:
        with warnings.catch_warnings():
            from statsmodels.tools.sm_exceptions import EstimationWarning
            warnings.simplefilter("error", EstimationWarning)
            warnings.simplefilter("ignore", UserWarning)
            model = SARIMAX(
                train, order=order, seasonal_order=seasonal_order,
                enforce_stationarity=False, enforce_invertibility=False,
            ).fit(disp=False)
    except Exception:
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    try:
        test_forecast = model.forecast(steps=len(test))
        rmse = float(np.sqrt(np.mean((np.array(test) - np.array(test_forecast)) ** 2)))
        mae = float(np.mean(np.abs(np.array(test) - np.array(test_forecast))))
    except Exception:
        rmse, mae = None, None

    try:
        with warnings.catch_warnings():
            from statsmodels.tools.sm_exceptions import EstimationWarning
            warnings.simplefilter("error", EstimationWarning)
            warnings.simplefilter("ignore", UserWarning)
            full_model = SARIMAX(
                values, order=order, seasonal_order=seasonal_order,
                enforce_stationarity=False, enforce_invertibility=False,
            ).fit(disp=False)
        forecast = full_model.forecast(steps=forecast_steps)
        forecast = [round(float(f), 3) for f in forecast]
    except Exception:
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    return {
        "forecast": forecast,
        "rmse": round(rmse, 3) if rmse is not None else None,
        "mae": round(mae, 3) if mae is not None else None,
        "order": f"{order}{seasonal_order}",
        "method": "SARIMA",
    }


def expanding_window_validation(values, years, min_train=None, validation_start_year=None, validation_end_year=None):
    """
    Chronological expanding-window validation for ARIMA — the correct way
    to validate a time-series model. Always trains from the first available year.
    Expands one year at a time. Never uses future data during training.

    For WorldPop data (2015–2020, 6 years) with min_train=3:
      - TRAIN 2015–2017 -> TEST 2018
      - TRAIN 2015–2018 -> TEST 2019
      - TRAIN 2015–2019 -> TEST 2020

    For World Bank data (1960–2023, 60+ years) with min_train=5:
      - TRAIN 1960–1964 -> TEST 1965
      - ... continues through ...
      - TRAIN 1960–2022 -> TEST 2023

    For each validation step:
      1. Fit ARIMA on training data only
      2. Forecast exactly 1 year ahead
      3. Compare against real actual value
      4. Store: train_start, train_end, test_year, actual, predicted, abs_error, pct_error
    """
    import warnings
    warnings.filterwarnings("ignore")
    from statsmodels.tsa.arima.model import ARIMA

    paired = [(int(y), float(v)) for y, v in zip(years, values) if v is not None]
    paired.sort(key=lambda item: item[0])
    years = [y for y, _ in paired]
    values = [v for _, v in paired]
    n = len(values)

    if min_train is None:
        min_train = 5 if n > 15 else 3

    if n < min_train + 1:
        return None   # not enough data for even one validation step

    order_candidates = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (1, 0, 0)]

    def _fit_and_forecast(train_vals):
        warnings.filterwarnings("ignore")
        for order in order_candidates:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    model = ARIMA(train_vals, order=order).fit()
                fc = float(model.forecast(steps=1)[0])
                return fc, order
            except Exception:
                continue
        return None, None

    rows = []
    best_order = None

    # Expanding window: ALWAYS train from index 0 (first available year) to i-1, test on index i
    start_train_index = min_train
    last_index = n
    if validation_end_year is not None:
        matching_end = [idx for idx, yr in enumerate(years) if yr <= int(validation_end_year)]
        if matching_end:
            last_index = matching_end[-1] + 1

    for i in range(start_train_index, min(last_index, n)):
        train_vals = values[:i]
        actual = values[i]
        train_years = years[:i]
        test_year = years[i]

        predicted, order = _fit_and_forecast(train_vals)
        if predicted is None:
            continue
        if best_order is None and order is not None:
            best_order = order

        signed_error = actual - predicted
        abs_err = abs(actual - predicted)
        pct_err = (abs_err / actual * 100) if actual != 0 else None

        rows.append({
            "train_start": int(train_years[0]),
            "train_end": int(train_years[-1]),
            "test_year": int(test_year),
            "actual": round(float(actual), 1),
            "predicted": round(float(predicted), 1),
            "error": round(float(signed_error), 1),
            "abs_error": round(float(abs_err), 1),
            "absolute_error": round(float(abs_err), 1),
            "pct_error": round(float(pct_err), 2) if pct_err is not None else None,
        })

    if not rows:
        return None

    actuals = np.array([r["actual"] for r in rows])
    predicted_arr = np.array([r["predicted"] for r in rows])
    errors = np.abs(actuals - predicted_arr)

    mae = float(np.mean(errors))
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    mape_vals = [(abs(a - p) / a * 100) for a, p in zip(actuals, predicted_arr) if a != 0]
    mape = float(np.mean(mape_vals)) if mape_vals else None

    # Add cumulative metrics to every row for the validation table
    for end in range(1, len(rows) + 1):
        actual_slice = np.array([r["actual"] for r in rows[:end]])
        predicted_slice = np.array([r["predicted"] for r in rows[:end]])
        diff = actual_slice - predicted_slice
        rows[end - 1]["mae"] = round(float(np.mean(np.abs(diff))), 1)
        rows[end - 1]["rmse"] = round(float(np.sqrt(np.mean(diff ** 2))), 1)
        rows[end - 1]["mape"] = round(float(np.mean([abs(a - p) / a * 100 for a, p in zip(actual_slice, predicted_slice) if a != 0])), 2) if any(actual_slice != 0) else None

    # Final model: fit on ALL available historical data, forecast 1 step ahead
    final_fc, final_order = _fit_and_forecast(values)
    final_year = int(years[-1]) + 1

    return {
        "validation_rows": rows,
        "mae": round(mae, 1),
        "rmse": round(rmse, 1),
        "mape": round(mape, 2) if mape is not None else None,
        "order": best_order or final_order,
        "final_forecast_year": final_year,
        "final_forecast_value": round(final_fc, 1) if final_fc is not None else None,
        "method": "ARIMA",
        "n_train_total": n,
        "n_validation_steps": len(rows),
    }


def rolling_population_validation(values, years, window_years=6, start_test_year=2021, end_test_year=2025):
    """Chronological rolling-window validation for local population.

    Each test year uses only the immediately preceding six observed years:
    2015-2020 -> 2021, 2016-2021 -> 2022, and so on. No shuffle, future
    leakage, interpolation, or fabricated observations are used.
    """
    from statsmodels.tsa.arima.model import ARIMA
    import warnings

    paired = sorted((int(y), float(v)) for y, v in zip(years, values) if v is not None)
    by_year = {year: value for year, value in paired}
    rows = []
    orders = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (1, 0, 0)]

    for test_year in range(start_test_year, end_test_year + 1):
        train_years = list(range(test_year - window_years, test_year))
        if any(year not in by_year for year in train_years) or test_year not in by_year:
            continue
        train_values = [by_year[year] for year in train_years]
        predicted = None
        order_used = None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for order in orders:
                try:
                    fitted = ARIMA(train_values, order=order).fit()
                    predicted = float(fitted.forecast(steps=1)[0])
                    order_used = order
                    break
                except Exception:
                    continue
        if predicted is None:
            continue
        actual = by_year[test_year]
        error = actual - predicted
        abs_error = abs(error)
        rows.append({
            "train_start": train_years[0], "train_end": train_years[-1],
            "test_year": test_year, "actual": round(actual, 1),
            "predicted": round(predicted, 1), "error": round(error, 1),
            "abs_error": round(abs_error, 1), "absolute_error": round(abs_error, 1),
            "pct_error": round(abs_error / actual * 100, 2) if actual else None,
            "order": order_used,
        })

    if not rows:
        return {"validation_rows": [], "mae": None, "rmse": None, "mape": None,
                "method": "ARIMA", "window_years": window_years,
                "requested_test_years": list(range(start_test_year, end_test_year + 1)),
                "missing_test_years": list(range(start_test_year, end_test_year + 1))}

    actuals = np.array([row["actual"] for row in rows])
    preds = np.array([row["predicted"] for row in rows])
    diffs = actuals - preds
    for index in range(len(rows)):
        d = diffs[: index + 1]
        a = actuals[: index + 1]
        p = preds[: index + 1]
        rows[index]["mae"] = round(float(np.mean(np.abs(d))), 1)
        rows[index]["rmse"] = round(float(np.sqrt(np.mean(d ** 2))), 1)
        rows[index]["mape"] = round(float(np.mean(np.abs(d[a != 0] / a[a != 0]) * 100)), 2) if np.any(a != 0) else None

    return {
        "validation_rows": rows,
        "mae": round(float(np.mean(np.abs(diffs))), 1),
        "rmse": round(float(np.sqrt(np.mean(diffs ** 2))), 1),
        "mape": round(float(np.mean(np.abs(diffs[actuals != 0] / actuals[actuals != 0]) * 100)), 2) if np.any(actuals != 0) else None,
        "method": "ARIMA", "window_years": window_years,
        "requested_test_years": list(range(start_test_year, end_test_year + 1)),
        "missing_test_years": [year for year in range(start_test_year, end_test_year + 1) if year not in {r["test_year"] for r in rows}],
    }

def _fallback_linear(values, forecast_steps):
    """Honest fallback when there isn't enough real data for ARIMA — a simple
    trend projection, clearly labeled as such rather than disguised as ARIMA."""
    if len(values) < 2:
        last = values[-1] if values else 0
        return {
            "forecast": [round(last, 3)] * forecast_steps,
            "rmse": None, "mae": None, "order": None, "method": "insufficient_data",
        }
    growth = (values[-1] - values[0]) / max(len(values) - 1, 1)
    forecast = [round(values[-1] + growth * (i + 1), 3) for i in range(forecast_steps)]
    return {"forecast": forecast, "rmse": None, "mae": None, "order": None, "method": "linear_fallback"}
