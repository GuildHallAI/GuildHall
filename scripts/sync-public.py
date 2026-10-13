#!/usr/bin/env python3
"""Publish a public-identity mirror of main without changing the private branch."""

from __future__ import annotations

import re
import subprocess
import sys

SOURCE_BRANCH = "main"
PUBLIC_BRANCH = "public-main"
PUBLIC_REMOTE = "public-origin"
PUBLIC_NAME = "GuildHall"
PUBLIC_EMAIL = "guildhallproject@atomicmail.io"


def run(*args: str, input_data: bytes | None = None) -> bytes:
    completed = subprocess.run(
        args,
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode:
        sys.stderr.buffer.write(completed.stderr)
        raise SystemExit(completed.returncode)
    return completed.stdout


def rewritten_identity(line: bytes) -> bytes:
    match = re.match(rb"^(author|committer|tagger) .*? ([-]?\d+ [+-]\d{4})\n$", line)
    if not match:
        return line
    return (
        match.group(1)
        + b" "
        + PUBLIC_NAME.encode()
        + b" <"
        + PUBLIC_EMAIL.encode()
        + b"> "
        + match.group(2)
        + b"\n"
    )


def scrub_commit_message(payload: bytes) -> bytes:
    """Remove co-author trailers while preserving the rest of the message."""
    return re.sub(rb"(?im)^co-authored-by:[^\r\n]*(?:\r?\n|$)", b"", payload)


def rewrite_export(stream: bytes) -> bytes:
    """Rewrite fast-export headers while copying opaque data payloads unchanged."""
    output = bytearray()
    cursor = 0
    record_kind: bytes | None = None
    while cursor < len(stream):
        newline = stream.find(b"\n", cursor)
        if newline == -1:
            output.extend(stream[cursor:])
            break
        line = stream[cursor : newline + 1]
        cursor = newline + 1
        if line == b"blob\n":
            record_kind = b"blob"
        elif line.startswith(b"commit "):
            record_kind = b"commit"
        elif line.startswith(b"tag "):
            record_kind = b"tag"
        if line.startswith(b"data "):
            try:
                size = int(line[5:-1])
            except ValueError as error:
                raise RuntimeError(f"Unexpected fast-export data directive: {line!r}") from error
            payload = stream[cursor : cursor + size]
            cursor += size
            if record_kind in (b"commit", b"tag"):
                payload = scrub_commit_message(payload)
                output.extend(f"data {len(payload)}\n".encode())
            else:
                output.extend(line)
            output.extend(payload)
            if cursor < len(stream) and stream[cursor : cursor + 1] == b"\n":
                output.extend(b"\n")
                cursor += 1
            continue
        if line in (b"commit refs/heads/main\n", b"reset refs/heads/main\n"):
            output.extend(
                line.replace(
                    b"refs/heads/main",
                    f"refs/heads/{PUBLIC_BRANCH}".encode(),
                )
            )
        else:
            output.extend(rewritten_identity(line))
    return bytes(output)


def main() -> None:
    run("git", "rev-parse", "--verify", SOURCE_BRANCH)
    exported = run("git", "fast-export", "--show-original-ids", SOURCE_BRANCH)
    run("git", "fast-import", "--force", input_data=rewrite_export(exported))
    run("git", "push", PUBLIC_REMOTE, f"{PUBLIC_BRANCH}:main", "--force")
    print(f"Published sanitized {PUBLIC_BRANCH} to {PUBLIC_REMOTE}/main.")


if __name__ == "__main__":
    main()
