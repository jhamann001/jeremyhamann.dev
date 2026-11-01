"""Per-case flywheel records, one JSONL line per passing case."""
import json
import os
import uuid
from pathlib import Path

_RUN_ID = os.getenv("TEST_RUN_ID") or str(uuid.uuid4())
_OUT = Path("test-results/flywheel/cases.jsonl")


def mark_case(suite: str, name: str) -> None:
    """Call after a case's assertions so ``pass: true`` is only written for a passing case."""
    _OUT.parent.mkdir(parents=True, exist_ok=True)
    record = {"case_id": name, "suite": suite, "run_id": _RUN_ID,
              "git_sha": os.getenv("GITHUB_SHA", "local"), "pass": True}
    with _OUT.open("a") as fh:
        fh.write(json.dumps(record) + "\n")
