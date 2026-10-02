/** A literal root-project version and the offsets of its value (without quotes). */
export interface GradleVersion {
  version: string;
  start: number;
  end: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
  depth: number;
  string?: boolean;
}
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Scan Kotlin syntax, retaining offsets while excluding comments and string contents. */
export function parseGradleVersion(content: string): GradleVersion {
  const tokens: Token[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (/\s/.test(content[i])) {
      i++;
      continue;
    }
    if (content.startsWith("//", i)) {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (content.startsWith("/*", i)) {
      i += 2;
      let comments = 1;
      while (i < content.length && comments) {
        if (content.startsWith("/*", i)) {
          comments++;
          i += 2;
        } else if (content.startsWith("*/", i)) {
          comments--;
          i += 2;
        } else i++;
      }
      if (comments)
        throw new Error("Unterminated comment in Gradle version syntax");
      continue;
    }
    const start = i;
    const depth = stack.length;
    const quote = content[i];
    if (quote === '"' || quote === "'") {
      const triple = content.startsWith('"""', i);
      const delimiter = triple ? '"""' : quote;
      i += delimiter.length;
      while (i < content.length && !content.startsWith(delimiter, i)) {
        if (!triple && content[i] === "\\") i += 2;
        else {
          if (!triple && /[\r\n]/.test(content[i]))
            throw new Error("Unterminated string in Gradle version syntax");
          i++;
        }
      }
      if (i >= content.length)
        throw new Error("Unterminated string in Gradle version syntax");
      i += delimiter.length;
      tokens.push({
        text: content.slice(start, i),
        start,
        end: i,
        depth,
        string: true,
      });
      continue;
    }
    if (/[A-Za-z_$]/.test(content[i])) {
      while (i < content.length && /[A-Za-z0-9_$]/.test(content[i])) i++;
    } else {
      i++;
      if ("{([".includes(quote)) stack.push(quote);
      if ("})]".includes(quote)) {
        const opening = { "}": "{", ")": "(", "]": "[" }[quote];
        if (stack.pop() !== opening)
          throw new Error("Unbalanced Gradle version syntax");
      }
    }
    tokens.push({ text: content.slice(start, i), start, end: i, depth });
  }
  if (stack.length) throw new Error("Unbalanced Gradle version syntax");

  // A script-level variable named version shadows Project.version, even when
  // a later unqualified assignment looks like the project property setter.
  if (
    tokens.some(
      (token, index) =>
        token.depth === 0 &&
        ["val", "var"].includes(token.text) &&
        (tokens[index + 1]?.text === "version" ||
          (tokens[index + 1]?.text === "`" &&
            tokens[index + 2]?.text === "version")),
    )
  ) {
    throw new Error(
      "Gradle version is ambiguous: top-level local declaration shadows Project.version",
    );
  }

  // Qualified/backticked setters and setVersion() can override the literal
  // without looking like another bare version assignment. Fail closed.
  if (
    tokens.some((token, index) => {
      if (token.depth !== 0) return false;
      const escaped =
        tokens[index - 1]?.text === "`" && tokens[index + 1]?.text === "`";
      const previous = index - (escaped ? 2 : 1);
      const next = index + (escaped ? 2 : 1);
      const qualified = tokens[previous]?.text === ".";
      const rootReceiver =
        qualified &&
        ["rootProject", "project", "this"].includes(tokens[previous - 1]?.text);
      const assignment =
        tokens[next]?.text === "=" && tokens[next + 1]?.text !== "=";
      return (
        (token.text === "version" && assignment && (escaped || rootReceiver)) ||
        (token.text === "setVersion" &&
          tokens[next]?.text === "(" &&
          (!qualified || rootReceiver))
      );
    })
  ) {
    throw new Error(
      "Gradle version is ambiguous: alternate top-level Project.version setter",
    );
  }

  const assignments = tokens.filter(
    (token, index) =>
      token.depth === 0 &&
      token.text === "version" &&
      ![".", "val", "var"].includes(tokens[index - 1]?.text) &&
      tokens[index + 1]?.text === "=" &&
      tokens[index + 2]?.text !== "=",
  );
  if (assignments.length !== 1)
    throw new Error(
      `Missing or ambiguous top-level Gradle version assignment (${assignments.length})`,
    );
  const index = tokens.indexOf(assignments[0]);
  const value = tokens[index + 2];
  if (
    !value?.string ||
    !/^"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"$/.test(value.text)
  ) {
    throw new Error("Gradle version must be a quoted semver literal");
  }
  const next = tokens[index + 3];
  if (
    next &&
    next.text !== ";" &&
    (!/[\r\n]/.test(content.slice(value.end, next.start)) ||
      [
        "+",
        "-",
        ".",
        "?",
        "!",
        "*",
        "/",
        "%",
        "&",
        "|",
        "=",
        "(",
        "[",
      ].includes(next.text))
  ) {
    throw new Error("Gradle version must be a standalone literal");
  }
  return {
    version: value.text.slice(1, -1),
    start: value.start + 1,
    end: value.end - 1,
  };
}

export function replaceGradleVersion(
  content: string,
  nextVersion: string,
): string {
  if (!SEMVER.test(nextVersion))
    throw new Error(`Invalid version: ${nextVersion}`);
  const { start, end } = parseGradleVersion(content);
  return content.slice(0, start) + nextVersion + content.slice(end);
}
