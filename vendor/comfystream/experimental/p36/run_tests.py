"""Run upstream P36 tests against an isolated copy of the vendored node tree."""

from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile

EXPERIMENT = Path(__file__).resolve().parent
VENDOR = EXPERIMENT.parents[1]

manifest = json.loads((EXPERIMENT / "source-manifest.json").read_text())
for entry in manifest["files"]:
    path = EXPERIMENT / entry["path"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
        raise ValueError(f"Experimental P36 source hash mismatch: {entry['path']}")

with tempfile.TemporaryDirectory(prefix="sloptogether-p36-test-") as temporary:
    root = Path(temporary)
    shutil.copytree(VENDOR / "runtime" / "deploy", root / "deploy")
    for name in ("p36_node.py", "p36_worker.py"):
        shutil.copy2(EXPERIMENT / "deploy/custom_nodes/fasth3_deploy" / name,
                     root / "deploy/custom_nodes/fasth3_deploy" / name)
    shutil.copy2(EXPERIMENT / "deploy/fal/fasth3-b1/bootstrap_p36.py",
                 root / "deploy/fal/fasth3-b1/bootstrap_p36.py")
    shutil.copytree(EXPERIMENT / "tests", root / "tests")
    # This repository deliberately does not provision P36 in the production image.
    subprocess.run([sys.executable, "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider",
                    "-k", "not worker_image_provisions_the_pinned_runtime_before_serving",
                    str(root / "tests")], check=True)
