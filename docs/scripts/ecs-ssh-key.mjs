export function decodeEcsKey(value) {
  const raw = String(value ?? "").trim();
  const key = raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8").trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n/u.test(key)) throw new Error("WORKFLOW_REMOTE_SSH_KEY must contain a PEM key or Base64-encoded PEM key.");
  return `${key}\n`;
}
