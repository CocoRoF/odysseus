"""실행 환경 조사 — 응시자의 [컴퓨터 정보] 화면에 보여줄 스펙을 모은다.

러너 자신이 조사해야 정확하다. 러너가 뜰 때 한 번 실행되어 Redis 에 게시된다.
"""

import os
import platform
import re
import shutil
import subprocess


def _run(cmd: list[str], timeout: float = 6.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (r.stdout or r.stderr or "").strip()


def _version(binary: str, args: list[str], pattern: str = r"(\d+[\w.+-]*)") -> str | None:
    """바이너리가 있으면 버전 문자열을, 없으면 None."""
    if not shutil.which(binary):
        return None
    out = _run([binary] + args)
    if not out:
        return None
    first = out.splitlines()[0]
    m = re.search(pattern, first)
    return m.group(1) if m else first[:60]


# (표시 이름, 실행 파일, 버전 인자, 종류)
_RUNTIMES = [
    ("Python", "python3", ["--version"], "language"),
    ("Node.js", "node", ["--version"], "language"),
    ("Go", "go", ["version"], "language"),
    ("Java", "java", ["-version"], "language"),
    ("GCC", "gcc", ["--version"], "language"),
    ("G++", "g++", ["--version"], "language"),
    ("Bash", "bash", ["--version"], "shell"),
    ("Git", "git", ["--version"], "tool"),
    ("Make", "make", ["--version"], "tool"),
    ("CMake", "cmake", ["--version"], "tool"),
    ("npm", "npm", ["--version"], "tool"),
    ("pip", "pip3", ["--version"], "tool"),
    ("SQLite", "sqlite3", ["--version"], "tool"),
    ("jq", "jq", ["--version"], "tool"),
    ("ripgrep", "rg", ["--version"], "tool"),
    ("curl", "curl", ["--version"], "tool"),
    ("Vim", "vim.tiny", ["--version"], "tool"),
]

_PY_PACKAGES = ["numpy", "pandas", "yaml", "requests", "dateutil", "tabulate", "pytest"]
_PY_DISPLAY = {"yaml": "PyYAML", "dateutil": "python-dateutil"}


def _python_packages() -> list[dict]:
    code = (
        "import importlib.metadata as md\n"
        "import sys\n"
        "names={'yaml':'PyYAML','dateutil':'python-dateutil'}\n"
        "for m in %r:\n"
        "    try:\n"
        "        mod=__import__(m)\n"
        "        v=getattr(mod,'__version__',None) or md.version(names.get(m,m))\n"
        "        print(f'{names.get(m,m)}\\t{v}')\n"
        "    except Exception:\n"
        "        pass\n" % (_PY_PACKAGES,)
    )
    out = _run(["python3", "-c", code], timeout=15)
    rows = []
    for line in out.splitlines():
        if "\t" in line:
            name, version = line.split("\t", 1)
            rows.append({"name": name, "version": version})
    return rows


def _os_name() -> str:
    try:
        with open("/etc/os-release") as fh:
            for line in fh:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.system()


def _mem_total_mb() -> int | None:
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError):
        pass
    return None


def probe_environment() -> dict:
    languages, tools, shells = [], [], []
    for label, binary, args, kind in _RUNTIMES:
        version = _version(binary, args)
        if not version:
            continue
        entry = {"name": label, "version": version, "command": binary}
        (languages if kind == "language" else shells if kind == "shell" else tools).append(entry)

    return {
        "os": _os_name(),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu_count": os.cpu_count(),
        "memory_total_mb": _mem_total_mb(),
        "languages": languages,
        "shells": shells,
        "tools": tools,
        "python_packages": _python_packages(),
    }


if __name__ == "__main__":
    import json

    print(json.dumps(probe_environment(), ensure_ascii=False, indent=2))
