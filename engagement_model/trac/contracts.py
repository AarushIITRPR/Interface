"""Pure runtime contracts: generation, cutoff, expiry, bounded compute."""
from dataclasses import dataclass
import math


@dataclass(frozen=True)
class Evidence:
    track: str
    generation: int
    start: float
    end: float
    received: float
    quality: float
    def valid(self, track, generation, cutoff, ttl):
        return (all(math.isfinite(v) for v in (self.start, self.end, self.received, self.quality, cutoff, ttl))
                and ttl >= 0 and self.track == track and self.generation == generation
                and self.start <= self.end <= self.received <= cutoff
                and cutoff-self.end <= ttl and 0 < self.quality <= 1)


def allocate(candidates, budget):
    """Greedy gain/cost baseline AFTER base service. Not a learned VOI policy.

    Each (track, expert) can occur once. Costs must be profiled milliseconds.
    Caller cancels requests on generation change. Exact knapsack is an ablation.
    """
    if not math.isfinite(budget) or budget < 0:
        raise ValueError("Invalid remaining budget")
    clean = [c for c in candidates if all(math.isfinite(c[k]) for k in ('gain','cost'))
             and c['cost'] > 0 and c['gain'] > 0]
    clean.sort(key=lambda c: (-c['gain']/c['cost'], str(c['track']), str(c['expert'])))
    chosen, seen = [], set()
    for c in clean:
        key = (c['track'], c['expert'])
        if key not in seen and c['cost'] <= budget:
            chosen.append(c); seen.add(key); budget -= c['cost']
    return chosen
