# ChonkVid — Oh Lawd He Comin'

**Flatten the curve of prompt injection.**

Le Chonk London (Mistral Vibe Hackathon, 21 Nov 2026). ChonkVid releases a harmless
self-spreading prompt into a population of Ministral agents and measures how fast it
spreads through *your* system prompt, then verifies a vaccine patch written by a Le
Chonk WHO agent with the same measurement.

## Quick start

All application code, measured results, and run instructions live in **`chonkvid/`**:

```bash
cd chonkvid
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
cp .env.example .env   # optional MISTRAL_API_KEY for live mode; omit for MOCK rehearsal
.venv/bin/python -m chonkvid serve
```

Open **http://127.0.0.1:8000** for the epidemic dashboard and **/world** for the fleet
outbreak map.

## Which prize each part is for

Written for a judge skimming the repo with five minutes. The tracks are the ones on the
kick-off page: Track_01 anything goes, Bonus_02 Mistral Agents or Workflows, Special_03
best use of Voxtral.

| Track | What in here earns it | Where to look |
|---|---|---|
| Track_01, around Vibe and Le Chonk | The whole mechanism is Le Chonk (Mistral Large 4) plus Ministral: Ministral 8B is every agent in the population, `mistral-embed` decides whether a message carried the payload, and Le Chonk writes the vaccine. Shipped as a **Vibe skill** and a **stdio MCP server**, with `.vibe/config.toml` pinning the model. | `chonkvid/.agents/skills/chonkvid/SKILL.md`, `chonkvid/chonkvid/mcp_server.py`, `chonkvid/chonkvid/who.py`, `chonkvid/chonkvid/detect.py` |
| Bonus_02, Mistral Agents | The WHO is a **Mistral Managed Agent** (`mistralai-agents`), one session per outbreak, four tools it calls against the live simulation, JSON-schema sitreps, full outbreak log in one request, and a rendered curve image it reasons over. It then writes the vaccine prompt. | `chonkvid/chonkvid/who_session.py`, `chonkvid/chonkvid/who_agent.py`, `chonkvid/chonkvid/curve.py` |
| Special_03, Voxtral | Voice is a **measured channel**, not decoration: Voxtral TTS speaks each message, Voxtral transcription is what the next agent hears, and the same detector scores the reply (20/20 carried through speech, 0/20 after the vaccine; the marker came back intact 18/20, and context biasing takes it to 10/10 in the later run). On the map, every contact link is a Voxtral conversation you can hear, positional and soloable. | `chonkvid/chonkvid/voice.py`, `chonkvid/chonkvid/soundscape.py`, `chonkvid/web/world/sound.js` |

**One sentence for the jury.** We measure how fast a self-spreading prompt crosses a fleet
of Ministral agents on *your* system prompt, then have a Le Chonk Managed Agent write the
countermeasure and we re-measure it, over text and over speech.

### What the evidence is

- `chonkvid/README.md` → Results: every number is a live run from 21 Nov, with the arm,
  the count, the Wilson CI, and the command that produced it.
- `chonkvid/web/measured-run.json` → the dashboard's snapshot of one live outbreak
  (40 agents, Ministral 8B), so the UI shows a real run rather than a mock.
- `demo/chonkvid-demo.mp4` → the recorded demo.
- `chonkvid/tests/` → 125 tests, including the detector's false-positive control and the
  "mentions the chain letter" case that must *not* count as infection.

### What was deliberately not built

Lineage tracing (clean echoes at 0.72–0.84 cosine overlapped real carriers), quarantine,
output masks, lockdown and boosters, and the calibrated 50k-agent city simulation. The
first is a measurement problem we could not separate honestly; the rest are more of the
same intervention the results already cover, and the finding is that the dose is too small
at any of them: coverage is the ceiling. Say that on stage rather than hide it.

## What's in this repo

| Path | Purpose |
|---|---|
| [chonkvid/](chonkvid/) | Python package, dashboard, world map, MCP/Vibe skill, Cloudflare worker |
| [demo/](demo/) | Recorded demo video (`chonkvid-demo.mp4`) |
| [supabase/](supabase/) | Shared DB migrations for recordings and reports |
| [docs/SUPABASE_BACKEND.md](docs/SUPABASE_BACKEND.md) | Backend wiring notes |

## Provenance

The runnable scaffold was prepared the night before the event and disclosed at
check-in. Measured numbers in `chonkvid/README.md` are from **live** runs on 21 Nov
2026 (Ministral 8B population, Le Chonk WHO via Mistral Managed Agents).

## Team

Built at Fora — Chancery House, London. Mistral Vibe was the build tool; stack is
Ministral, mistral-embed, Mistral Managed Agents (Le Chonk), and optional Voxtral for
voice-hop trials.