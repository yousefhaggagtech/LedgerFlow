export function createRedactor(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/(?:PASSWORD|DATABASE_URL)$/.test(name)) continue;
    values.add(value);
    if (name.endsWith("DATABASE_URL")) {
      try {
        const password = new URL(value).password;
        if (password) { values.add(password); values.add(decodeURIComponent(password)); }
      } catch { /* Invalid parent URLs are deliberately allowed in the environment. */ }
    }
  }
  const secrets = [...values].filter(Boolean).sort((first, second) => second.length - first.length);
  return (input) => {
    let text = String(input);
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    // Fixture URLs may add search_path parameters, so also scrub unknown connection URLs.
    return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted database URL]");
  };
}
