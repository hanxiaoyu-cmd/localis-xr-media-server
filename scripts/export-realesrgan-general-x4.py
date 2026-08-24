"""Export the lightweight general-video Real-ESRGAN model for NCNN.

The strong and weak-denoise checkpoints are blended once during release
engineering. Localis users receive only the converted NCNN model and do not
need Python, PyTorch or CUDA.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


class SRVGGNetCompact(nn.Module):
    def __init__(self, upscale: int = 4) -> None:
        super().__init__()
        num_feat = 64
        self.upscale = upscale
        self.body = nn.ModuleList([nn.Conv2d(3, num_feat, 3, 1, 1), nn.PReLU(num_feat)])
        for _ in range(32):
            self.body.extend([nn.Conv2d(num_feat, num_feat, 3, 1, 1), nn.PReLU(num_feat)])
        self.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        enhanced = value
        for layer in self.body:
            enhanced = layer(enhanced)
        return self.upsampler(enhanced) + F.interpolate(
            value, scale_factor=self.upscale, mode="nearest"
        )


def state_dict(path: Path) -> dict[str, torch.Tensor]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    return checkpoint.get("params_ema", checkpoint.get("params", checkpoint))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("strong_checkpoint", type=Path)
    parser.add_argument("weak_checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--denoise-strength", type=float, default=0.5)
    arguments = parser.parse_args()

    strength = min(1.0, max(0.0, arguments.denoise_strength))
    strong = state_dict(arguments.strong_checkpoint)
    weak = state_dict(arguments.weak_checkpoint)
    blended = {
        key: strong[key] * strength + weak[key] * (1.0 - strength)
        for key in strong
    }
    model = SRVGGNetCompact().eval()
    model.load_state_dict(blended)
    sample = torch.rand(1, 3, 64, 64)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        sample,
        arguments.output,
        input_names=["data"],
        output_names=["output"],
        dynamic_axes={"data": {2: "height", 3: "width"}, "output": {2: "height_x4", 3: "width_x4"}},
        opset_version=11,
        dynamo=False,
    )


if __name__ == "__main__":
    main()
