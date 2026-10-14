"""Download only the two public CMOSE feature files and verify published hashes."""
import argparse
import hashlib
from pathlib import Path
from urllib.request import Request, urlopen
from .cmose import HASHES


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', default='data/cmose')
    args = p.parse_args()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    for name, expected in HASHES.items():
        target = root / name
        if target.exists():
            if digest(target) != expected:
                raise ValueError(f'Existing {name} has a different hash; preserved without overwrite')
            print(f'Already verified: {name}', flush=True)
            continue
        partial = root / (name + '.part')
        if partial.exists():
            raise ValueError(f'Partial file already exists: {partial}; inspect before retrying')
        url = 'https://huggingface.co/datasets/cwuau/CMOSE/resolve/main/' + name
        request = Request(url, headers={'User-Agent': 'TRAC-Engage-research/1.0'})
        with urlopen(request, timeout=120) as response, partial.open('xb') as out:
            while block := response.read(1024 * 1024):
                out.write(block)
        if digest(partial) != expected:
            raise ValueError(f'Hash mismatch: {partial}; file retained for inspection')
        partial.rename(target)
        print(f'Downloaded and verified: {name}', flush=True)


if __name__ == '__main__':
    main()
