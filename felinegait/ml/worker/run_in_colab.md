# Run the worker on a free GPU (Google Colab or Kaggle)

Colab and Kaggle give free GPU time in notebooks. Sessions end after a few hours
or when idle, so treat this as "process the queue now", not an always-on server.
Videos stay safely queued in Firestore until a worker picks them up.

Paste these into notebook cells:

```python
# 1. Get the code
!git clone https://github.com/<your-username>/felinegait.git
%cd felinegait/ml/worker
!pip install -q -r requirements.txt "deeplabcut==3.0.0"
```

```python
# 2. Credentials — upload service-account.json with the file panel first,
#    or use Colab "Secrets" (key icon) and read them with google.colab.userdata.
import os
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/content/service-account.json"
os.environ["S3_ENDPOINT"] = "https://<account-id>.r2.cloudflarestorage.com"
os.environ["S3_REGION"] = "auto"
os.environ["S3_BUCKET"] = "felinegait-media"
os.environ["S3_ACCESS_KEY_ID"] = "..."
os.environ["S3_SECRET_ACCESS_KEY"] = "..."
```

```python
# 3a. Drain the queue once
!python worker.py --once

# 3b. …or keep polling while the notebook is open
!python worker.py
```

Never commit `service-account.json` or paste keys into a notebook you share.
