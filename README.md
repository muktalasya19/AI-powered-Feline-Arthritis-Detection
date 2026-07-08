# Feline Arthritis Detector

Video-based gait/posture analysis to screen for signs of osteoarthritis in cats,
using pose estimation + gait feature analysis.

⚠️ This is a research/screening tool, not a diagnostic device. Always consult a vet.

## Setup
1. `pip install -r requirements.txt`
2. Pose estimation (DeepLabCut) is run in Colab — see `notebooks/01_pose_estimation_exploration.ipynb`
3. Run the demo: `streamlit run app/streamlit_app.py`

## Project Status
- [ ] Data collection
- [ ] Pose estimation pipeline
- [ ] Feature engineering
- [ ] Model training
- [ ] Demo app
- [ ] Write-up

## Data Sources
See `data/metadata.csv` for video sources and label confidence levels.
