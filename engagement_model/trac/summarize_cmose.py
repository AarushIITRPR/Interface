"""Summarize completed locked-test runs and a training-selected majority baseline."""
import argparse
import csv
import json
from pathlib import Path
import numpy as np
from .train import metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    parser.add_argument('--run', required=True)
    args = parser.parse_args()
    root = Path(args.run)
    aggregate = json.loads((root / 'aggregate.json').read_text())
    results = json.loads((root / 'results.json').read_text())['results']
    for row in aggregate:
        group = [r for r in results if r['name'] == row['configuration']]
        row['uncalibrated_ordinal_mae'] = {
            'mean': float(np.mean([r['uncalibrated_test']['ordinal_mae'] for r in group])),
            'seed_sd': float(np.std([r['uncalibrated_test']['ordinal_mae'] for r in group], ddof=1))}
    audit = json.loads((Path(args.data) / 'audit.json').read_text())
    counts = audit['split_counts']
    majority = int(max(counts['train'], key=lambda k: counts['train'][k]))
    y = np.concatenate([np.full(n, int(k)) for k, n in counts['test'].items()])
    p = np.zeros((len(y), 4)); p[:, majority] = 1
    baseline = metrics(p, y)
    # Hard one-hot baseline is not a useful probability model: omit NLL/Brier.
    baseline = {k: baseline[k] for k in ['n', 'accuracy', 'macro_f1', 'balanced_accuracy', 'ordinal_mae']}
    report = dict(baseline_class=majority, majority_baseline=baseline, models=aggregate,
        uncertainty='Seed SD, not a confidence interval; one held-out test session',
        scope='Whole-clip precomputed features; no streaming/tracking/agentic validation')
    (root / 'summary.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    with (root / 'summary.csv').open('w', newline='', encoding='utf8') as f:
        keys = ['accuracy', 'macro_f1', 'balanced_accuracy', 'ordinal_mae']
        writer = csv.writer(f)
        writer.writerow(['configuration'] + [suffix for k in keys for suffix in [k + '_mean', k + '_seed_sd']])
        writer.writerow(['majority'] + [v for k in keys for v in [baseline[k], 0]])
        for row in aggregate:
            writer.writerow([row['configuration']] + [v for k in keys for v in [row[k]['mean'], row[k]['seed_sd']]])
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
