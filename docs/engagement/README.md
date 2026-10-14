# TRAC-Engage research documents

Research snapshot: 14 October 2026. This is an architecture proposal and a bounded public-data feature pilot, not a production-qualified engagement detector. It is independent of the Smart India Hackathon material.

- [Research paper](meridian_engagement_research.pdf): literature, proposed architecture, candidate novelty, completed CMOSE experiments and limitations.
- [Mathematical foundation notes](trac_engage_foundations.pdf): component-by-component explanation starting from CNNs, RNNs and attention.
- [A4 landscape architecture](trac-engage-architecture-a4.pdf): proposed full system, not a claim that every branch is implemented.
- [Code and reproducible commands](../../engagement_model/README.md).
- [Recorded pilot results](../../engagement_model/cmose_pilot_results.json).

The paper explicitly reports weak held-out-session performance and calibration transfer. Twelve training runs and nine selected-model evaluations were completed on public CMOSE features. The learned scheduler, stale-cache replay, multi-person pipeline and live-video validation remain incomplete. No deployment was performed.

## Rebuild

All figure references in these repository copies are relative. From this directory, with Tectonic installed:

```text
tectonic trac-engage-architecture-a4.tex
tectonic meridian_engagement_research.tex
tectonic trac_engage_foundations.tex
```

The diagram PNG and generated PDFs are included. The image prompt file records the initial brief and iteration provenance. These are engagement research documents, not SIH submissions.

Dataset files, derived per-example features, checkpoints, virtual environments and run directories are excluded from version control. Download instructions and source attribution are in the model README. CMOSE data are released by their authors under CC BY-SA 4.0; those terms continue to apply to the data and relevant adaptations.
