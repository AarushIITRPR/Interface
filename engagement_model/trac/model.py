"""Causal temporal experts, reliability-masked fusion and ordered thresholds.

Input features must have been extracted from trailing, identity-linked windows.
This module does not implement RT-DETR, ByteTrack or a trained VOI policy.
"""
from dataclasses import asdict, dataclass
import torch
from torch import nn
from torch.nn import functional as F


@dataclass
class Config:
    input_dims: tuple = (512, 768, 35)
    width: int = 128
    queries: int = 4
    heads: int = 4
    blocks: int = 2
    classes: int = 4
    dropout: float = 0.1
    expiry: float = 10.0
    age_decay: float = 4.0
    drift_penalty: float = 1.0
    fusion: str = "latent"
    def to_dict(self):
        return asdict(self)


class CausalBlock(nn.Module):
    def __init__(self, width, dilation, dropout):
        super().__init__()
        self.pad = 2 * dilation
        self.conv = nn.Conv1d(width, width, 3, dilation=dilation)
        # LayerNorm over channels, never temporal BatchNorm (future leakage).
        self.norm = nn.LayerNorm(width)
        self.drop = nn.Dropout(dropout)
    def forward(self, x):
        h = self.conv(F.pad(x.transpose(1, 2), (self.pad, 0)))
        return x + self.drop(F.gelu(self.norm(h.transpose(1, 2))))


class TemporalExpert(nn.Module):
    def __init__(self, dim, width, dropout):
        super().__init__()
        self.project = nn.Linear(dim, width)
        self.blocks = nn.Sequential(*[CausalBlock(width, d, dropout) for d in (1, 2, 4)])
    def sequence(self, x):
        return self.blocks(self.project(x))
    def forward(self, x):
        # Two taps in addition to current sample per block: 15-sample RF.
        # Pool ALL observed outputs to represent the entire supplied history.
        return self.sequence(x).mean(1)


class OrdinalHead(nn.Module):
    def __init__(self, width, classes):
        super().__init__()
        self.location = nn.Linear(width, 1)
        self.first = nn.Parameter(torch.tensor(-1.0))
        self.gaps = nn.Parameter(torch.zeros(classes - 2))
    def forward(self, x):
        cuts = torch.cat([self.first[None], self.first + F.softplus(self.gaps).cumsum(0)])
        return self.location(x) - cuts
    @staticmethod
    def probabilities(logits):
        o = logits.sigmoid()
        return torch.cat([1-o[:, :1], o[:, :-1]-o[:, 1:], o[:, -1:]], 1)


class FusionBlock(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.attn = nn.MultiheadAttention(c.width, c.heads, dropout=c.dropout, batch_first=True)
        self.n1, self.n2 = nn.LayerNorm(c.width), nn.LayerNorm(c.width)
        self.ff = nn.Sequential(nn.Linear(c.width, 4*c.width), nn.GELU(),
                                nn.Dropout(c.dropout), nn.Linear(4*c.width, c.width))
        self.heads = c.heads
    def forward(self, q, kv, bias):
        mask = bias[:, None, :].expand(-1, q.shape[1], -1).repeat_interleave(self.heads, 0)
        h, _ = self.attn(q, kv, kv, attn_mask=mask, need_weights=False)
        q = self.n1(q + h)
        return self.n2(q + self.ff(q))


class TracModel(nn.Module):
    def __init__(self, c=Config()):
        super().__init__()
        self.config = c
        self.experts = nn.ModuleList(TemporalExpert(d, c.width, c.dropout) for d in c.input_dims)
        self.modality = nn.Parameter(torch.randn(len(c.input_dims), c.width)*0.02)
        self.queries = nn.Parameter(torch.randn(c.queries, c.width)*0.02)
        self.blocks = nn.ModuleList(FusionBlock(c) for _ in range(c.blocks))
        self.head = OrdinalHead(c.width, c.classes)
    def forward(self, features, quality, age, available, drift=None):
        c = self.config
        if len(features) != len(self.experts):
            raise ValueError("Feature branch count does not match checkpoint")
        if drift is None:
            drift = torch.zeros_like(age)
        valid = (available.bool() & torch.isfinite(quality) & torch.isfinite(age)
                 & torch.isfinite(drift) & (quality > 0) & (age >= 0)
                 & (age <= c.expiry) & (drift >= 0))
        tokens = []
        for i, (expert, x) in enumerate(zip(self.experts, features)):
            finite = torch.isfinite(x).all(dim=(1, 2))
            valid[:, i] &= finite
            tokens.append(expert(torch.nan_to_num(x, nan=0., posinf=0., neginf=0.)))
        h = torch.stack(tokens, 1) + self.modality
        reliability = (torch.nan_to_num(quality).clamp(0, 1) *
                       torch.exp(-torch.nan_to_num(age).clamp_min(0)/c.age_decay -
                                 c.drift_penalty*torch.nan_to_num(drift).clamp_min(0)))
        reliability = reliability.masked_fill(~valid, 0)
        usable = valid.any(1)
        # A neutral sentinel makes all-missing attention finite. Its prediction
        # is never exposed: caller must use usable to return null, not zero.
        h = torch.cat([h, h.new_zeros(h.shape[0], 1, c.width)], 1)
        r = torch.cat([reliability, (~usable).float()[:, None]], 1)
        if c.fusion == "mean":
            z = (h*r[:, :, None]).sum(1)/r.sum(1, keepdim=True).clamp_min(1e-8)
        else:
            bias = r.clamp_min(1e-8).log().masked_fill(r <= 0, -torch.inf)
            q = self.queries[None].expand(h.shape[0], -1, -1)
            for block in self.blocks:
                q = block(q, h, bias)
            z = q.mean(1)
        logits = self.head(z)
        p = self.head.probabilities(logits)
        return {"logits": logits, "probabilities": p, "usable": usable,
                "score": logits.sigmoid().sum(1)*100/(c.classes-1),
                "reliability": reliability}


def ordinal_loss(logits, labels):
    targets = (labels[:, None] > torch.arange(logits.shape[1], device=logits.device)).float()
    return F.binary_cross_entropy_with_logits(logits, targets)
