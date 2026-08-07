# Wan 2.2 Motion Control — Workflow "Motion Control - nightfunnels.com"

## Sumber & Status
- **Workflow ID (draft, belum dipublish)**: `2084989060276809730`
- **Sumber**: @automationby7bot (7Bots Automation) — workflow publik di marketplace RunningHub
- **Status API**: `810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING` (draft) → **harus dipublish** di dashboard sebelum API bisa baca
- **Dapatkan JSON**: `POST {root}/api/openapi/getJsonApiFormat {apiKey, workflowId}` setelah publish

## Ringkasan Perbandingan: WanAnimate (kita) vs Wan 2.2 Motion Control (7bots)

| Parameter | WanAnimate lama (`1998198427450269697`) | Wan 2.2 Motion Control (draft) |
|---|---|---|
| Model | `lightx2v_I2V_14B_480p` (distill) | `Wan2_2-Animate-14B_fp8_scaled` |
| Resolusi video | 576×1024 (480p) | **960×1280** (720×16:9 → long edge 960) |
| Steps / CFG | 6 / 1 (fixed optimal) | **3** |
| Sampler | euler | **dpm++_sde** (riflex) |
| FPS | 24 (force_rate) | **35** (force_rate) |
| Durasi | frame_load_cap=243 → ~10 dtk | 15×24=361 frame → **15 dtk** |
| Audio | — | ya (bawa audio video ref) |
| Pose/Face | — | PoseAndFaceDetection + DrawViTPose |
| LoRA | WanAnimate relight | 5× LoRA (relight+lightning+pusa+fun-inpaint) |
| VRAM hack | — | block_swap 30 layer |
| Hasil | hitam/lepas 10 dtk | 7bots: "cepat, bagus, 30 dtk, konsisten" |

## Node Mapping (yang dioverride oleh bot via nodeInfoList)

```
LOAD:
  - 391  LoadImage        → .image = <fileName>          (gambar referensi)
  - 392  VHS_LoadVideo    → .video = <fileName>          (video referensi)

OVERRIDE DURASI/FPS (Int nodes — nilai default):
  - 341  Int              → value = 15                   (DURAÇÃO DO VÍDEO, detik)
  - 349  Int              → value = 35                   (FRAME RATE FPS)

SAMPLER & MODEL (baca-saja / tidak override):
  - 335  WanVideoSampler  → steps=3, cfg=1, shift=5, scheduler=dpm++_sde, seed
  - 355  Int              → width = ref 379[3] (960)     ⚠️ nilainya dinamis via ref node
  - 325  Int              → height = ref 379[4] (1280)
  - 374  Int              → value = 960                  (TAMANHO MAIOR)
  - 375  CM_IntToFloat    → a = ref 349                  (frame_rate convert)

PROMPT (Portugis, built-in — tidak perlu dioverride kecuali mau ganti):
  - 336  WanVideoTextEncodeCached
    positive_prompt:   "Manter expressões faciais e posição da cabeça consistentes, aprimorar realismo."
    negative_prompt:   (panjang, anti-artifact — semua dalam file)

OUTPUT (baca-saja):
  - 326  VHS_VideoCombine → images=ref 337, audio=ref 392 (bawa audio!)
```

## NodeMapping profile (langsung pasang di src/runninghub/workflow.ts)

```ts
wan22: {
  image:        { nodeId: '391', fieldName: 'image' },
  video:        { nodeId: '392', fieldName: 'video' },
  prompt:       { nodeId: '336', fieldName: 'positive_prompt' },   // prompt pengganti (opsional, default Portugis good)
  videoDuration: { nodeId: '341', fieldName: 'value' },            // durasi detik (Int node)
  fps:          { nodeId: '349', fieldName: 'value' },            // fps (Int node)
  seeds: [] as string[],  // Wan 2.2 pakai 1 KSampler; seed di node '335'
  seed: { nodeId: '335', fieldName: 'seed' },
},
```

> ⚠️ Bedakan `seeds[]` (array, untuk WanAnimate 3 KSampler) vs `seed` (single, untuk Wan 2.2 1 sampler).

## Cara deploy bot ke Wan 2.2 Motion Control

1. **Login di dashboard RunningHub** → buka editor workflow → pilih draft "Motion Control - nightfunnels.com" → klik **Publish** → copy workflow ID baru (biasanya ID sama `2084989060276809730` jadi valid)
2. Set `.env`:
   ```
   RUNNINGHUB_WORKFLOW_ID=2084989060276809730
   RUNNINGHUB_MAPPING=wan22
   ```
3. Bot otomatis pakai profil `wan22` → durasi ikut video referensi (cap 30 dtk) + `/durasi <detik>` override
4. Pilih `instanceType: plus` (48G, 4050ti/RTX A6000) — Wan 2.2 14B fp8 butuh VRAM ekstra

## Catatan biaya
- Wan 2.2 14B fp8 di instance Plus ≈ **0.4 coin/dtk** × 15 dtk = **6 coin/video** (~2× lebih mahal dari WanAnimate Lite)
- Tapi hasil 720p full+audio vs 480p distill + OOM risk, ratio value jauh lebih baik
- Pakai `/apikey` per-user biar biaya keluar dari dompet masing-masing (fitur sudah ada)
