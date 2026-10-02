#!/usr/bin/env python3
"""Read a literal top-level Gradle Kotlin version, preserving source offsets."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def parse_gradle_version(content: str) -> tuple[str, int, int]:
    tokens: list[tuple[str, int, int, int, bool]] = []
    stack: list[str] = []
    i = 0
    while i < len(content):
        if content[i].isspace():
            i += 1
            continue
        if content.startswith("//", i):
            while i < len(content) and content[i] != "\n":
                i += 1
            continue
        if content.startswith("/*", i):
            i += 2
            comments = 1
            while i < len(content) and comments:
                if content.startswith("/*", i):
                    comments += 1
                    i += 2
                elif content.startswith("*/", i):
                    comments -= 1
                    i += 2
                else:
                    i += 1
            if comments:
                raise ValueError("Unterminated comment in Gradle version syntax")
            continue
        start, depth, quote = i, len(stack), content[i]
        if quote in ('"', "'"):
            triple = content.startswith('"""', i)
            delimiter = '"""' if triple else quote
            i += len(delimiter)
            while i < len(content) and not content.startswith(delimiter, i):
                if not triple and content[i] == "\\":
                    i += 2
                else:
                    if not triple and content[i] in "\r\n":
                        raise ValueError("Unterminated string in Gradle version syntax")
                    i += 1
            if i >= len(content):
                raise ValueError("Unterminated string in Gradle version syntax")
            i += len(delimiter)
            tokens.append((content[start:i], start, i, depth, True))
            continue
        if re.match(r"[A-Za-z_$]", content[i]):
            while i < len(content) and re.match(r"[A-Za-z0-9_$]", content[i]):
                i += 1
        else:
            i += 1
            if quote in "{([":
                stack.append(quote)
            if quote in "})]":
                opening = {"}": "{", ")": "(", "]": "["}[quote]
                if not stack or stack.pop() != opening:
                    raise ValueError("Unbalanced Gradle version syntax")
        tokens.append((content[start:i], start, i, depth, False))
    if stack:
        raise ValueError("Unbalanced Gradle version syntax")
    # Script-level declarations shadow Project.version, including later writes.
    if any(token[3] == 0 and token[0] in ("val", "var")
           and index + 1 < len(tokens)
           and (tokens[index + 1][0] == "version"
                or (tokens[index + 1][0] == "`" and index + 2 < len(tokens)
                    and tokens[index + 2][0] == "version"))
           for index, token in enumerate(tokens)):
        raise ValueError("Gradle version is ambiguous: top-level local declaration shadows Project.version")
    # Alternate setters can override the root literal without another bare write.
    for index, token in enumerate(tokens):
        if token[3] != 0:
            continue
        escaped = (index > 0 and index + 1 < len(tokens)
                   and tokens[index - 1][0] == "`" and tokens[index + 1][0] == "`")
        previous, next_index = index - (2 if escaped else 1), index + (2 if escaped else 1)
        qualified = previous >= 0 and tokens[previous][0] == "."
        root_receiver = (qualified and previous > 0
                         and tokens[previous - 1][0] in ("rootProject", "project", "this"))
        next_text = tokens[next_index][0] if next_index < len(tokens) else None
        assignment = (next_text == "=" and
                      (next_index + 1 >= len(tokens) or tokens[next_index + 1][0] != "="))
        if ((token[0] == "version" and assignment and (escaped or root_receiver))
                or (token[0] == "setVersion" and next_text == "("
                    and (not qualified or root_receiver))):
            raise ValueError("Gradle version is ambiguous: alternate top-level Project.version setter")
    assignments = [index for index, token in enumerate(tokens)
                   if token[3] == 0 and token[0] == "version"
                   and (index == 0 or tokens[index - 1][0] not in (".", "val", "var"))
                   and index + 1 < len(tokens) and tokens[index + 1][0] == "="
                   and (index + 2 >= len(tokens) or tokens[index + 2][0] != "=")]
    if len(assignments) != 1:
        raise ValueError(f"Missing or ambiguous top-level Gradle version assignment ({len(assignments)})")
    index = assignments[0]
    value = tokens[index + 2] if index + 2 < len(tokens) else None
    if not value or not value[4] or not re.fullmatch(r'"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"', value[0]):
        raise ValueError("Gradle version must be a quoted semver literal")
    next_token = tokens[index + 3] if index + 3 < len(tokens) else None
    if next_token and next_token[0] != ";" and (
        not re.search(r"[\r\n]", content[value[2]:next_token[1]])
        or next_token[0] in ("+", "-", ".", "?", "!", "*", "/", "%", "&", "|", "=", "(", "[")
    ):
        raise ValueError("Gradle version must be a standalone literal")
    return value[0][1:-1], value[1] + 1, value[2] - 1


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <file>", file=sys.stderr)
        sys.exit(1)
    try:
        print(parse_gradle_version(Path(sys.argv[1]).read_bytes().decode("utf-8"))[0])
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
