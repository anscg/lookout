#!/usr/bin/env python3
"""Renders the repository homepage: substitutes the version and fingerprint,
and builds a listing of what was actually published.

GitHub Pages serves no directory indexes, so without this every path under the
root that isn't an exact file is a 404 and there is no way to look around.
"""
import html
import re
import sys
from pathlib import Path

# Noise, not content: the reader wants the packages and the indices they can
# verify, not every compression variant.
SKIP_NAMES = {"CNAME", ".nojekyll", "index.html"}


def human(n: int) -> str:
    if n >= 1 << 20:
        return f"{n / (1 << 20):.1f} MB"
    if n >= 1 << 10:
        return f"{n / (1 << 10):.0f} KB"
    return f"{n} B"


def natural(s: str):
    """Orders 0.3.7 before 0.3.10, which a plain string sort gets backwards."""
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def rows(root: Path) -> str:
    paths = sorted(
        (p for p in root.rglob("*") if p.is_file() and p.name not in SKIP_NAMES),
        key=lambda p: (
            [natural(d) for d in p.relative_to(root).parts[:-1]],
            natural(p.name),
        ),
    )
    out, seen = [], set()
    for p in paths:
        rel = p.relative_to(root)
        parts = rel.parts
        # Emit each directory header once, on the way down.
        for depth in range(len(parts) - 1):
            d = parts[: depth + 1]
            if d not in seen:
                seen.add(d)
                out.append(
                    f'<li class="d" style="--i:{depth}">{html.escape(d[-1])}/</li>'
                )
        href = "/" + "/".join(parts)
        out.append(
            f'<li style="--i:{len(parts) - 1}">'
            f'<a href="{html.escape(href)}">{html.escape(parts[-1])}</a>'
            f'<span>{human(p.stat().st_size)}</span></li>'
        )
    return "\n".join(out)


def main() -> int:
    template, repo, version, fpr, out = (
        Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4], Path(sys.argv[5])
    )
    page = (
        template.read_text()
        .replace("@VERSION@", html.escape(version))
        .replace("@FINGERPRINT@", html.escape(fpr))
        # pacman-key --lsign-key takes the fingerprint unspaced.
        .replace("@FPR_COMPACT@", html.escape(fpr.replace(" ", "")))
        .replace("@TREE@", rows(repo))
    )
    for token in ("@VERSION@", "@FINGERPRINT@", "@FPR_COMPACT@", "@TREE@"):
        if token in page:
            print(f"unsubstituted {token}", file=sys.stderr)
            return 1
    out.write_text(page)
    print(f"rendered {out} ({len(page)} bytes, {page.count('<li')} listing rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
