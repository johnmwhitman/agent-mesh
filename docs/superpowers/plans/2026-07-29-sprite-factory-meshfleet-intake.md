# Sprite Factory MeshFleet Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, fail-closed Sprite Factory intake for admitted MeshFleet artifacts while preserving exact hashes, provider provenance, licensing authority, deterministic completion, exact-byte human review, and engine validation.

**Architecture:** A closed `sprite-factory.meshfleet-intake.v1` parser accepts artifact IDs and hashes, never raw paths. A registered local consumer resolver content-copies admitted artifacts into a temporary staging root, verifies every exact byte, and converts the manifest into Sprite Factory’s existing provenance and completion inputs. The CLI stays offline and additive; direct generation and PixelLab intake remain available.

**Tech Stack:** Python 3.10+, dataclasses, pathlib, hashlib, JSON, Pillow, pytest, existing Sprite Factory completion/provenance/license/review/engine modules.

## Global Constraints

- Execute only after the MeshFleet core plan commits the intake schema, artifact materialization command, and fake fixtures.
- Create a fresh Sprite Factory worktree; the primary checkout contains review-ledger/proof changes, a deleted test, and an untracked batch script that must remain untouched.
- The intake accepts `artifact_id` plus lowercase SHA-256 only. It does not accept raw paths, URLs, provider tokens, executables, argv, environment, output roots, or arbitrary commands from the manifest.
- MeshFleet artifact admission is not Sprite Factory licensing approval, semantic approval, or engine approval.
- Empty, missing, incompatible, or unknown license/provenance fields fail before deterministic post-processing.
- All copied artifacts are hash-verified before Pillow opens them.
- PixelLab fetch manifests, endpoint facts, prompt hash, provider facts, generation count, and candidate selection remain bound to their MeshFleet artifact IDs.
- `candidate_selected` identifies existing bytes; it never regenerates.
- Every produced package remains review pending. Only the existing exact-byte review ledger may approve it.
- Reuse `complete_family()`, `check_output_license()`, `write_generated_source()`, `reviews.gate()`, and engine/profile validators; do not fork their policy.
- Existing `generate` and `pixellab-intake` commands remain available and unchanged.
- Offline tests use a fake registered-consumer resolver; no provider call, live readiness probe, or spend is authorized.

## Baseline

Before Task 1, run from the isolated Sprite Factory worktree:

```bash
git status --short --branch
python -m pytest -q
python -m spritefactory.cli --help
```

Record any pre-existing failure before editing.

---

### Task 1: Closed intake schema and parser

**Files:**
- Create: `schemas/meshfleet-intake-v1.schema.json`
- Create: `spritefactory/meshfleet_intake.py`
- Create: `tests/test_meshfleet_intake.py`

**Interfaces:**
- Consumes: the approved cross-repository manifest.
- Produces: `SpriteFactoryMediaIntakeV1`, `MeshfleetArtifactRef`, `MeshfleetIntakeError`, `load_meshfleet_intake()`.

- [ ] **Step 1: Write failing contract tests**

Cover exact version, required fields, unknown fields, duplicate JSON keys, wrong JSON types, zero/duplicate artifacts, malformed IDs, malformed hashes, invalid review state, empty provider/model facts, missing prompt hash, and every unsupported license. The closed `sprite-factory.meshfleet-intake.v1` manifest MUST be produced by Core from completed artifacts and MUST include: prompt_sha256, requested/selected/observed model distinctions, license_declaration, and artifact hashes. Sprite pins and validates these committed fixtures (not live generation output).

```python
def test_manifest_rejects_raw_paths_and_urls(tmp_path):
    payload = valid_manifest()
    payload["artifacts"][0]["path"] = "/tmp/output.png"
    path = write_manifest(tmp_path, payload)
    with pytest.raises(MeshfleetIntakeError, match="unknown fields: path"):
        load_meshfleet_intake(path)
```

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_meshfleet_intake.py
```

Expected: FAIL because `spritefactory.meshfleet_intake` is absent.

- [ ] **Step 3: Implement the closed dataclasses and schema**

Use immutable dataclasses and the same duplicate-key rejection pattern as `spritefactory.provenance`. The root fields are exactly:

```python
{
    "version",
    "artifacts",
    "execution_id",
    "attempt_id",
    "requested_provider",
    "selected_provider",
    "observed_provider_model",
    "prompt_sha256",
    "generation_count",
    "license_declaration",
    "review_state",
}
```

Optional members must be explicitly nullable in both parser and JSON Schema. Reuse `check_output_license()` after parsing the nonempty license string so parser/schema/license allowlists cannot drift.

- [ ] **Step 4: Prove schema/parser parity**

```bash
python -m pytest -q tests/test_meshfleet_intake.py
python -m pytest -q tests/test_provenance.py
```

- [ ] **Step 5: Commit**

```bash
git add schemas/meshfleet-intake-v1.schema.json spritefactory/meshfleet_intake.py tests/test_meshfleet_intake.py
git commit -m "feat(spritefactory): add closed MeshFleet intake contract"
```

### Task 2: Registered-consumer artifact materialization

**Files:**
- Create: `spritefactory/meshfleet_materialize.py`
- Create: `tests/test_meshfleet_materialize.py`

**Interfaces:**
- Consumes: `SpriteFactoryMediaIntakeV1`, fixed `meshfleet-media artifacts materialize` stdin protocol.
- Produces: `MeshfleetMaterializer`, `MaterializedMeshfleetArtifact`, `materialize_meshfleet_artifacts()`.

- [ ] **Step 1: Write failing fake-resolver tests**

Use a temporary executable fixture. Cover fixed argv, bounded stdin/stdout/stderr, cleared environment, timeout, non-zero exit, unknown output fields, unregistered consumer, missing file, empty file, symlink, device/non-regular file, root escape, hash mismatch, duplicate output, partial failure cleanup, and sentinel-secret absence:

```python
assert fake.argv == ["artifacts", "materialize", "--consumer", "sprite-factory", "--json"]
assert "artifact_id" in fake.stdin_text
assert str(fake.consumer_root) not in fake.stdin_text
assert fake.provider_calls == 0
```

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_meshfleet_materialize.py
```

- [ ] **Step 3: Implement the fixed resolver**

Production uses the constant executable `meshfleet-media`, constant consumer identity `sprite-factory`, no shell, no inherited provider environment, bounded pipes, and a temporary staging root created by Sprite Factory. The bridge returns relative filenames only. Resolve each with `Path.resolve()`, prove confinement to the staging root, reject symlinks/non-regular files, stream SHA-256, and compare with the immutable manifest before returning.

- [ ] **Step 4: Run focused tests twice**

```bash
python -m pytest -q tests/test_meshfleet_materialize.py
python -m pytest -q tests/test_meshfleet_materialize.py
```

Expected: both runs PASS and leave no partial staging tree.

- [ ] **Step 5: Commit**

```bash
git add spritefactory/meshfleet_materialize.py tests/test_meshfleet_materialize.py
git commit -m "feat(spritefactory): materialize admitted MeshFleet artifacts"
```

### Task 3: Provenance binding without policy duplication

**Files:**
- Modify: `spritefactory/provenance.py`
- Modify: `spritefactory/meshfleet_intake.py`
- Modify: `tests/test_provenance.py`
- Modify: `tests/test_meshfleet_intake.py`

**Interfaces:**
- Consumes: verified intake manifest plus exact copied artifact records.
- Produces: `MeshfleetGeneratedSourceV1`, `write_meshfleet_generated_source()`, public-safe `meshfleet_generated_source.json`.

- [ ] **Step 1: Write failing provenance tests**

Assert the record binds execution, attempt, requested and selected provider, observed model, prompt hash, generation count, license, review state, each artifact ID, copied relative path, exact SHA-256, and size. Prove absolute paths, authority references, credentials, prompts, registered roots, and secret-shaped fields cannot serialize.

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_provenance.py -k meshfleet
python -m pytest -q tests/test_meshfleet_intake.py -k provenance
```

- [ ] **Step 3: Implement a distinct versioned record**

Do not overload `GeneratedSourceV1.from_fetch_manifest()`. Add a frozen MeshFleet-specific record with closed construction and reuse the existing public-path and deterministic JSON helpers:

```python
@dataclass(frozen=True)
class MeshfleetGeneratedSourceV1:
    schema_version: int
    execution_id: str
    attempt_id: str
    selected_provider: str
    prompt_sha256: str
    license_declaration: str
    artifacts: tuple[MeshfleetSourceArtifact, ...]
```

Write canonical UTF-8 JSON with stable member ordering and a final newline.

- [ ] **Step 4: Run all provenance gates**

```bash
python -m pytest -q tests/test_provenance.py tests/test_meshfleet_intake.py
```

- [ ] **Step 5: Commit**

```bash
git add spritefactory/provenance.py spritefactory/meshfleet_intake.py tests/test_provenance.py tests/test_meshfleet_intake.py
git commit -m "feat(spritefactory): bind MeshFleet artifact provenance"
```

### Task 4: Deterministic package intake and review-pending output

**Files:**
- Modify: `spritefactory/meshfleet_intake.py`
- Modify: `tests/test_meshfleet_intake.py`
- Reference: `spritefactory/pixellab_intake.py`
- Reference: `spritefactory/complete.py`
- Reference: `spritefactory/licenses.py`

**Interfaces:**
- Consumes: verified image artifacts and manifest provenance.
- Produces: `intake_meshfleet_image()`, `intake_meshfleet_pixel_bundle()`, RSI delivery plus `meshfleet_generated_source.json`.

- [ ] **Step 1: Write failing intake tests**

Cover single-image object completion, four-direction pixel bundle, wrong artifact count, decode bomb guard, alpha-empty image, oversized content refusal, license mismatch, failed cleanup, overwrite refusal, deterministic repeat, and review-pending scaffold. Include a PixelLab fixture whose endpoint-specific metadata and candidate selection survive unchanged.

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_meshfleet_intake.py -k "image or pixel or package"
```

- [ ] **Step 3: Implement verify-to-complete flow**

Order operations exactly:

```text
parse closed manifest
check Sprite Factory output license
materialize IDs into temporary root
verify every exact hash
decode with bounded pixel count
normalize without resampling
call complete_family
write MeshFleet provenance
write review-pending scaffold
cleanup atomically on any failure
```

Reuse `normalize_single()`, `normalize_direction_set()`, `build_direction_sheet()`, and `complete_family()` rather than copying them. Keep the resulting review state pending regardless of manifest `candidate_selected`.

- [ ] **Step 4: Run MeshFleet and PixelLab regression tests**

```bash
python -m pytest -q tests/test_meshfleet_intake.py tests/test_pixellab_intake.py tests/test_complete.py
```

- [ ] **Step 5: Commit**

```bash
git add spritefactory/meshfleet_intake.py tests/test_meshfleet_intake.py
git commit -m "feat(spritefactory): package MeshFleet media for review"
```

### Task 5: Additive offline CLI

**Files:**
- Modify: `spritefactory/cli.py`
- Create: `tests/test_meshfleet_cli.py`

**Interfaces:**
- Consumes: manifest path, fixed registered-consumer bridge, explicit output/package options.
- Produces: `spritefactory meshfleet-intake`.

- [ ] **Step 1: Write failing CLI tests**

Cover help text, JSON output, object and character modes, automatic kind from closed metadata, missing manifest, resolver refusal, license refusal, review-pending summary, and no network/provider contact. Prove `generate` and `pixellab-intake` parsers are unchanged.

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_meshfleet_cli.py
```

- [ ] **Step 3: Add the thin command**

Import `meshfleet_intake as meshfleet_intake_mod`, add `_cmd_meshfleet_intake()`, and register:

```text
spritefactory meshfleet-intake MANIFEST OUT
  --kind auto|object|character
  --name NAME
  --copyright TEXT
  --license CC0-1.0|CC-BY-SA-3.0
  --state STATE
  --tile N
  --no-inhand
  --rotate
  --grow
  --overwrite
```

The command may choose packaging options, but it cannot choose the executable, consumer root, artifact paths, provider, model, credential source, or authority reference.

- [ ] **Step 4: Run CLI regressions**

```bash
python -m pytest -q tests/test_meshfleet_cli.py tests/test_pixellab_intake.py tests/test_cli_output.py tests/test_cli_safety.py
python -m spritefactory.cli meshfleet-intake --help
```

- [ ] **Step 5: Commit**

```bash
git add spritefactory/cli.py tests/test_meshfleet_cli.py
git commit -m "feat(spritefactory): add offline MeshFleet intake command"
```

### Task 6: Preserve review, integration, and engine gates

**Files:**
- Modify only if a failing compatibility test proves it necessary: `spritefactory/reviews.py`
- Modify only if a failing compatibility test proves it necessary: `spritefactory/integrate.py`
- Modify only if a failing compatibility test proves it necessary: `spritefactory/engines.py`
- Create: `tests/test_meshfleet_gate_integration.py`

**Interfaces:**
- Consumes: package created by `meshfleet-intake`.
- Produces: unchanged review-gate, integration-plan, and engine-validation decisions.

- [ ] **Step 1: Write the end-to-end failing gate test**

Build one package through the fake resolver and assert:

1. structural completion passes;
2. unsupported license fails before output;
3. `reviews.gate()` reports the exact states unreviewed;
4. a review for different bytes does not approve the package;
5. exact-byte approval clears only the review gate;
6. integration still requires declared destination/wiring;
7. the selected engine/profile validator still runs and can fail independently.

- [ ] **Step 2: Verify red**

```bash
python -m pytest -q tests/test_meshfleet_gate_integration.py
```

- [ ] **Step 3: Implement only necessary adapters**

Prefer zero changes to `reviews.py`, `integrate.py`, and `engines.py`. If the new provenance filename needs discovery, add the narrowest adapter and keep license/review/engine decisions in their current owners. Do not add a MeshFleet “approved” shortcut.

- [ ] **Step 4: Run authoritative gates**

```bash
python -m pytest -q tests/test_meshfleet_gate_integration.py tests/test_reviews.py tests/test_reviews_witness.py tests/test_gates.py tests/test_complete.py tests/test_provenance.py
```

- [ ] **Step 5: Commit**

```bash
git add tests/test_meshfleet_gate_integration.py spritefactory/reviews.py spritefactory/integrate.py spritefactory/engines.py
git commit -m "test(spritefactory): preserve gates for MeshFleet intake"
```

Before committing, unstage any of the three production modules that did not require a change.

### Task 7: Full offline verification and factual handoff

**Files:**
- Create: `docs/MESHFLEET-INTAKE-HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1–6 and committed MeshFleet fake fixtures.
- Produces: exact local evidence and remaining authority gates.

- [ ] **Step 1: Run focused and full suites**

```bash
python -m pytest -q tests/test_meshfleet_intake.py tests/test_meshfleet_materialize.py tests/test_meshfleet_cli.py tests/test_meshfleet_gate_integration.py
python -m pytest -q
python -m spritefactory.cli --help
```

- [ ] **Step 2: Run artifact and secret checks**

Use sentinel values through the fake resolver and search generated packages, JSON output, logs, and test records. Confirm prompts, authority references, registered roots, provider tokens, and absolute staging paths are absent. Confirm exact artifact IDs and hashes remain.

- [ ] **Step 3: Inspect compatibility**

```bash
git diff --check
git diff --stat
git diff -- spritefactory/generate.py spritefactory/pixellab_intake.py deliveries proof
```

Expected: no direct-generation behavior change and no modification to the dirty primary checkout’s delivery/proof state.

- [ ] **Step 4: Obtain independent review**

Run specification-compliance review, then code-quality review. Require explicit verdicts on raw-path rejection, exact-byte verification, license authority, review currentness, deterministic completion, and engine gate preservation.

- [ ] **Step 5: Write and commit the handoff**

Record branch/base/head, schema version, fake bridge commit, focused/full test outputs, provider calls `none`, generated review state `pending`, and remaining merge/push/provider-probe/spend/publication gates.

```bash
git add docs/MESHFLEET-INTAKE-HANDOFF.md
git commit -m "docs: hand off Sprite Factory MeshFleet intake"
```
