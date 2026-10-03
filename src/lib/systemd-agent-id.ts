export function systemdAgentId(unit: string): string | null {
  let agent: string | null = null;
  let section = "Service";
  for (const raw of unit.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) { section = line.slice(1, -1); continue; }
    if (section !== "Service") continue;
    if (line.endsWith("\\")) return null;
    const assignment = line.match(/^Environment\s*=\s*(.*)$/);
    if (!assignment) continue;
    const value = assignment[1];
    if (!value) { agent = null; continue; }
    const words = value.match(/"[^"\\]*"|'[^'\\]*'|[^\s"'\\]+/g);
    if (!words || words.join(" ") !== value.replace(/\s+/g, " ")) return null;
    for (const word of words) {
      const token = /^["']/.test(word) ? word.slice(1, -1) : word;
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return null;
      if (token.startsWith("FLAIR_AGENT_ID=")) {
        const id = token.slice("FLAIR_AGENT_ID=".length);
        agent = /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
      }
    }
  }
  return agent;
}
