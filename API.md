# OpenPatches API Contract

The OpenPatches frontend communicates with the fmguessr inference server via REST API. All endpoints accept/return JSON unless noted. Errors are always `{"error": "message"}` with appropriate HTTP status codes.

Base URL is configurable. In development, the frontend uses `http://localhost:8080`. In production, same-origin.

---

## POST /api/probe

Fast audio analysis without running the full matching pipeline.

**Request:** `multipart/form-data` or raw `audio/wav` body (max 800 KB)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes (multipart) | WAV audio file |
| `note` | string | no | MIDI note hint ("C4" or "60") |
| `attack_ms` | float | no | Override attack time |
| `decay_ms` | float | no | Override decay time |
| `sustain_level` | float | no | Override sustain (0-1) |
| `release_ms` | float | no | Override release time |
| `gate_ms` | float | no | Override gate duration |
| `brightness` | float | no | Override brightness (0-1) |
| `harmonicity` | float | no | Override harmonicity (0-1) |

**Response (200):**
```json
{
  "attack_ms": 12.5,
  "decay_ms": 200.0,
  "sustain_level": 0.6,
  "release_ms": 300.0,
  "gate_ms": 500.0,
  "note_on_ms": 0.0,
  "note_off_ms": 500.0,
  "f0_hz": 261.63,
  "f0_confidence": 0.95,
  "midi_note": 60,
  "root_note": "C4",
  "brightness": 0.7,
  "harmonicity": 0.3,
  "spectral_centroid_hz": 1200.0,
  "f1_hz": 600.0,
  "f2_hz": 1200.0,
  "f3_hz": 2400.0,
  "seen_before": false,
  "best_match": {
    "name": "PIANO 1",
    "distance": 0.05,
    "algorithm": 5,
    "feedback": 3
  }
}
```

---

## POST /api/match

Submit a WAV file for full matching pipeline (GA + ML). Returns a job ID for async polling.

**Request:** `multipart/form-data` (max 800 KB)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes | WAV audio file |
| `note` | string | no | MIDI note hint |

**Response (202):**
```json
{
  "job_id": "job_1710000000_123456",
  "status": "queued",
  "queue_position": 1,
  "status_url": "/api/status/job_1710000000_123456"
}
```

**Errors:** 400 (bad input), 405 (wrong method), 413 (too large), 429 (queue full)

---

## GET /api/status/{jobID}

Poll job progress and retrieve results.

**Response (200):**
```json
{
  "job_id": "job_1710000000_123456",
  "status": "completed",
  "progress_percent": 100,
  "phase": "Done",
  "root_note": "C4",
  "midi_note": 60,
  "f0_hz": 261.63,
  "best_distance": 0.035,
  "syx_url": "/exports/job_xxx/bank.syx",
  "matches": [
    {
      "rank": 1,
      "algorithm": 5,
      "feedback": 3,
      "distance": 0.035,
      "wav_url": "/exports/job_xxx/match_1.wav",
      "voice_data": "base64..."
    }
  ],
  "timbral_matches": ["..."],
  "full_matches": ["..."],
  "formant_matches": ["..."],
  "favorites": ["..."]
}
```

Status values: `queued`, `processing`, `completed`, `failed`

**Errors:** 400 (missing ID), 404 (not found)

---

## POST /api/play

Render a DX7 patch to WAV for preview playback.

**Request:** `application/json`
```json
{
  "voice_data": "base64...",
  "note": 60,
  "duration_ms": 1000
}
```

Either `voice_data` (base64 128-byte patch) or `syx_url` + `slot` must be provided.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `voice_data` | string | one of these | Base64-encoded 128-byte DX7 patch |
| `syx_url` | string | or this | Path to .syx bank file |
| `slot` | int | with syx_url | Patch slot (0-31) in bank |
| `note` | int | yes | MIDI note (0-127) |
| `duration_ms` | int | no | Duration in ms (default: engine default) |

**Response (200):**
```json
{
  "wav_url": "/exports/play_1234567890/play.wav"
}
```

**Errors:** 400 (invalid JSON/bad params), 405 (wrong method)

---

## POST /api/morph

Morph one DX7 patch toward another, optimizing spectral distance.

**Request:** `application/json`
```json
{
  "source_data": "base64...",
  "target_data": "base64...",
  "note": 60,
  "ratio": 0.5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source_data` | string | yes | Base64-encoded 128-byte source patch |
| `target_data` | string | yes | Base64-encoded 128-byte target patch |
| `note` | int | no | MIDI note (default: 60) |
| `ratio` | float | no | Target distance ratio -1.0 to 1.0 (default: 0.5) |

**Response (200):**
```json
{
  "voice_data": "base64...",
  "syx_url": "/exports/morph_xxx/morphed.syx",
  "wav_url": "/exports/morph_xxx/morphed.wav",
  "source_dist": 0.05,
  "morph_dist": 0.03,
  "ratio": 0.5,
  "alpha": 0.6,
  "iterations": 42
}
```

**Errors:** 400 (invalid JSON/missing fields/bad base64/wrong size), 405

---

## POST /api/voice

Extract raw voice data from a .syx bank file.

**Request:** `application/json`
```json
{
  "syx_url": "/exports/job_xxx/bank.syx",
  "slot": 0
}
```

**Response (200):**
```json
{
  "algorithm": 5,
  "feedback": 3,
  "voice_data": [128 byte values...]
}
```

**Errors:** 400 (invalid JSON/bad slot), 404 (file not found), 405

---

## POST /api/export-syx

Export selected patches as a downloadable .syx bank file.

**Request:** `application/json`
```json
{
  "name": "My Bank",
  "patches": [
    {
      "voice_data": "base64...",
      "name": "PIANO 1"
    },
    {
      "syx_url": "/exports/job_xxx/bank.syx",
      "slot": 3,
      "name": "BASS 1"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | Export filename (without .syx) |
| `patches` | array | yes | 1-32 patches |
| `patches[].voice_data` | string | one of these | Base64 128-byte patch |
| `patches[].syx_url` | string | or this | Source .syx path |
| `patches[].slot` | int | with syx_url | Slot in source bank |
| `patches[].name` | string | no | Patch name (10 chars max) |

**Response (200):**
```json
{
  "syx_url": "/exports/export_xxx/patches.syx",
  "count": 5
}
```

**Errors:** 400 (invalid JSON/bad patches), 405

---

## GET /api/health

Server health check.

**Response (200):**
```json
{
  "status": "ok",
  "queue_length": 0,
  "max_queue": 5,
  "model_loaded": true,
  "codebook_loaded": true
}
```

---

## Static File Routes

| Route | Description |
|-------|-------------|
| `GET /` | Serves `index.html` |
| `GET /html/*` | Serves static frontend files |
| `GET /exports/*` | Serves generated files (WAV, SYX) |

---

## Error Format

All errors return JSON with an `error` field:

```json
{"error": "human-readable error message"}
```

HTTP status codes: 400 (bad request), 404 (not found), 405 (method not allowed), 413 (payload too large), 429 (rate limited), 500 (server error).
