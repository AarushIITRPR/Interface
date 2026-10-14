"""Manifest-validated, participant-disjoint feature-window training data."""
import csv
from pathlib import Path
import numpy as np
import torch
from torch.utils.data import Dataset


def read_manifest(path, classes):
    path = Path(path).resolve()
    with path.open(newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError('Empty manifest')
    participants, sessions, files = {}, {}, set()
    for r in rows:
        required = ['path','participant','session','split','label','source','license']
        if any(not r.get(k, '').strip() for k in required):
            raise ValueError('Missing manifest identity, provenance, license or label')
        if r['split'] not in {'train','val','calibration','test'}:
            raise ValueError('Unknown split')
        for mapping, key in ((participants,r['participant']), (sessions,r['session'])):
            if key in mapping and mapping[key] != r['split']:
                raise ValueError('Participant or session leakage across splits')
            mapping[key] = r['split']
        r['label'] = int(r['label'])
        if not 0 <= r['label'] < classes:
            raise ValueError('Label outside dataset-native scale')
        file = (path.parent/r['path']).resolve()
        if file in files:
            raise ValueError('Duplicate feature file')
        if not file.is_file():
            raise ValueError(f'Missing features: {file}')
        files.add(file); r['path'] = str(file)
    return rows


class Windows(Dataset):
    def __init__(self, rows, config):
        self.rows, self.config = rows, config
    def __len__(self):
        return len(self.rows)
    def __getitem__(self, i):
        row = self.rows[i]
        with np.load(row['path'], allow_pickle=False) as z:
            xs = [torch.tensor(z[f'x{j}'], dtype=torch.float32) for j in range(len(self.config.input_dims))]
            for x, dim in zip(xs, self.config.input_dims):
                if x.ndim != 2 or x.shape[1] != dim or x.shape[0] < 1:
                    raise ValueError('Expected each branch as [time, feature_dimension]')
            meta = [torch.tensor(z[k], dtype=torch.float32) for k in ('quality','age','available','drift')]
            if any(x.shape != (len(xs),) for x in meta):
                raise ValueError('Metadata must have one entry per expert')
        return xs, *meta, torch.tensor(row['label']), row['participant']
