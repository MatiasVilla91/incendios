#!/usr/bin/env python3
"""
Seismic Risk Forecaster
=======================
Uses 2 years of USGS earthquake catalog data to train an XGBoost model
that estimates P(M≥5.0 in the next 7 days) for each 5°×5° grid cell.

The model is based on established seismological methods:
  - Gutenberg-Richter b-value (Aki 1965 MLE)
  - Omori-Utsu aftershock decay law
  - ETAS-style seismicity rate features

Output: seismic_predictions.json  — load this in the globe visualization.

Usage:
  pip install pandas numpy requests xgboost scikit-learn
  python train_seismic_model.py

Re-run weekly to keep predictions current.
"""

import json
import math
import time
import requests
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from pathlib import Path

try:
    import xgboost as xgb
    from sklearn.model_selection import cross_val_score, StratifiedKFold
    from sklearn.metrics import roc_auc_score, classification_report
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    print("! XGBoost not found — using statistical model only.")
    print("  Install: pip install xgboost scikit-learn\n")


# ── Configuration ──────────────────────────────────────────────────────────────
GRID_DEG       = 5          # Cell size in degrees
LOOKBACK_DAYS  = 30         # Feature window
TARGET_MAG     = 5.0        # Forecast threshold
TARGET_DAYS    = 7          # Forecast horizon
MIN_CATALOG_MAG = 2.5       # Catalog completeness magnitude
TRAIN_YEARS    = 2          # Years of historical data for training
SLIDE_DAYS     = 14         # Sliding window step for training samples
CACHE_FILE     = "usgs_cache.csv"
OUTPUT_FILE    = "seismic_predictions.json"

FEATURE_NAMES = [
    "n_eq_30d",       # Earthquake count last 30 days
    "max_mag",        # Maximum magnitude
    "mean_mag",       # Mean magnitude
    "b_value",        # Gutenberg-Richter b-value (Aki MLE)
    "mean_depth_km",  # Mean focal depth
    "days_since_last",# Days since most recent event
    "log_energy",     # Log10 of cumulative seismic energy
    "rate_trend",     # Late/early rate ratio (acceleration)
    "n_eq_90d",       # Background count last 90 days
    "omori_rate",     # ETAS Omori contribution from M≥4 events
]


# ── Data Download ──────────────────────────────────────────────────────────────
def download_usgs_chunk(start: datetime, end: datetime, min_mag: float) -> pd.DataFrame:
    url = (
        "https://earthquake.usgs.gov/fdsnws/event/1/query"
        f"?format=csv"
        f"&starttime={start.strftime('%Y-%m-%d')}"
        f"&endtime={end.strftime('%Y-%m-%d')}"
        f"&minmagnitude={min_mag}"
        f"&orderby=time-asc"
        "&limit=20000"
    )
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    from io import StringIO
    df = pd.read_csv(StringIO(resp.text))
    return df[["time", "latitude", "longitude", "depth", "mag"]].dropna(subset=["mag"])


def download_catalog(years: int = 2) -> pd.DataFrame:
    end_date   = datetime.utcnow()
    start_date = end_date - timedelta(days=365 * years)

    if Path(CACHE_FILE).exists():
        print(f"  Loading cached catalog: {CACHE_FILE}")
        df = pd.read_csv(CACHE_FILE)
        df["time"] = pd.to_datetime(df["time"], format='ISO8601', utc=True)
        cached_end = df["time"].max()
        # Download only newer data
        if (end_date - cached_end.replace(tzinfo=None)).days < 2:
            print(f"  Cache is up to date ({len(df):,} events).")
            return df
        print(f"  Updating cache from {cached_end.date()} …")
        start_date = cached_end.replace(tzinfo=None) + timedelta(hours=1)
        existing = df
    else:
        existing = pd.DataFrame()

    chunks = []
    cursor = start_date
    while cursor < end_date:
        chunk_end = min(cursor + timedelta(days=89), end_date)
        print(f"  Downloading {cursor.date()} → {chunk_end.date()} …", end=" ", flush=True)
        try:
            chunk = download_usgs_chunk(cursor, chunk_end, MIN_CATALOG_MAG)
            print(f"{len(chunk):,} events")
            chunks.append(chunk)
        except Exception as exc:
            print(f"ERROR: {exc}")
        cursor = chunk_end + timedelta(days=1)
        time.sleep(0.5)

    if not chunks:
        return existing

    new_df = pd.concat(chunks, ignore_index=True)
    new_df["time"] = pd.to_datetime(new_df["time"], utc=True)

    full_df = pd.concat([existing, new_df], ignore_index=True)
    full_df = full_df.drop_duplicates(subset=["time", "latitude", "longitude", "mag"])
    full_df = full_df.sort_values("time").reset_index(drop=True)
    full_df.to_csv(CACHE_FILE, index=False)
    print(f"  Saved {len(full_df):,} events to {CACHE_FILE}")
    return full_df


# ── Feature Engineering ────────────────────────────────────────────────────────
def b_value_mle(mags, mc=MIN_CATALOG_MAG) -> float:
    """Aki (1965) maximum likelihood b-value estimator."""
    above = [m for m in mags if m >= mc]
    if len(above) < 5:
        return 1.0
    return math.log10(math.e) / max(0.01, np.mean(above) - mc + 0.05)


def omori_rate(quakes_df, ref_time: datetime) -> float:
    """Cumulative Omori-Utsu aftershock contribution at ref_time."""
    K, alpha, c, p = 0.08, 0.8, 0.001, 1.1
    total = 0.0
    for _, row in quakes_df[quakes_df["mag"] >= 4.0].iterrows():
        t_days = max(0, (ref_time - row["time"].replace(tzinfo=None)).total_seconds() / 86400)
        total += K * (10 ** (alpha * (row["mag"] - MIN_CATALOG_MAG))) / ((t_days + c) ** p)
    return min(total, 50.0)


def compute_features(cell_df: pd.DataFrame, ref_time: datetime) -> list:
    win30_start = ref_time - timedelta(days=LOOKBACK_DAYS)
    win90_start = ref_time - timedelta(days=90)

    ref_time_utc = pd.Timestamp(ref_time).tz_localize("UTC")
    win30_utc    = pd.Timestamp(win30_start).tz_localize("UTC")
    win90_utc    = pd.Timestamp(win90_start).tz_localize("UTC")

    recent = cell_df[(cell_df["time"] >= win30_utc) & (cell_df["time"] < ref_time_utc)]
    bg90   = cell_df[(cell_df["time"] >= win90_utc)  & (cell_df["time"] < ref_time_utc)]

    if len(recent) == 0:
        return [0, 0, 0, 1.0, 30.0, 30.0, 0, 0, len(bg90), 0]

    mags   = recent["mag"].values
    depths = recent["depth"].fillna(10).clip(0, 700).values

    days_since = (ref_time_utc - recent["time"].max()).total_seconds() / 86400

    energy = sum(10 ** (1.5 * m + 4.8) for m in mags)

    n = len(recent)
    half = n // 2
    late  = n - half
    early = max(half, 1)
    rate_trend = late / early - 1.0

    bval = b_value_mle(mags)

    om_rate = omori_rate(recent, ref_time)

    return [
        float(n),
        float(mags.max()),
        float(mags.mean()),
        float(bval),
        float(depths.mean()),
        float(days_since),
        float(math.log10(energy + 1)),
        float(np.clip(rate_trend, -2, 5)),
        float(len(bg90)),
        float(om_rate),
    ]


# ── Grid Assignment ────────────────────────────────────────────────────────────
def assign_grid(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["lat_bin"] = (np.floor(df["latitude"]  / GRID_DEG) * GRID_DEG).astype(int)
    df["lng_bin"] = (np.floor(df["longitude"] / GRID_DEG) * GRID_DEG).astype(int)
    df["cell"]    = df["lat_bin"].astype(str) + "_" + df["lng_bin"].astype(str)
    return df


# ── Training Data ──────────────────────────────────────────────────────────────
def build_training_set(df: pd.DataFrame):
    print("  Building training samples (sliding window) …")
    df = assign_grid(df)

    earliest = df["time"].min().replace(tzinfo=None) + timedelta(days=LOOKBACK_DAYS + 5)
    latest   = df["time"].max().replace(tzinfo=None) - timedelta(days=TARGET_DAYS + 1)
    dates    = pd.date_range(earliest, latest, freq=f"{SLIDE_DAYS}D")

    rows = []
    cells = df.groupby("cell")

    for cell_id, cell_df in cells:
        lat_bin, lng_bin = map(int, cell_id.split("_"))

        cell_df_plain = cell_df.copy()
        cell_df_plain["time_plain"] = cell_df_plain["time"].dt.tz_localize(None)

        for sample_date in dates:
            features = compute_features(cell_df, sample_date)

            future_start = pd.Timestamp(sample_date).tz_localize("UTC")
            future_end   = future_start + timedelta(days=TARGET_DAYS)
            future = cell_df[
                (cell_df["time"] >= future_start) &
                (cell_df["time"] <  future_end)
            ]
            label = int((future["mag"] >= TARGET_MAG).any())
            rows.append(features + [lat_bin, lng_bin, label])

    cols = FEATURE_NAMES + ["lat_bin", "lng_bin", "label"]
    return pd.DataFrame(rows, columns=cols)


# ── Model Training ─────────────────────────────────────────────────────────────
def train_xgboost(training_df: pd.DataFrame):
    X = training_df[FEATURE_NAMES].values.astype(np.float32)
    y = training_df["label"].values

    pos  = y.sum()
    neg  = len(y) - pos
    spw  = neg / max(pos, 1)

    print(f"  Samples: {len(X):,}  |  Positive rate: {pos/len(y)*100:.1f}%  |  scale_pos_weight: {spw:.1f}")

    model = xgb.XGBClassifier(
        n_estimators      = 200,
        max_depth         = 5,
        learning_rate     = 0.05,
        subsample         = 0.8,
        colsample_bytree  = 0.8,
        scale_pos_weight  = spw,
        use_label_encoder = False,
        eval_metric       = "logloss",
        random_state      = 42,
        n_jobs            = -1,
    )

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X, y, cv=cv, scoring="roc_auc", n_jobs=-1)
    print(f"  5-fold CV AUC: {auc_scores.mean():.3f} ± {auc_scores.std():.3f}")

    model.fit(X, y, verbose=False)
    return model, auc_scores.mean()


# ── Statistical Fallback (no XGBoost) ─────────────────────────────────────────
def statistical_risk(features: list) -> float:
    """ETAS-based probabilistic risk (Gutenberg-Richter + Omori + Poisson)."""
    n_eq, max_m, mean_m, bval, _, days_since, _, _, n90, omori = features

    lambda_bg     = n_eq / LOOKBACK_DAYS
    lambda_omori  = omori
    lambda_total  = lambda_bg + lambda_omori

    expected_total = lambda_total * TARGET_DAYS
    expected_m5    = expected_total * (10 ** (-bval * (TARGET_MAG - MIN_CATALOG_MAG)))

    return float(1 - math.exp(-max(0, expected_m5)))


# ── Prediction Export ──────────────────────────────────────────────────────────
def export_predictions(df: pd.DataFrame, model=None, auc: float = None):
    print("  Computing current predictions …")
    df = assign_grid(df)
    now = df["time"].max().replace(tzinfo=None)

    predictions = []
    for cell_id, cell_df in df.groupby("cell"):
        lat_bin, lng_bin = map(int, cell_id.split("_"))

        features = compute_features(cell_df, now)

        if model is not None:
            X = np.array(features, dtype=np.float32).reshape(1, -1)
            risk = float(model.predict_proba(X)[0][1])
        else:
            risk = statistical_risk(features)

        count = int(features[0])
        bg90  = int(features[8])

        if count == 0 and bg90 == 0:
            continue

        predictions.append({
            "lat":     lat_bin + GRID_DEG / 2,
            "lng":     lng_bin + GRID_DEG / 2,
            "risk":    round(risk, 4),
            "n_recent": count,
            "max_mag":  round(features[1], 1),
            "b_value":  round(features[3], 2),
        })

    predictions.sort(key=lambda p: -p["risk"])

    output = {
        "generated": now.isoformat(),
        "model":     "xgboost" if model else "etas-statistical",
        "auc":       round(auc, 3) if auc else None,
        "target":    f"P(M≥{TARGET_MAG} in next {TARGET_DAYS} days)",
        "n_cells":   len(predictions),
        "predictions": predictions,
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    size_kb = Path(OUTPUT_FILE).stat().st_size / 1024
    print(f"  Saved {len(predictions)} zone predictions to {OUTPUT_FILE} ({size_kb:.0f} KB)")
    return predictions


# ── Summary ────────────────────────────────────────────────────────────────────
def print_summary(predictions, auc):
    print()
    print("=" * 52)
    print("  SEISMIC RISK FORECAST — GLOBAL")
    print("=" * 52)
    print(f"  Model : {'XGBoost  AUC=' + str(round(auc,3)) if auc else 'ETAS Statistical'}")
    print(f"  Target: P(M≥{TARGET_MAG}) next {TARGET_DAYS} days per 5°×5° cell")
    print(f"  Zones : {len(predictions)} active cells")
    print()
    print("  TOP 10 HIGHEST RISK ZONES:")
    for i, p in enumerate(predictions[:10], 1):
        lat_s = f"{abs(p['lat']):.1f}°{'N' if p['lat']>=0 else 'S'}"
        lng_s = f"{abs(p['lng']):.1f}°{'E' if p['lng']>=0 else 'W'}"
        bar   = "█" * int(p['risk'] * 20)
        print(f"  {i:2d}. {lat_s:7s} {lng_s:8s}  {p['risk']*100:5.1f}%  {bar}")
    print()
    print("  DISCLAIMER: Probabilistic estimates only.")
    print("  Earthquake prediction remains unsolved science.")
    print("=" * 52)


# ── Entry Point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n  Seismic Risk Forecaster")
    print("  ─────────────────────────────────────────")

    print("\n[1/4] Downloading earthquake catalog …")
    df = download_catalog(years=TRAIN_YEARS)
    print(f"      Total events: {len(df):,}")

    model, auc = None, None

    if HAS_XGB:
        print("\n[2/4] Building training dataset …")
        training_df = build_training_set(df)
        print(f"      {len(training_df):,} samples")

        print("\n[3/4] Training XGBoost model …")
        model, auc = train_xgboost(training_df)
    else:
        print("\n[2/4] Skipped (XGBoost not installed)")
        print("[3/4] Skipped — using ETAS statistical model")

    print("\n[4/4] Exporting predictions …")
    preds = export_predictions(df, model, auc)

    print_summary(preds, auc)
    print(f"\n  Output: {OUTPUT_FILE}")
    print("  Reload the globe — risk zones will appear automatically.\n")
