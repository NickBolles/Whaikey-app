#!/usr/bin/env python3
"""Codex-subscription bridge for the tiered flavor backfill.

Runs on the operator host that holds the owner's Codex (ChatGPT plan) login
through Hermes (`hermes -z --provider openai-codex`). The production DB URL
never leaves GitHub: the `flavor enrichment` workflow does every DB read and
write, and this script only moves prompts and raw model text between them.

    prepare  → dispatch workflow mode=prepare (free pass + export), download
               the `flavor-candidates` artifact
    cheap    → small model, no tools, ~25 bottles per request
    heavy    → stronger model with Hermes' web toolset, ~5 bottles per request
    apply    → upload raw results as a release asset, dispatch mode=apply

Usage guard: `hermes usage --json` is read before the run and before every
model request. When any window's used% reaches --stop-at (default 48, so
remaining stays above 50% with a margin for in-flight requests) the pass
stops; already-finished results are still applied. The next run resumes
naturally because `prepare` only exports bottles that still need a profile.

    python3 scripts/flavor-codex-bridge.py run [--ref BRANCH] [--max-batches N]
    python3 scripts/flavor-codex-bridge.py usage

Never prints tokens or secrets; it holds none.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = os.environ.get("FLAVOR_REPO", "NickBolles/Whaikey-app")
WORKFLOW = "flavor-enrichment.yml"
RELEASE_TAG = "flavor-enrichment-data"
STATE = Path(os.environ.get("FLAVOR_STATE_DIR", Path.home() / ".whaikey-flavor"))


def load_gh_token() -> None:
    """Cron/background shells don't inherit the interactive GH_TOKEN; read it
    (only that key) from the Hermes env file. Never printed."""
    if os.environ.get("GH_TOKEN"):
        return
    for env_file in (os.environ.get("FLAVOR_ENV_FILE"), "/home/hermes/.hermes/.env"):
        if env_file and Path(env_file).is_file():
            for line in Path(env_file).read_text().splitlines():
                if line.startswith("GH_TOKEN="):
                    os.environ["GH_TOKEN"] = line.split("=", 1)[1].strip().strip('"').strip("'")
                    return


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{now()}] {msg}", flush=True)


def sh(args: list[str], *, timeout: int = 600, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed ({p.returncode}): {p.stderr.strip()[-400:]}")
    return p


# --------------------------------------------------------------------------- usage

def codex_usage() -> dict:
    """{'used': max used% across windows, 'windows': [...]}; raises when unreadable."""
    p = sh(["hermes", "usage", "--provider", "openai-codex", "--json"], timeout=60)
    data = json.loads(p.stdout[p.stdout.index("{"):])
    windows = [w for w in data.get("windows", []) if isinstance(w.get("used_percent"), (int, float))]
    if not windows:
        raise RuntimeError(f"no usage windows reported ({data.get('unavailable_reason')})")
    return {
        "used": max(float(w["used_percent"]) for w in windows),
        "windows": [{"label": w.get("label"), "used_percent": w["used_percent"], "resets_at": w.get("resets_at")} for w in windows],
        "plan": data.get("plan"),
    }


class Guard:
    """Thread-safe usage floor. Re-reads usage at most every `every` seconds."""

    def __init__(self, stop_at: float, every: float = 20.0):
        self.stop_at, self.every = stop_at, every
        self.lock = threading.Lock()
        self.last_read = 0.0
        self.last: dict | None = None
        self.tripped = False

    def ok(self) -> bool:
        with self.lock:
            if self.tripped:
                return False
            if time.time() - self.last_read >= self.every or self.last is None:
                try:
                    self.last = codex_usage()
                except Exception as exc:  # unreadable usage = stop, never guess
                    log(f"usage unreadable, stopping: {exc}")
                    self.tripped = True
                    return False
                self.last_read = time.time()
            if self.last["used"] >= self.stop_at:
                log(f"usage {self.last['used']}% ≥ stop-at {self.stop_at}% — stopping pass")
                self.tripped = True
            return not self.tripped


# --------------------------------------------------------------------------- github

def dispatch_and_wait(ref: str, fields: dict[str, str], timeout_s: int = 3600) -> int:
    started = time.time()
    args = ["gh", "workflow", "run", WORKFLOW, "-R", REPO, "--ref", ref]
    for k, v in fields.items():
        args += ["-f", f"{k}={v}"]
    sh(args)
    run_id = None
    for _ in range(60):
        time.sleep(5)
        p = sh(["gh", "run", "list", "-R", REPO, "--workflow", WORKFLOW, "--event", "workflow_dispatch", "-L", "5",
                "--json", "databaseId,createdAt,headBranch"])
        for r in json.loads(p.stdout):
            created = dt.datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp()
            if r["headBranch"] == ref and created >= started - 30:
                run_id = r["databaseId"]
                break
        if run_id:
            break
    if not run_id:
        raise RuntimeError("dispatched run did not appear")
    log(f"workflow run {run_id} ({fields.get('mode')}) started")
    while time.time() - started < timeout_s:
        p = sh(["gh", "run", "view", str(run_id), "-R", REPO, "--json", "status,conclusion"])
        st = json.loads(p.stdout)
        if st["status"] == "completed":
            if st["conclusion"] != "success":
                raise RuntimeError(f"workflow run {run_id} concluded {st['conclusion']}")
            log(f"workflow run {run_id} succeeded")
            return run_id
        time.sleep(20)
    raise RuntimeError(f"workflow run {run_id} timed out")


def download_artifact(run_id: int, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    sh(["gh", "run", "download", str(run_id), "-R", REPO, "-n", "flavor-candidates", "-D", str(dest)])
    return dest


def ensure_release() -> None:
    if sh(["gh", "release", "view", RELEASE_TAG, "-R", REPO], check=False).returncode == 0:
        return
    sh(["gh", "release", "create", RELEASE_TAG, "-R", REPO, "--prerelease", "--title", "Flavor enrichment data (machine)",
        "--notes", "Raw model output exchanged between the Codex host and the flavor-enrichment workflow. Not a product release."])


def upload_results(path: Path) -> None:
    ensure_release()
    sh(["gh", "release", "upload", RELEASE_TAG, str(path), "-R", REPO, "--clobber"], timeout=300)


def prune_assets(keep: int = 20) -> None:
    p = sh(["gh", "release", "view", RELEASE_TAG, "-R", REPO, "--json", "assets"], check=False)
    if p.returncode != 0:
        return
    assets = sorted(json.loads(p.stdout)["assets"], key=lambda a: a["name"])
    for a in assets[:-keep]:
        sh(["gh", "release", "delete-asset", RELEASE_TAG, a["name"], "-R", REPO, "-y"], check=False)


def alert(title: str, body: str) -> None:
    label = "flavor-enrichment"
    sh(["gh", "label", "create", label, "-R", REPO, "--color", "B60205", "--description", "Flavor-profile backfill health"], check=False)
    p = sh(["gh", "issue", "list", "-R", REPO, "--label", label, "--state", "open", "-L", "1", "--json", "number"], check=False)
    existing = json.loads(p.stdout or "[]") if p.returncode == 0 else []
    if existing:
        sh(["gh", "issue", "comment", str(existing[0]["number"]), "-R", REPO, "--body", body], check=False)
    else:
        sh(["gh", "issue", "create", "-R", REPO, "--label", label, "--title", title, "--body", body], check=False)


# --------------------------------------------------------------------------- model

def call_model(prompt: str, model: str, toolsets: str, reasoning: str | None, timeout: int) -> tuple[str, dict]:
    with tempfile.TemporaryDirectory(dir=STATE) as td:
        prompt_path = Path(td) / "usage.json"
        args = ["hermes", "-z", prompt, "-m", model, "--provider", "openai-codex", "-t", toolsets,
                "--ignore-rules", "--usage-file", str(prompt_path)]
        if reasoning:
            args += ["--reasoning", reasoning]
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=td)
        usage = json.loads(prompt_path.read_text()) if prompt_path.exists() else {}
        out = "\n".join(l for l in p.stdout.splitlines() if "install out of sync" not in l)
        if p.returncode != 0 or usage.get("failed"):
            raise RuntimeError(f"hermes -z exit {p.returncode}: {(p.stderr or out).strip()[-300:]}")
        return out, usage


PASS_CFG = {
    "cheap": {"model": os.environ.get("FLAVOR_CHEAP_MODEL", "gpt-6-luna"), "toolsets": "todo", "reasoning": "low", "timeout": 300},
    "heavy": {"model": os.environ.get("FLAVOR_HEAVY_MODEL", "gpt-6.1-sol"), "toolsets": "web", "reasoning": "medium", "timeout": 900},
}


def run_pass(name: str, batches: list[dict], guard: Guard, workers: int, max_batches: int, sink) -> dict:
    cfg = PASS_CFG[name]
    todo = batches[:max_batches] if max_batches else batches
    stats = {"pass": name, "model": cfg["model"], "batches_planned": len(todo), "batches_done": 0, "batches_failed": 0,
             "bottles_sent": 0, "tokens": 0, "stopped_by_guard": False}
    lock = threading.Lock()

    def work(batch: dict) -> None:
        if not guard.ok():
            return
        try:
            raw, usage = call_model(batch["prompt"], cfg["model"], cfg["toolsets"], cfg["reasoning"], cfg["timeout"])
        except Exception as exc:
            log(f"{name} batch failed: {exc}")
            with lock:
                stats["batches_failed"] += 1
            return
        with lock:
            stats["batches_done"] += 1
            stats["bottles_sent"] += len(batch["bottleIds"])
            stats["tokens"] += int(usage.get("total_tokens") or 0)
            done = stats["batches_done"]
        if done % 10 == 0:
            log(f"{name}: {done}/{len(todo)} batches, usage {guard.last and guard.last['used']}%")
        sink({"pass": name, "model": cfg["model"], "bottleIds": batch["bottleIds"], "raw": raw, "completedAt": now()})

    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, todo))
    stats["stopped_by_guard"] = guard.tripped
    return stats


# --------------------------------------------------------------------------- run

def cmd_run(a: argparse.Namespace) -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    lock_path = STATE / "run.lock"
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
    except FileExistsError:
        pid = lock_path.read_text().strip()
        if pid and Path(f"/proc/{pid}").exists():
            log(f"another run (pid {pid}) is in progress")
            return 0
        lock_path.unlink()
        return cmd_run(a)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = STATE / "runs" / stamp
    run_dir.mkdir(parents=True)
    summary: dict = {"started": now(), "ref": a.ref, "stop_at": a.stop_at, "passes": [], "applies": []}
    t0 = time.time()
    try:
        summary["usage_before"] = codex_usage()
        log(f"usage before: {summary['usage_before']['used']}%")
        run_id = dispatch_and_wait(a.ref, {"mode": "prepare", "dry_run": "false", "cheap_limit": str(a.cheap_limit),
                                           "heavy_top": str(a.heavy_top), "upgrade_keyword": str(a.upgrade_keyword).lower()})
        art = download_artifact(run_id, run_dir / "prepare")
        summary["free"] = json.loads((art / "free.json").read_text())
        candidates = json.loads((art / "candidates.json").read_text())
        summary["export"] = candidates["counts"]
        (art / "candidates.json").unlink()  # prompts are reproducible; keep the run dir small

        guard = Guard(a.stop_at)
        pending: list[dict] = []
        plock = threading.Lock()

        def flush(final: bool = False) -> None:
            with plock:
                if not pending or (not final and len(pending) < a.apply_every):
                    return
                chunk = pending[:]
                pending.clear()
            name = f"flavor-results-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
            path = run_dir / name
            path.write_text(json.dumps({"batches": chunk}))
            upload_results(path)
            rid = dispatch_and_wait(a.ref, {"mode": "apply", "dry_run": "false", "results_asset": name})
            out = download_artifact(rid, run_dir / f"apply-{rid}")
            res = json.loads((out / "apply.json").read_text())
            summary["applies"].append({"asset": name, "run": rid, "report": res["report"], "after": res["after"]})
            log(f"applied {name}: {res['report']['written']} written, coverage {res['after']['coveragePct']}%")
            path.unlink()

        def sink(batch: dict) -> None:
            with plock:
                pending.append(batch)
                ready = len(pending) >= a.apply_every
            if ready:
                flush()

        for name in ("cheap", "heavy"):  # owner order: free → cheap → heavy
            batches = [b for b in candidates["batches"] if b["pass"] == name]
            if not batches or a.skip_pass == name:
                continue
            if not guard.ok():
                summary["passes"].append({"pass": name, "skipped": "usage guard"})
                continue
            stats = run_pass(name, batches, guard, a.workers, a.max_batches, sink)
            flush(final=True)
            stats["usage_after"] = guard.last and guard.last["used"]
            summary["passes"].append(stats)
        flush(final=True)
        prune_assets()
        summary["status"] = "ok"
    except Exception as exc:
        summary["status"] = "failed"
        summary["error"] = str(exc)[-800:]
        log(f"run failed: {exc}")
        alert(f"Flavor enrichment host run failed ({stamp[:8]})",
              f"Host bridge run `{stamp}` failed:\n\n```\n{summary['error']}\n```\n\nState: `{run_dir}` on the Hermes host.")
    finally:
        try:
            summary["usage_after"] = codex_usage()
        except Exception as exc:
            summary["usage_after"] = {"error": str(exc)}
        summary["seconds"] = round(time.time() - t0)
        summary["finished"] = now()
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
        (STATE / "last-summary.json").write_text(json.dumps(summary, indent=2))
        lock_path.unlink(missing_ok=True)
    print(json.dumps({k: summary.get(k) for k in ("status", "usage_before", "usage_after", "export", "passes", "seconds")}, indent=2))
    return 0 if summary["status"] == "ok" else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--ref", default="main")
    r.add_argument("--stop-at", type=float, default=float(os.environ.get("FLAVOR_STOP_AT", "48")))
    r.add_argument("--workers", type=int, default=3)
    r.add_argument("--max-batches", type=int, default=0, help="per pass; 0 = all exported")
    r.add_argument("--cheap-limit", type=int, default=5000)
    r.add_argument("--heavy-top", type=int, default=2500)
    r.add_argument("--upgrade-keyword", action="store_true")
    r.add_argument("--apply-every", type=int, default=40, help="batches per apply dispatch")
    r.add_argument("--skip-pass", choices=["cheap", "heavy"])
    sub.add_parser("usage")
    a = ap.parse_args()
    load_gh_token()
    if a.cmd == "usage":
        print(json.dumps(codex_usage(), indent=2))
        return 0
    return cmd_run(a)


if __name__ == "__main__":
    sys.exit(main())
