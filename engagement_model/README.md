# TRAC-Engage research implementation

[Research paper, foundation notes and full-page architecture](../docs/engagement/README.md)

Status, 14 October 2026: **research implementation with a public CMOSE clip-feature training pilot, not a production-validated video engagement detector**. No cloud service is deployed. Meridian's acquisition, routes, and frontend are unchanged.

## Implemented versus proposed

| Component | Current implementation |
|---|---|
| Temporal experts | Trainable causal dilated convolutions over precomputed features |
| Fusion | Four learned queries, two cross-attention blocks, quality/age/drift masking; weighted-mean baseline |
| Output | Ordered cumulative head, dataset-native class count, 0–100 ordinal expectation |
| Evidence contract | Track generation, timestamps, quality, expiry validation |
| Training | AdamW, gradient clipping, early stopping on validation MAE, participant/session split checks, manifest hash |
| Evaluation | Held-out metrics, separate calibration temperature search, per-example probabilities |
| Tuning | Validation-only two-fusion/two-learning-rate/three-seed sweep |
| Face preprocessing | Frozen ImageNet ResNet18; unique frontal Haar face crop, not aligned production face extraction |
| Local inference | Explicitly unvalidated single-face file/camera baseline; JSONL and annotated AVI; synthetic weights refused |
| RT-DETR + ByteTrack | Specified in paper, **not integrated** |
| VideoMAE / OpenFace / audio / physiology | Feature interfaces exist; production extractors and weights **not integrated** |
| Learned value-of-information policy | Specified; only a tested greedy gain/cost allocation helper exists |
| Stale-cache replay | Specified ablation, **not implemented or evaluated** |
| Generalization / production validation | **Not completed** |

Multiple visual branches are multi-view visual modelling, not multiple sensing modalities. Neither a pretrained ImageNet network nor a synthetic classifier measures engagement without labelled human training and validation.

## Windows setup

Run from this `engagement_model` folder, not the acquisition-agent folder. Python 3.12 was tested. This environment is separate from Meridian and its sensors.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pytest -q --basetemp=./runs/pytest-temp
```

Create `runs` first if absent (`New-Item -ItemType Directory -Force runs`). Calling the environment's Python directly avoids PowerShell activation policy problems. Current installed build is CPU PyTorch. Intel Arc was detected, but XPU acceleration was not configured or benchmarked.

## Official datasets and access

- [CMOSE, official authors' project](https://jasonwuchi.github.io/CMOSE/): publicly downloadable [visual, acoustic and transcript features](https://huggingface.co/datasets/cwuau/CMOSE), CC BY-SA 4.0. The two-file subset is about 457 MB and has been downloaded and checksum-verified. No DAiSEE approval is needed for this independent dataset. See the reproducible pilot below.
- [DAiSEE](https://people.iith.ac.in/vineethnb/resources/daisee/): preferred initial four-level webcam benchmark; official research-use request, approximately 15 GB compressed, extra extraction space required. No agreement was submitted or unofficial mirror used.
- [DIPSER/DIPSEER](https://doi.org/10.57760/sciencedb.11541): official CC BY 4.0 dataset, five-level engagement, approximately 668.27 GB. The file browser was inspected, but a usable bounded labelled subset was not retrieved. Do not download the entire corpus onto this laptop.
- [MultiMediate26](https://github.com/hcmlab/MultiMediate26): useful official domain-transfer benchmark and feature reference; targets, licences and splits differ. Its current specification is not evidence of completed future conference results.

The laptop had about 23 GB free before setup. The CMOSE subset fits, but the complete DIPSER release does not. Preserve attribution, participant IDs and annotation support intervals. A dataset's licence does not establish suitability for surveillance or high-stakes decisions.

## Reproduce the CMOSE feature pilot

```powershell
.\.venv\Scripts\python.exe -m trac.download_cmose --output data/cmose
.\.venv\Scripts\python.exe -m trac.cmose --input data/cmose --output data/cmose-prepared-new
.\.venv\Scripts\python.exe -m trac.cmose_experiment --data data/cmose-prepared-new --output runs/cmose-new --epochs 10
```

Use fresh output names; existing experiments are not overwritten. The downloader checks the authors' published SHA-256 values. The preparation audit records 12,197 source clips, 295 excluded empty I3D embeddings, and 11,902 usable clips. Both normalization and feature clipping statistics are training-only. Released label-agreement scores are never model inputs.

For an interrupted sweep, `--resume` preserves completed training reports and restarts an interrupted configuration in a separate `-retry` directory. It refuses to resume after test results exist. Cached training/validation features are reused in RAM; calibration/test features are evaluated only after configuration selection is locked. Use `python -m trac.summarize_cmose --data DATA_DIRECTORY --run RUN_DIRECTORY` after completion to produce the majority baseline and a compact CSV/JSON summary.

- Training: sessions 1, 5, 6, 7, 14, 18; 8,806 clips.
- Model selection: session 15; 709 clips.
- Calibration: session 16; 734 clips.
- Locked test: session 10; 1,653 clips.

IDs are session-scoped. This is **session-disjoint**, not verified globally person-disjoint evaluation. It is not the original paper's split and cannot be compared directly with its leaderboard. The dataset is imbalanced; majority-class accuracy, macro-F1 and balanced accuracy must accompany ordinary accuracy. One held-out session and one lowest-class calibration example are substantial limitations.

The pilot trains visual-only mean, multimodal mean and multimodal latent fusion. Input dimensions are I3D 1024, BERT 768, acoustics 6. All are **whole-clip features with one token**, so temporal and streaming novelty is not tested. Width is 32, batch 128, at most ten epochs, patience four. Learning rate is selected from 0.0003 and 0.001 on seed-17 validation MAE, then repeated with seeds 31 and 53. Selection is saved before testing; temperature uses calibration only. `progress.json`, `locked_selection.json`, `results.json`, `aggregate.json`, per-run logs and checkpoints retain provenance.

**CMOSE checkpoints cannot be passed to `trac.infer`**, which uses a different 512-D ResNet feature extractor. An I3D-trained head requires the exact compatible I3D preprocessing/extractor. Downloading precomputed features does not deliver the raw-video detection/tracking pipeline. Age/drift are zero and quality is a placeholder in this pilot, not measured sensor reliability.

Attribution: Chi-Hsuan Wu et al., *CMOSE: Comprehensive Multi-Modality Online Student Engagement Dataset with High-Quality Labels*, CVPR Workshops 2024, pp. 4636–4645. Derived feature datasets must retain source attribution and the applicable CC BY-SA 4.0 terms. Raw/processed data, model weights and run directories are gitignored; they have not been published.

### Completed results, not a production claim

Twelve training runs and nine selected-model test evaluations completed. All three configurations selected learning rate 0.001. Calibrated test macro-F1 averaged 24.76% (visual mean), 25.36% (multimodal mean), and 25.39% (multimodal latent). Their overall accuracies were 40.53%, 47.45%, and 41.80%, below the training-majority baseline's 62.13%. That baseline has only 19.16% macro-F1 and 25% balanced accuracy, illustrating why ordinary accuracy alone misleads. All learned models also had worse ordinal MAE than the constant baseline. Calibration increased expected-level MAE under this session shift.

See `cmose_pilot_results.json` for a compact tracked record and `runs/cmose-pilot-20261014/summary.json` for exact means/seed variation. These are negative/limited findings, not evidence that attention or agentic novelty works. Keep session 10 locked; future head/loss changes need development-only selection and a new independent evaluation protocol. The full scheduler, tracking, streaming and external-domain studies remain incomplete. No checkpoint is production-qualified.

## Data contract

`manifest.csv` columns: `path,participant,session,split,label,source,license`.
Splits are `train`, `val`, `calibration`, `test`. All appearances of a person and session must stay in one split, including overlapping windows. Labels are integers `0..K-1` in the dataset's native ordered scale. Do not combine unrelated scales by rescaling them.

Each `path` is relative to the manifest and points to an NPZ:

- `x0`, `x1`, ...: float `[time, feature_dimension]`, trailing windows only.
- `quality`, `age`, `available`, `drift`: one entry per branch. Age is seconds; quality is in `[0,1]`; drift is nonnegative.
- Use fixed sequence length per branch across examples for batching. Preprocessing/normalization must be fit on training people only. The current loader does not fit OpenFace/audio normalization for you.
- Missing branches use `available=0`. Missing data is not class zero. Identity validation must occur before constructing these windows; NPZ loading cannot infer whether two crops belong to the same person.

For a face-only baseline, supply a CSV with `video,participant,session,split,label,source,license` and explicitly annotated 10-second single-person clips:

```powershell
.\.venv\Scripts\python.exe -m trac.prepare --help
.\.venv\Scripts\python.exe -m trac.train --manifest data/manifest.csv --output runs/face-01 --dims 512 --classes 4
.\.venv\Scripts\python.exe -m trac.sweep --manifest data/manifest.csv --output runs/sweep-01 --dims 512 --classes 4
.\.venv\Scripts\python.exe -m trac.evaluate --manifest data/manifest.csv --checkpoint runs/face-01/best.pt --output runs/face-01/test.json --calibrate
```

Feature extraction downloads official torchvision ResNet18 weights on first use. It rejects ambiguous or absent faces rather than treating the full frame as a face. It does not parse DAiSEE or DIPSER annotation schemas automatically: an audited dataset-specific manifest is still required. Select the configuration using mean validation results across seeds, lock it, then evaluate test once. Do not repeatedly select using test metrics. Calibration uses only the separate calibration split and does not certify production readiness.

## Reproduce engineering checks

```powershell
.\.venv\Scripts\python.exe -m trac.smoke --output runs/new-synthetic-smoke
.\.venv\Scripts\python.exe -m trac.evaluate --manifest runs/new-synthetic-smoke/manifest.csv --checkpoint runs/new-synthetic-smoke/run/best.pt --output runs/new-synthetic-smoke/test.json --calibrate
```

These generated arrays test optimization, serialization and metric calculation. They are **not engagement data, not a benchmark, and not the paper's architectural ablation study**. The output checkpoint records `data_kind=synthetic` and cannot be used by the human-video inference command.

## Local research inference after real training

```powershell
.\.venv\Scripts\python.exe -m trac.infer --checkpoint runs/face-01/best.pt --source example.mp4 --output runs/video-01 --research-only
.\.venv\Scripts\python.exe -m trac.infer --checkpoint runs/face-01/best.pt --source camera:0 --output runs/camera-01 --research-only
```

Only use a consented subject/video. Stop live capture with Ctrl+C. No network listener is opened. The baseline writes `predictions.jsonl`, `annotated.avi` and limitations metadata locally. It is not the multi-person architecture in the figure. Missing/ambiguous faces reset history, 50 samples warm up the model, and loss of continuity resets the track generation. Haar + IoU cannot guarantee identity and is unsuitable for deployment. Encoded video uses constant FPS; JSONL carries source times. No production checkpoint is supplied.

## Required before a production claim

Real participant-disjoint training, licensed label audit, all proposed specialist integrations, learned coordinator training on out-of-fold evidence, stale-cache replay, multi-person tracking evaluation, calibration and risk–coverage analysis, three-seed matched-budget ablations, external-domain testing, measured latency/scale, privacy and consent review, and operational failure/recovery tests. Never interpret the index as a medical diagnosis, literal percentage of attention, or a basis for grading/discipline.
