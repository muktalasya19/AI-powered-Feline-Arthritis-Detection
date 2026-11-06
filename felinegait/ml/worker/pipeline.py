"""Gait pipeline: quality gate → pose → clean-up → stride segmentation → features → score.

Plug your existing preprocessing and feature-engineering code into the marked functions.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from scipy.signal import find_peaks, savgol_filter

MIN_STRIDES = 3
MIN_LIKELIHOOD = 0.6
MODEL_PATH = os.environ.get("MODEL_PATH", "models/gbm_v0.joblib")


class PipelineRejected(Exception):
    def __init__(self, reason: str, quality: dict | None = None):
        super().__init__(reason)
        self.quality = quality or {}


@dataclass
class GaitResult:
    score: int
    confidence: float
    risk_level: str
    features: dict
    quality: dict


# --------------------------------------------------------------------------- #
# 1. Quality gate
# --------------------------------------------------------------------------- #
def check_quality(video: Path) -> dict:
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frames, brightness, motion = 0, [], []
    prev = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames += 1
        if frames % 5:
            continue
        gray = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
        brightness.append(float(gray.mean()))
        if prev is not None:
            motion.append(float(cv2.absdiff(gray, prev).mean()))
        prev = gray
    cap.release()

    quality = {
        "durationS": round(frames / fps, 1),
        "fps": round(fps, 1),
        "meanBrightness": round(float(np.mean(brightness)) if brightness else 0, 1),
        "cameraShake": round(float(np.median(motion)) if motion else 0, 2),
    }
    if quality["durationS"] < 3:
        raise PipelineRejected("The video is too short — record at least 5 seconds of walking.", quality)
    if quality["meanBrightness"] < 40:
        raise PipelineRejected("The video is too dark — try brighter, even light.", quality)
    if quality["cameraShake"] > 25:
        raise PipelineRejected("The camera moved too much — rest the phone on the floor.", quality)
    # TODO: add a cat detector (e.g. YOLO) to confirm one cat in side view.
    return quality


# --------------------------------------------------------------------------- #
# 2. Pose estimation (DeepLabCut)
# --------------------------------------------------------------------------- #
def estimate_pose(video: Path, workdir: Path) -> dict[str, np.ndarray]:
    """Return {bodypart: array[n_frames, 3]} with columns x, y, likelihood.

    Uses DeepLabCut's SuperAnimal-Quadruped model to start; swap in your
    fine-tuned project config once trained.
    """
    import deeplabcut  # heavy import, only on the worker
    import pandas as pd

    deeplabcut.video_inference_superanimal(
        [str(video)],
        superanimal_name="superanimal_quadruped",
        model_name="hrnet_w32",
        detector_name="fasterrcnn_resnet50_fpn_v2",
        dest_folder=str(workdir),
        video_adapt=False,
    )
    h5 = next(workdir.glob("*.h5"))
    df = pd.read_hdf(h5)
    scorer = df.columns.levels[0][0]
    parts = df[scorer].columns.get_level_values(-2).unique()
    out = {}
    for part in parts:
        cols = df[scorer].xs(part, level=-2, axis=1)
        out[str(part)] = cols[["x", "y", "likelihood"]].to_numpy()
    return out


# --------------------------------------------------------------------------- #
# 3. Clean-up and normalisation
# --------------------------------------------------------------------------- #
def clean_keypoints(kp: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    cleaned = {}
    for part, arr in kp.items():
        xy = arr[:, :2].copy()
        xy[arr[:, 2] < MIN_LIKELIHOOD] = np.nan
        for i in range(2):
            col = xy[:, i]
            idx = np.arange(len(col))
            good = ~np.isnan(col)
            if good.sum() > 10:
                col[~good] = np.interp(idx[~good], idx[good], col[good])
                window = min(11, (len(col) // 2) * 2 - 1)
                if window >= 5:
                    col[:] = savgol_filter(col, window, 3)
        cleaned[part] = xy
    return cleaned


# --------------------------------------------------------------------------- #
# 4–5. Stride segmentation + features (replace with your feature module)
# --------------------------------------------------------------------------- #
def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    ba, bc = a - b, c - b
    cos = np.sum(ba * bc, axis=1) / (np.linalg.norm(ba, axis=1) * np.linalg.norm(bc, axis=1) + 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def extract_features(kp: dict[str, np.ndarray], fps: float) -> tuple[dict, int]:
    def get(*names):
        for n in names:
            if n in kp:
                return kp[n]
        raise PipelineRejected(f"Couldn't track the {names[0].replace('_', ' ')} clearly enough.")

    front_l, front_r = get("front_left_paw"), get("front_right_paw")
    back_l, back_r = get("back_left_paw"), get("back_right_paw")

    # Paw strikes = local minima of vertical velocity ~ peaks in y (image y grows downward)
    strikes = {
        name: find_peaks(paw[:, 1], distance=max(3, int(fps * 0.25)))[0]
        for name, paw in {"FL": front_l, "FR": front_r, "BL": back_l, "BR": back_r}.items()
    }
    n_strides = min(len(v) for v in strikes.values())
    if n_strides < MIN_STRIDES:
        raise PipelineRejected("We couldn't see three full strides — let your cat walk further across the frame.")

    stride_len = {k: float(np.median(np.diff(v))) / fps for k, v in strikes.items() if len(v) > 1}
    symmetry = 1 - abs(stride_len["BL"] - stride_len["BR"]) / max(stride_len["BL"], stride_len["BR"])
    cadence = sum(len(v) for v in strikes.values()) / (len(front_l) / fps)

    joint_angles = {}
    for side in ("left", "right"):
        try:
            hip, knee, ankle = get(f"back_{side}_thigh", "tail_base"), get(f"back_{side}_knee"), get(f"back_{side}_paw")
            joint_angles[f"stifle_{side}"] = float(np.ptp(_angle(hip, knee, ankle)))
        except PipelineRejected:
            pass

    spine_pts = [kp[p] for p in ("neck_base", "back_middle", "tail_base") if p in kp]
    spine_curv = float(np.mean(_angle(*spine_pts))) if len(spine_pts) == 3 else 0.0

    pelvis = get("tail_base", "back_middle")
    jerk = np.diff(pelvis, n=3, axis=0) * fps**3
    smoothness = float(1 / (1 + np.log1p(np.mean(np.linalg.norm(jerk, axis=1)))))

    features = {
        "strideSymmetry": round(float(symmetry), 3),
        "cadence": round(float(cadence), 2),
        "smoothness": round(smoothness, 3),
        "spineCurvature": round(180 - spine_curv, 1),
        "jointAngles": {k: round(v, 1) for k, v in joint_angles.items()},
        "strideCount": int(n_strides),
    }
    return features, n_strides


# --------------------------------------------------------------------------- #
# 6. Scoring
# --------------------------------------------------------------------------- #
FEATURE_ORDER = ["strideSymmetry", "cadence", "smoothness", "spineCurvature"]


def score(features: dict, n_strides: int, mean_likelihood: float) -> tuple[int, float, str]:
    x = np.array([[features[k] for k in FEATURE_ORDER]])
    if Path(MODEL_PATH).exists():
        import joblib

        model = joblib.load(MODEL_PATH)
        p_arthritis = float(model.predict_proba(x)[0, 1])
    else:
        # Heuristic fallback until v0 is trained: lower symmetry/smoothness → higher risk
        p_arthritis = float(np.clip(1 - (0.6 * features["strideSymmetry"] + 0.4 * features["smoothness"]), 0, 1))

    mobility = int(round(100 * (1 - p_arthritis)))
    confidence = float(np.clip(0.4 + 0.1 * n_strides, 0, 1) * mean_likelihood)
    risk = "low" if mobility >= 70 else "watch" if mobility >= 40 else "see_vet"
    return mobility, round(confidence, 2), risk


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run_pipeline(video: Path, workdir: Path, on_stage: Callable[[str], None]) -> GaitResult:
    quality = check_quality(video)
    on_stage("processing")

    raw = estimate_pose(video, workdir)
    mean_lik = float(np.mean([arr[:, 2].mean() for arr in raw.values()]))
    kp = clean_keypoints(raw)

    features, n_strides = extract_features(kp, quality["fps"])
    mobility, confidence, risk = score(features, n_strides, mean_lik)

    (workdir / "keypoints.json").write_text(
        json.dumps({k: np.nan_to_num(v).round(1).tolist() for k, v in kp.items()})
    )
    _write_thumbnail(video, workdir / "thumb.jpg")
    # TODO: render overlay.mp4 with keypoints drawn on each frame.

    return GaitResult(mobility, confidence, risk, features, quality)


def _write_thumbnail(video: Path, out: Path) -> None:
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) // 2))
    ok, frame = cap.read()
    cap.release()
    if ok:
        cv2.imwrite(str(out), frame)
