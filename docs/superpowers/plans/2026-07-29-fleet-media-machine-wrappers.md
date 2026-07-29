# Fleet Media Machine Wrappers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing PixelLab, Gemini/Imagen, Google audio, Codex image, and MiniMax media surfaces the fixed stdin/NDJSON machine protocol required by MeshFleet, without moving credentials or making a provider call during implementation.

**Architecture:** A dependency-free Python protocol module validates one closed `meshfleet.media-adapter-request.v1` document and emits bounded `meshfleet.media-adapter-event.v1` lines. Existing wrappers gain an additive `--meshfleet-machine` entry that calls their current in-process provider functions with creative input held in memory and writes only fixed relative artifacts in the invocation-owned working directory. Codex uses a unique invocation-owned generation root and prompt stdin. MiniMax extends the existing canonical `Tools/mmx-media` lane directly; the obsolete `Tools/minimax_media_pipeline.py` status shim and its unconnected hypothetical MCP server remain out of scope.

**Tech Stack:** Python 3 stdlib, existing Pillow where already used, Bash for the Codex wrapper, `unittest`/shell fixtures, fake HTTP and fake subprocesses.

## Global Constraints

- This plan executes in a fresh isolated worktree of the portfolio repository rooted at `/Users/johnwhitman/AI`; the primary checkout is dirty and must remain untouched.
- The primary checkout currently has overlapping uncommitted `Tools/pxl` bytes. Before Task 2, identify their owner/base and reconcile through a committed source branch or an explicit handoff; never copy the dirty file into the execution worktree or overwrite it.
- Start only after MeshFleet Tasks 1–7 commit the exact adapter request/event fixtures.
- No task contacts PixelLab, Google, OpenAI/Codex image generation, MiniMax, or another media provider.
- Preserve every current human CLI invocation and output unless a focused regression test explicitly records an existing bug.
- `--meshfleet-machine` reads one bounded JSON document from stdin. Prompts, lyrics, TTS text, instructions, and reference bytes never appear in argv or environment.
- The machine request cannot select an executable, shell, cwd, environment, credential path, provider token, output root, registered consumer root, callback, or URL.
- The wrapper writes only fixed generated names beneath its already-confined current working directory and reports relative paths.
- Credentials remain resolved by each existing wrapper through its current owner. Tests use fake credential resolvers and sentinel values; they never read `.env.local`, Keychain, Codex auth, or gcloud auth.
- Machine stdout contains protocol events only. Human diagnostics go to bounded stderr and must not include creative inputs or secrets.
- Provider/network readiness probes and executions remain separately authorized after this code lands.

## Baseline

From the isolated portfolio worktree:

```bash
git status --short --branch
python3 -m unittest discover -s Tools/tests -p 'test_*.py'
bash Tools/tests/test_wrapper_usage_ledger.sh
python3 Tools/pxl --help
python3 Tools/pixellab.py --help
python3 Tools/gemini_image.py --help
python3 Tools/gemini_audio.py --help
bash Tools/cdx-image 2>&1 | head -5
```

Record pre-existing failures. The last command is a usage-only check and must not start Codex.

---

### Task 1: Shared closed adapter protocol

**Files:**
- Create: `Tools/lib/media_adapter_protocol.py`
- Create: `Tools/tests/test_media_adapter_protocol.py`

**Interfaces:**
- Consumes: committed MeshFleet adapter request/event fixtures.
- Produces: `AdapterRequestV1`, `AdapterProtocolError`, `read_request()`, `emit_event()`, `InvocationRoot`, `guard_relative_artifact()`.

- [ ] **Step 1: Write failing protocol tests**

Cover size limit, invalid UTF-8, duplicate JSON keys, unknown/missing fields at every layer, twelve closed operations, option-shaped IDs, path separators, raw output paths, raw credentials, wrong version, multiple documents, relative artifact confinement, symlinks, non-regular files, and bounded NDJSON events:

```python
def test_creative_input_is_read_from_stdin_only(self):
    request = read_request(io.BytesIO(valid_request(prompt="private prompt")))
    self.assertEqual(request.input["prompt"], "private prompt")
    self.assertNotIn("private prompt", " ".join(sys.argv))
```

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_media_adapter_protocol
```

- [ ] **Step 3: Implement exact parser and emitter**

The root contract accepts only version, execution ID, attempt ID, operation, input, output constraints, and fixed route facts. It never accepts a destination. `InvocationRoot` opens the current working directory once, requires it to be a non-symlink directory, generates fixed names, and validates each opened result before emitting:

```json
{"version":"meshfleet.media-adapter-event.v1","type":"artifact","relative_path":"output-1.png"}
```

- [ ] **Step 4: Run focused tests**

```bash
python3 -m unittest Tools.tests.test_media_adapter_protocol
```

- [ ] **Step 5: Commit**

```bash
git add Tools/lib/media_adapter_protocol.py Tools/tests/test_media_adapter_protocol.py
git commit -m "feat(tools): add closed media adapter protocol"
```

### Task 2: PixelLab machine mode (GUARDED)

**Decision Gate (MANDATORY before Step 1):** Identify dirty-byte owner/base via `OPERATOR-LOCK.md`, worktree list, and `git log --oneline -5 Tools/pxl`. At the 2026-07-29 preflight, the primary dirty bytes were byte-identical to committed `codex/pixellab-fetch-state-closeout-20260727@d045b91`; re-verify that identity immediately before execution, then reconcile by cherry-picking the committed source into the isolated portfolio worktree. Proceed with Task 2 only from committed/reconciled bytes. If the identity changed or ownership is ambiguous, defer PixelLab (record decision and hashes in handoff/lock) without blocking Gemini, audio, Codex, or MiniMax. Never copy dirty bytes.

**Files:**
- Modify: `Tools/pxl`
- Create: `Tools/tests/test_pxl_machine.py`

**Interfaces:**
- Consumes: `pixel.image`, `pixel.character`, `pixel.rotate8`, `pixel.tileset`, `pixel.state`, and `pixel.animation`.
- Produces: accepted, provider-task-ID, progress, usage, artifact/bundle, review-candidate, and terminal events with fixed endpoint/model evidence.

- [ ] **Step 0: Execute dirty-byte gate and record decision**
- [ ] **Step 1: Write failing offline tests** (only if gate passed)

Patch `urllib.request.urlopen`, binary downloads, polling time, and credential resolution. Prove stdin-only prompt, fixed endpoint allowlist, operation-specific size validation, reference confinement and license declaration, raw RGBA/PNG handling, task-ID detach/resume, multi-job animation settlement, usage generations, artifact/bundle hashes, candidate selection without regeneration, no secret output, and no network when validation fails.

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_pxl_machine
```

- [ ] **Step 3: Refactor without changing the human CLI**

Extract request construction, polling, response decoding, and artifact writes from `main()`. Add `--meshfleet-machine` as a mutually exclusive entry. Machine mode maps the six closed pixel operations to the existing image/char/rotate8/tileset/fetch-state/anim implementations, writes fixed relative artifact or bundle names, emits provider task IDs before polling, emits measured generation usage, and marks candidate/selection-capable operations `needs_review`. It must accept a prior provider task ID for status/collect without regenerating. Keep every existing `pxl` human subcommand green. Leave the older `Tools/pixellab.py` compatibility wrapper unchanged.

- [ ] **Step 4: Run focused and human-CLI regressions**

```bash
python3 -m unittest Tools.tests.test_pxl_machine
python3 Tools/pxl --help
```

- [ ] **Step 5: Commit**

```bash
git add Tools/pxl Tools/tests/test_pxl_machine.py
git commit -m "feat(tools): add PixelLab machine protocol"
```

### Task 3: Gemini and Imagen image machine mode

**Files:**
- Modify: `Tools/gemini_image.py`
- Create: `Tools/tests/test_gemini_image_machine.py`

**Interfaces:**
- Consumes: `image.generate` and `image.edit`.
- Produces: model/backend evidence, one admitted image artifact event, usage truth when supplied, and terminal state.

- [ ] **Step 1: Write failing fake-HTTP tests**

Cover AI Studio and Vertex routing, exact model pin, Imagen reference rejection, Gemini edit/reference confinement, aspect validation, model mismatch, no default timestamp filename, gcloud/API-key sentinel redaction, malformed response, and no network on invalid input.

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_gemini_image_machine
```

- [ ] **Step 3: Add machine entry through existing functions**

Refactor `gemini_image()`, `imagen_image()`, and `save()` to accept validated in-memory arguments. Machine mode writes `output-1.png` in the invocation root, rejects every Imagen reference instead of dropping it, reports the observed model/backend, and never invokes `default_out()`.

- [ ] **Step 4: Run focused and CLI regressions**

```bash
python3 -m unittest Tools.tests.test_gemini_image_machine
python3 Tools/gemini_image.py --help
```

- [ ] **Step 5: Commit**

```bash
git add Tools/gemini_image.py Tools/tests/test_gemini_image_machine.py
git commit -m "feat(tools): add Gemini image machine protocol"
```

### Task 4: Google TTS and Lyria machine mode

**Files:**
- Modify: `Tools/gemini_audio.py`
- Create: `Tools/tests/test_gemini_audio_machine.py`

**Interfaces:**
- Consumes: `audio.tts` and `audio.music`.
- Produces: observed model, voice/format facts, estimate evidence, exact audio artifact, and terminal event.

- [ ] **Step 1: Write failing fake-HTTP/converter tests**

Cover stdin-only TTS/music text, voice/model allowlists, duration bounds, fixed output names, declared-versus-actual format, WAV fallback truth, conversion failure, estimate-not-settlement labeling, gcloud token redaction, and no network on invalid input.

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_gemini_audio_machine
```

- [ ] **Step 3: Add machine entry**

Refactor the current TTS/music functions to return structured facts. Machine mode writes `output-1.ogg` only when conversion really produced Ogg; otherwise it writes and reports `output-1.wav` with `audio/wav`. Never label an estimate as charged or settled.

- [ ] **Step 4: Run focused and CLI regressions**

```bash
python3 -m unittest Tools.tests.test_gemini_audio_machine
python3 Tools/gemini_audio.py --help
```

- [ ] **Step 5: Commit**

```bash
git add Tools/gemini_audio.py Tools/tests/test_gemini_audio_machine.py
git commit -m "feat(tools): add Google audio machine protocol"
```

### Task 5: Codex image invocation isolation

**Files:**
- Modify: `Tools/cdx-image`
- Create: `Tools/lib/codex_image_machine.py`
- Create: `Tools/tests/test_cdx_image_machine.py`

**Interfaces:**
- Consumes: explicit-only `image.generate`.
- Produces: one invocation-owned image artifact or a typed refusal.

- [ ] **Step 1: Write failing fake-Codex tests**

Use a fake `codex` executable and temporary fake home. Prove prompt arrives through `codex exec -` stdin, each concurrent attempt gets a unique generation root, only its own output can settle, auth is referenced without copying its bytes into logs/fixtures, zero/multiple images refuse, output is fixed, and automatic/unpinned routing refuses before spawn.

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_cdx_image_machine
```

- [ ] **Step 3: Add a Python machine helper and preserve Bash human mode**

`cdx-image --meshfleet-machine` delegates to the Python helper. The helper creates an invocation-specific `CODEX_HOME`, references the existing auth owner without serializing auth content, invokes `codex exec --ephemeral --ignore-user-config -s read-only --skip-git-repo-check -` with prompt stdin, and admits only an image created beneath that invocation's generated-image root. Keep the positional Bash path for humans.

- [ ] **Step 4: Run concurrency and usage regressions**

```bash
python3 -m unittest Tools.tests.test_cdx_image_machine
bash Tools/cdx-image 2>&1 | head -5
```

- [ ] **Step 5: Commit**

```bash
git add Tools/cdx-image Tools/lib/codex_image_machine.py Tools/tests/test_cdx_image_machine.py
git commit -m "feat(tools): isolate Codex image machine invocations"
```

### Task 6: MiniMax canonical `mmx-media` machine mode

**Files:**
- Modify: `Tools/mmx-media`
- Create: `Tools/lib/minimax_media_machine.py`
- Create: `Tools/tests/test_minimax_media_machine.py`

**Interfaces:**
- Consumes: `image.generate`, `video.generate`, `video.image_to_video`, `audio.tts`, and `audio.music`.
- Produces: the existing fixed MiniMax HTTPS calls, durable video task IDs, polling progress, exact collected artifacts, and typed readiness/error responses.

- [ ] **Step 1: Write failing fake-HTTP tests**

Import `Tools/mmx-media` under a fake credential resolver and fake `urllib` transport. Prove the additive machine entry leaves every existing human subcommand unchanged; creative inputs arrive only in the JSON request on stdin; image, video, image-to-video, TTS, and music map to the existing in-process functions; async video emits the provider task ID before terminal success; resume polls the exact supplied task ID without regenerating; generated filenames are fixed beneath the invocation-owned cwd; and timeout, overflow, missing credential, malformed media, and unsupported cancellation fail closed without a provider call where applicable.

- [ ] **Step 2: Verify red**

```bash
python3 -m unittest Tools.tests.test_minimax_media_machine
```

- [ ] **Step 3: Implement the canonical lane adapter**

Add `--meshfleet-machine` to `Tools/mmx-media`. It validates the closed request with `Tools/lib/media_adapter_protocol.py`, maps only the five fixed operations to the existing command functions, and replaces all human stdout with bounded protocol events. It never accepts an endpoint, executable, model outside the wrapper's fixed allowlists, arbitrary output name, credential source, or provider URL. Preserve the current Keychain/env credential ownership and usage ledger behavior. For video, persist and emit the exact MiniMax `task_id` before polling; resume uses only that task ID and never creates a second generation.

- [ ] **Step 4: Preserve human CLI behavior and offline readiness**

Run the focused tests plus current usage/help commands. These are local-only and must not call MiniMax:

```bash
python3 -m unittest Tools.tests.test_minimax_media_machine
python3 Tools/mmx-media --help
python3 Tools/mmx-media usage
```

The machine readiness response may prove only wrapper/schema availability. It must not claim credential or live-provider readiness without a separately authorized probe.

- [ ] **Step 5: Commit**

```bash
git add Tools/mmx-media Tools/lib/minimax_media_machine.py Tools/tests/test_minimax_media_machine.py
git commit -m "feat(tools): add MiniMax media machine mode"
```

### Task 7: Protocol conformance and wrapper handoff

**Files:**
- Create: `Tools/tests/test_media_machine_conformance.py`
- Create: `SUCCESSION/fleet-media-machine-wrappers-2026-07-29/HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1–6 and MeshFleet protocol fixtures.
- Produces: one offline conformance matrix and factual activation handoff.

- [ ] **Step 1: Add cross-wrapper conformance tests**

Run every wrapper against the same valid/invalid request corpus. Assert closed versioning, stdin-only creative input, fixed output names, bounded events, terminal exactly once, no sentinel secret, no absolute path, no unrecognized provider/model claim, and provider-call count zero.

- [ ] **Step 2: Run full local gates**

```bash
python3 -m unittest Tools.tests.test_media_adapter_protocol Tools.tests.test_pxl_machine Tools.tests.test_gemini_image_machine Tools.tests.test_gemini_audio_machine Tools.tests.test_cdx_image_machine Tools.tests.test_minimax_media_machine Tools.tests.test_media_machine_conformance
python3 -m unittest discover -s Tools/tests -p 'test_*.py'
bash Tools/tests/test_wrapper_usage_ledger.sh
git diff --check
```

- [ ] **Step 3: Obtain independent review**

Run specification-compliance review, then code-quality/security review. Require explicit verdicts on credential ownership, prompt transport, fixed operation selection, output confinement, Codex concurrency, MiniMax task resume, and zero provider contact.

- [ ] **Step 4: Write the handoff**

Record branch/base/head, protocol fixture commit, each wrapper's offline readiness, commands/results, provider calls `none`, and the exact separately authorized live probes still needed. Do not claim MiniMax credential or live-provider readiness from offline fake-transport tests.

- [ ] **Step 5: Commit**

```bash
git add Tools/tests/test_media_machine_conformance.py SUCCESSION/fleet-media-machine-wrappers-2026-07-29/HANDOFF.md
git commit -m "test(tools): verify media machine wrappers offline"
```
