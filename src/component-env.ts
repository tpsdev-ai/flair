// ─── The deployed component's `.env` (flair#1005 item 2, flair#1000, flair#1011) ──
//
// A publicly-reachable Flair served an OAuth discovery document whose issuer and
// every endpoint were `http://127.0.0.1:9980`, so no remote client could complete
// an authorization flow (flair#1000). The cause was `FLAIR_PUBLIC_URL` being unset
// on the instance: `resources/OAuth.ts` and `resources/AdminInstance.ts` fall back
// to the bind address when it is absent.
//
// The value has to arrive as an ENVIRONMENT VARIABLE in the component's process.
// The only channel a deploying client controls is a `.env` file inside the
// component payload, and Harper reads that file only because flair#1010 added
//
//     loadEnv:
//       files: '.env'
//
// to the shipped config.yaml, declared above `jsResource`. Without that block the
// file is inert — present on disk, never in `process.env`. Read config.yaml's own
// comment for the ordering constraint and for why `loadEnv` supplies APPLICATION
// variables only: it runs after Harper has already composed its own configuration.
//
// ── Why exactly one key ships, and no secret ever does ──────────────────────────
//
// The deploy payload is not transient. Harper's `deploy_component` ingests the
// whole tarball into an `hdb_deployment` row's `payload_blob`, and that row is the
// channel peers read the component from and the source for rollback
// (harper/dist/components/operations.js — "The row also holds the payload in a Blob
// attribute, which doubles as the source for peer replication and (later)
// rollback"). So anything in the payload is persisted on every node for as long as
// the deployment record lives. A public URL is fine there. A password is not.
//
// `HDB_ADMIN_PASSWORD` additionally cannot work from here even if that were
// acceptable: Harper composes its own configuration before component `.env` files
// load, so the name Harper itself consumes at startup is already resolved by the
// time `loadEnv` fires. Shipping it would put a credential in a component directory
// that only flair reads, fed from a different source than Harper's own copy, with
// nothing detecting divergence (flair#1011). `FLAIR_ADMIN_PASSWORD` is flair's own
// name for flair's own need and does reach its reader in time — but it is still a
// password, and the payload-persistence argument above applies to it unchanged.
//
// Hence: the file this module generates carries `FLAIR_PUBLIC_URL` and nothing
// else, and `assertNoSecretKeys` is a runtime guard, not a comment.

/** The file Harper's `loadEnv` plugin is pointed at by flair's config.yaml. */
export const COMPONENT_ENV_FILENAME = ".env";

/** The one key `flair deploy` supplies. */
export const PUBLIC_URL_KEY = "FLAIR_PUBLIC_URL";

/**
 * Key names that must never appear in a `.env` flair GENERATES.
 *
 * An operator's own file is a different matter — see `planComponentEnv`, which
 * preserves whatever they wrote and warns by key NAME (never value) rather than
 * silently dropping or shipping it.
 */
export const NEVER_GENERATED_SECRET_KEYS = [
  "HDB_ADMIN_PASSWORD",
  "FLAIR_ADMIN_PASSWORD",
  "FLAIR_ADMIN_PASS",
  "FABRIC_PASSWORD",
  "FLAIR_CLUSTER_ADMIN_PASS",
  "CLI_TARGET_PASSWORD",
] as const;

/**
 * A key name that looks like it carries a credential. Used for the operator-facing
 * notice only — matching is on the NAME, and the value is never read, printed, or
 * compared.
 */
export function looksLikeSecretKey(name: string): boolean {
  return /(PASSWORD|PASSWD|SECRET|TOKEN|_KEY|APIKEY|CREDENTIAL)/i.test(name);
}

/**
 * Is this URL one only the machine serving it can reach?
 *
 * Deliberately a TEXT test, not a DNS lookup: this decides what gets baked into a
 * deployed artifact, and a resolver answer at deploy time is not a property of the
 * artifact. The IPv4 pattern is anchored end-to-end on purpose — a prefix test
 * (`startsWith("127.")`) also matches hostnames like `127.0.0.1.example.com`, which
 * are ordinary DNS names that merely happen to begin with those digits.
 */
export function isLoopbackUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(host);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// A `.env` assignment line. `export ` is accepted because dotenv-style files
// commonly carry it and an operator who wrote `export FLAIR_PUBLIC_URL=...` has
// unambiguously set the key — treating that as "absent" and appending a second
// assignment would be the clobber this module exists to avoid.
const ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

/** Key NAMES present in a `.env`, in file order. Never returns values. */
export function envKeyNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGNMENT_RE.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * The value assigned to `key`, or null. The single value this module reads is
 * `FLAIR_PUBLIC_URL`, which is not a secret; nothing here reads any other value.
 */
export function readEnvValue(text: string | null | undefined, key: string): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGNMENT_RE.exec(line);
    if (!m || m[1] !== key) continue;
    let v = line.slice(line.indexOf("=") + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

/**
 * Throws if the transition from `existing` to `generated` INTRODUCES any key flair
 * must never generate.
 *
 * Deliberately a diff and not "does the output contain a password": an operator's
 * own `.env` may legitimately assign one, and refusing to deploy their file would
 * break a deploy that works today. What must never happen is flair adding one. A
 * runtime guard rather than a review convention, because the generator and this
 * check are one edit apart forever — and `git grep NEVER_GENERATED_SECRET_KEYS`
 * finds both ends of it.
 */
export function assertNoSecretKeysAdded(existing: string | null, generated: string): void {
  const before = new Set(envKeyNames(existing));
  const added = envKeyNames(generated).filter(
    (n) => !before.has(n) && (NEVER_GENERATED_SECRET_KEYS as readonly string[]).includes(n),
  );
  if (added.length) {
    throw new Error(
      `refusing to generate a component ${COMPONENT_ENV_FILENAME} that adds ${added.join(", ")}: ` +
        `the deploy payload is persisted in Harper's hdb_deployment record and replicated to ` +
        `every node, so flair must add no credential to it (flair#1011)`,
    );
  }
}

export type ComponentEnvAction =
  /** No `.env` needs to be supplied — deploy the package root as-is. */
  | "unchanged"
  /** flair adds the key to a payload that did not have it. */
  | "added"
  /** The operator already set the key; their value is kept verbatim. */
  | "operator-value-kept";

export interface ComponentEnvPlan {
  action: ComponentEnvAction;
  /**
   * The `.env` contents to ship, or null when `action === "unchanged"` (nothing
   * is written and the operator's tree is not touched).
   */
  text: string | null;
  /** The value that will be in effect for `FLAIR_PUBLIC_URL`, if any. */
  effectiveValue: string | null;
  /** Operator-facing lines. Key names only — never a value from a secret-shaped key. */
  notices: string[];
}

/**
 * Decide what `.env` a deploy should ship.
 *
 * `existing` is the CONTENT of a `.env` already in the package root, or null. It is
 * never modified in place and never overwritten on disk — the caller stages a copy.
 * That is the answer to "do not silently clobber an operator's existing `.env`":
 * flair MERGES, and merging here means "append the one key when it is absent, and
 * change nothing at all when it is present".
 *
 * Why merge rather than refuse: a `.env` in the package root already ships today
 * (Harper's packer includes every non-`node_modules` file under the deploy root), so
 * an operator can legitimately be relying on one, and refusing would break a deploy
 * that works. Why the operator's value wins rather than the deploy target: an
 * instance is routinely fronted by a hostname that is not the URL the deploy is
 * addressed to — a CDN, a reverse proxy, a vanity domain — and that hostname is
 * exactly what OAuth clients must be told. Overwriting it with the Fabric URL would
 * break the deployment the value exists to fix. The disagreement is printed, so the
 * choice is visible rather than silent.
 *
 * `publicUrl` is null when the deploy has no non-loopback target to advertise; the
 * plan is then "unchanged" — writing `http://127.0.0.1:...` into a shipped `.env` is
 * the precise misconfiguration flair#1000 is about, so it is never generated.
 */
export function planComponentEnv(
  existing: string | null,
  publicUrl: string | null,
): ComponentEnvPlan {
  const notices: string[] = [];

  // Whatever the operator wrote, say out loud which credential-shaped KEYS are
  // about to be persisted in the replicated deployment record. Names only.
  const secretish = envKeyNames(existing).filter(looksLikeSecretKey);
  if (secretish.length) {
    notices.push(
      `${COMPONENT_ENV_FILENAME} in the deploy root assigns ${secretish.join(", ")} — a deploy ` +
        `payload is stored in Harper's deployment record and replicated to every node, so ` +
        `those values travel with it. flair adds no credential of its own.`,
    );
  }

  const operatorValue = readEnvValue(existing, PUBLIC_URL_KEY);
  if (operatorValue !== null) {
    if (publicUrl && operatorValue !== publicUrl) {
      notices.push(
        `${PUBLIC_URL_KEY} is already set in ${COMPONENT_ENV_FILENAME} to ${operatorValue} — ` +
          `keeping it. The deploy target is ${publicUrl}; if the instance is fronted by a ` +
          `proxy or CDN the existing value is the correct one, otherwise edit that file.`,
      );
    }
    if (isLoopbackUrl(operatorValue)) {
      notices.push(
        `${PUBLIC_URL_KEY} in ${COMPONENT_ENV_FILENAME} is a loopback address ` +
          `(${operatorValue}). OAuth discovery and A2A discovery advertise it verbatim, so ` +
          `remote clients will be told to connect to their own machine (flair#1000).`,
      );
    }
    return { action: "operator-value-kept", text: null, effectiveValue: operatorValue, notices };
  }

  if (!publicUrl) {
    return { action: "unchanged", text: null, effectiveValue: null, notices };
  }

  const base = existing ?? "";
  const separator = base.length === 0 || base.endsWith("\n") ? "" : "\n";
  const text = `${base}${separator}${PUBLIC_URL_KEY}=${publicUrl}\n`;
  assertNoSecretKeysAdded(existing, text);

  return { action: "added", text, effectiveValue: publicUrl, notices };
}

/**
 * The remedy string for a missing/loopback `FLAIR_PUBLIC_URL`. One definition so
 * `flair deploy` and `flair doctor` cannot drift into naming different files.
 *
 * It names all three things an operator needs: the FILE, the KEY, and the fact that
 * the file is only read because config.yaml declares Harper's `loadEnv` plugin —
 * without which the file is present and inert, which is what made flair#1000 hard
 * to see.
 */
export function publicUrlRemedy(envPath: string, exampleUrl = "https://flair.example.com"): string {
  return (
    `set ${PUBLIC_URL_KEY}=${exampleUrl} in ${envPath} (Harper reads a component's ` +
    `${COMPONENT_ENV_FILENAME} only because flair's config.yaml declares the loadEnv plugin, ` +
    `above jsResource), then restart the instance`
  );
}

// ─── flair doctor ─────────────────────────────────────────────────────────────

export interface PublicUrlDoctorInput {
  /** `issuer` from the instance's own /OAuthMetadata, or null if it could not be read. */
  advertisedIssuer: string | null;
  /** `FLAIR_PUBLIC_URL` assigned in the component's `.env`, or null. */
  componentEnvValue: string | null;
  /** `FLAIR_PUBLIC_URL` visible to the CLI process, or null. */
  processEnvValue: string | null;
  /** Absolute path of the component `.env` the remedy should name. */
  componentEnvPath: string;
}

export interface PublicUrlDoctorFinding {
  isIssue: boolean;
  icon: "ok" | "warn" | "error";
  message: string;
  fixHint?: string;
}

/**
 * What `flair doctor` should say about the instance's advertised public URL.
 *
 * Scope, stated rather than implied: doctor diagnoses the instance on THIS machine,
 * reached over loopback. It cannot observe whether that instance is also reachable
 * at a public address, so "unset, and the instance is public" is not a state it can
 * detect — an unconditional finding there would fire on every laptop install, and a
 * check that always fires is noise, not a gate. What it CAN detect without guessing
 * is DRIFT: the value exists somewhere, and the running instance is still advertising
 * loopback anyway. That is the exact shape of flair#1000 (a `.env` was placed and the
 * issuer never changed, because no `loadEnv` declaration existed to read it), and it
 * has no false positives.
 *
 * The unset-everywhere case is reported as information, not a finding, with the full
 * remedy — so an operator who IS running this publicly is told precisely what to do.
 */
export function describePublicUrlFinding(input: PublicUrlDoctorInput): PublicUrlDoctorFinding | null {
  const { advertisedIssuer, componentEnvValue, processEnvValue, componentEnvPath } = input;

  // Nothing to say if the instance could not be asked.
  if (advertisedIssuer === null) return null;

  if (!isLoopbackUrl(advertisedIssuer)) {
    return {
      isIssue: false,
      icon: "ok",
      message: `OAuth/A2A discovery advertises ${advertisedIssuer}`,
    };
  }

  if (componentEnvValue !== null && !isLoopbackUrl(componentEnvValue)) {
    return {
      isIssue: true,
      icon: "error",
      message:
        `${PUBLIC_URL_KEY} is set in ${componentEnvPath} but discovery still advertises ` +
        `${advertisedIssuer} — the file is not reaching process.env, so every URL this ` +
        `instance publishes points at its own loopback (flair#1000)`,
      fixHint:
        `confirm config.yaml declares "loadEnv: files: '${COMPONENT_ENV_FILENAME}'" ABOVE ` +
        `jsResource, then restart — a component .env is inert without that declaration`,
    };
  }

  if (componentEnvValue === null && processEnvValue !== null && !isLoopbackUrl(processEnvValue)) {
    return {
      isIssue: true,
      icon: "error",
      message:
        `${PUBLIC_URL_KEY} is set in this shell but discovery advertises ${advertisedIssuer} — ` +
        `the server reads its own environment, not yours`,
      fixHint: publicUrlRemedy(componentEnvPath, processEnvValue),
    };
  }

  return {
    isIssue: false,
    icon: "warn",
    message:
      `${PUBLIC_URL_KEY} is not set — OAuth and A2A discovery advertise ${advertisedIssuer}, ` +
      `which is correct for a local-only install and unusable for any remote client`,
    fixHint: `if this instance is reachable at a public URL, ${publicUrlRemedy(componentEnvPath)}`,
  };
}
