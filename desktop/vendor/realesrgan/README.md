# Bundled AI super-resolution runtime

Localis ships the official `realesrgan-ncnn-vulkan` Windows runtime from
Real-ESRGAN v0.2.5.0 and a converted `realesr-general-x4v3` model. The two
official strong/weak-denoise weights are blended at 0.5 during release
engineering, then converted to NCNN. Python, PyTorch, ONNX and conversion
tools are not included in the Windows application.

Upstream release:
https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0

Runtime archive SHA-256:
`ABC02804E17982A3BE33675E4D471E91EA374E65B70167ABC09E31ACB412802D`

Bundled file SHA-256 values:

- `realesrgan-ncnn-vulkan.exe`: `07E49F7CBB4EDE01AE4DD4C399D3A7E5846E3D2085C3128EFF881E55CB7B1A0C`
- `vcomp140.dll`: `8F72EF2E483465444B2059FC6744D6CB22CD8D8A27F6FA56BEFD2A42DCD0F78B`
- `models/localis-general-x4.param`: `DA05A967EB4BED3E678F83C172C79804E14BB9BA0140F642CC61129ABF0CBE8A`
- `models/localis-general-x4.bin`: `F588BAB5E5EC5584FAC548F8B0BEC3BC1A166637D84E1DED5B0660080D4EFE76`

See the adjacent MIT and BSD-3-Clause license files. NVIDIA/AMD/Intel display
drivers remain operating-system prerequisites; no CUDA or Vulkan SDK is
required.
