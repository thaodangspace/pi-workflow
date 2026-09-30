/**
 * Versioned, session-scoped capability/provider registry for pi-workflow.
 *
 * Workflow definitions declare logical capability requirements (e.g. `loop`,
 * `tmux`, `github`) without hard-coding the executable or integration that
 * fulfils them. Trusted extensions register versioned providers that expose a
 * narrow, extension-facing API handle; pi-workflow only orchestrates.
 *
 * Design boundaries:
 * - A registry instance belongs to one Pi process/session. It is never a
 *   module-level singleton, so registrations cannot leak across sessions.
 * - The model-facing iteration context exposes availability metadata only,
 *   never provider API handles or raw mutable internal state.
 * - Provider presence is explicit and versioned. A tool name, binary path, or
 *   namespace is NOT treated as proof of a compatible, healthy provider.
 */

import { randomUUID } from "node:crypto";

/** Version of the inter-extension capability registration protocol. */
export const CAPABILITY_BUS_VERSION = 1 as const;

/** pi.events channel a provider emits to announce/advertise a capability. */
export const CAPABILITY_REGISTER_CHANNEL = "pi-workflow:capability:register:v1";

/** pi.events channel a provider emits to withdraw a capability. */
export const CAPABILITY_UNREGISTER_CHANNEL = "pi-workflow:capability:unregister:v1";

/**
 * pi.events channel the registry emits after binding to an active session to
 * ask providers to (re-)advertise. Guarantees advertisements are only accepted
 * while a concrete session identity is active.
 */
export const CAPABILITY_REQUEST_CHANNEL = "pi-workflow:capability:request:v1";

/** Minimal event-bus surface required for capability registration. */
export interface CapabilityEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

/** Availability of a capability provider. */
export type CapabilityStatus = "available" | "degraded" | "unavailable";

/**
 * Structured capability requirement declared by a workflow definition.
 *
 * A bare string requirement is equivalent to `{ name }` (any compatible
 * version, no required features, not optional).
 */
export interface WorkflowCapabilityRequirement {
  /** Stable logical capability name (e.g. "loop", "tmux", "github"). */
  name: string;
  /** Minimum required provider major version. */
  version?: number;
  /** Features the provider must advertise (all required). */
  features?: readonly string[];
  /**
   * Optional capability. A missing/incompatible optional capability is
   * surfaced as a warning and never blocks unrelated workflow runs.
   */
  optional?: boolean;
}

/** Point-in-time descriptor of a registered capability provider. */
export interface WorkflowCapability {
  name: string;
  version: number;
  features: readonly string[];
  status: CapabilityStatus;
  /** Explanation when status is "degraded" or "unavailable". */
  reason?: string;
}

/** Dynamic status returned by a provider's status resolver. */
export interface CapabilityStatusSnapshot {
  status: CapabilityStatus;
  reason?: string;
}

/**
 * Registration description supplied by a trusted extension.
 * The optional `api` is the narrow, extension-facing handle. It is frozen on
 * registration and never included in model-facing context.
 */
export interface CapabilityProviderRegistration {
  name: string;
  /** Provider version (integer >= 1). Defaults to 1. */
  version?: number;
  features?: readonly string[];
  /** Trusted extension-facing API handle (opaque to the registry). */
  api?: unknown;
  /** Static initial status. Defaults to "available". Ignored when getStatus is set. */
  status?: CapabilityStatus;
  /** Reason for a static degraded/unavailable status. */
  reason?: string;
  /** Optional dynamic status resolver, evaluated on every read. */
  getStatus?: () => CapabilityStatus | CapabilityStatusSnapshot;
  /** Optional owning session id for direct registrations (bus ads use the envelope). */
  sessionId?: string;
}

/** Handle returned to the registrar, enabling controlled disposal. */
export interface CapabilityProviderHandle {
  readonly id: string;
  readonly capability: string;
  readonly version: number;
  readonly features: readonly string[];
  readonly sessionId?: string;
  /** Trusted extension-facing API handle (frozen shallowly). */
  readonly api: unknown;
  dispose(): void;
}

/** Per-requirement outcome of resolving a capability requirement. */
export interface CapabilityResolutionItem {
  name: string;
  optional: boolean;
  /** True when a compatible provider satisfies the requirement. */
  satisfied: boolean;
  /** "missing" when no provider (or an unavailable provider) is present. */
  status: CapabilityStatus | "missing" | "incompatible";
  requiredVersion?: number;
  requiredFeatures?: readonly string[];
  provider?: WorkflowCapability;
  /** Actionable explanation when not satisfied or when degraded. */
  reason?: string;
}

/** Aggregate resolution of a set of capability requirements. */
export interface CapabilityResolution {
  /** True when every required (non-optional) capability is satisfied. */
  ok: boolean;
  items: CapabilityResolutionItem[];
  /** Names of satisfied providers (available or degraded). */
  satisfied: string[];
  /** Required capabilities with no registered/compatible provider. */
  missing: string[];
  /** Required capabilities present at an incompatible version/features. */
  incompatible: string[];
  /** Required capabilities currently degraded. */
  degraded: string[];
  /** Optional capabilities with no registered/compatible provider. */
  optionalMissing: string[];
  /** Optional capabilities present at an incompatible version/features. */
  optionalIncompatible: string[];
  /** Optional capabilities currently degraded. */
  optionalDegraded: string[];
}

export class WorkflowCapabilityRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCapabilityRegistrationError";
  }
}

export function isCapabilityStatus(value: unknown): value is CapabilityStatus {
  return value === "available" || value === "degraded" || value === "unavailable";
}

/**
 * Normalizes raw requirement entries (bare names or structured objects) into
 * a deduplicated, validated requirement list. Later entries with the same name
 * are ignored (first wins) so normalized lists stay deterministic.
 */
export function normalizeCapabilityRequirements(
  input: readonly (string | WorkflowCapabilityRequirement)[]
): WorkflowCapabilityRequirement[] {
  const out: WorkflowCapabilityRequirement[] = [];
  const seen = new Set<string>();
  for (const raw of input ?? []) {
    const req: WorkflowCapabilityRequirement =
      typeof raw === "string" ? { name: raw.trim() } : { ...raw, name: raw.name.trim() };
    if (!req.name || seen.has(req.name)) {
      continue;
    }
    seen.add(req.name);
    out.push(req);
  }
  return out;
}

/** Human-readable, actionable description of unmet requirements. */
export function describeCapabilityFailures(resolution: CapabilityResolution): string {
  const parts: string[] = [];
  if (resolution.missing.length > 0) {
    parts.push(`missing: [${resolution.missing.join(", ")}]`);
  }
  if (resolution.incompatible.length > 0) {
    parts.push(`incompatible: [${resolution.incompatible.join(", ")}]`);
  }
  return parts.join("; ");
}

interface InternalProvider {
  id: string;
  registration: CapabilityProviderRegistration;
  frozenApi: unknown;
  source: "direct" | "bus";
  /** Session this provider is attributed to; undefined means process-scoped. */
  sessionId?: string;
  handle: CapabilityProviderHandle;
}

export interface WorkflowCapabilityRegistryOptions {
  /** Optional session identity for diagnostics and cross-session rejection. */
  sessionId?: string;
}

/**
 * Session-scoped registry of versioned capability providers.
 *
 * Create one instance per Pi session and dispose it on `session_shutdown`.
 * Separate instances never share registrations.
 */
export class WorkflowCapabilityRegistry {
  /** Session identity supplied at construction (may be undefined until bound). */
  readonly sessionId?: string;
  private activeSessionId?: string;
  private providers = new Map<string, InternalProvider>();
  private busUnsubscribers: Array<() => void> = [];
  private bus?: CapabilityEventBus;
  private disposed = false;

  constructor(options: WorkflowCapabilityRegistryOptions = {}) {
    this.sessionId = options.sessionId;
    this.activeSessionId = options.sessionId;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Currently active session identity, if the registry has been bound. */
  getSessionId(): string | undefined {
    return this.activeSessionId;
  }

  /**
   * Binds the registry to the active Pi session.
   *
   * On a session switch, providers attributed to the previous session (any
   * provider registered with a matching explicit session id, plus all
   * bus-advertised providers, which are inherently session-scoped) are removed
   * so stale providers cannot leak across sessions. Process/direct providers
   * without a session attribution are preserved (e.g. host-injected providers).
   *
   * When bound to an event bus, a capability request is broadcast so providers
   * re-advertise for the new session.
   */
  beginSession(sessionId: string): void {
    this.assertUsable();
    const next = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!next) {
      throw new WorkflowCapabilityRegistrationError("beginSession requires a non-empty session id.");
    }

    if (this.activeSessionId !== undefined && this.activeSessionId !== next) {
      const previous = this.activeSessionId;
      for (const [name, provider] of Array.from(this.providers.entries())) {
        // Bus-advertised providers are attributed to the active session at
        // registration; direct providers only when they declared a session.
        if (provider.sessionId === previous) {
          this.providers.delete(name);
        }
      }
    }

    this.activeSessionId = next;

    // Ask providers to (re-)advertise now that a concrete session is active.
    if (this.bus) {
      try {
        this.bus.emit(CAPABILITY_REQUEST_CHANNEL, { version: CAPABILITY_BUS_VERSION, sessionId: next });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Registers a provider. Throws on duplicate names unless `replace` is set.
   */
  register(
    registration: CapabilityProviderRegistration,
    options: { replace?: boolean; source?: "direct" | "bus" } = {}
  ): CapabilityProviderHandle {
    this.assertUsable();
    const name = typeof registration?.name === "string" ? registration.name.trim() : "";
    if (!name) {
      throw new WorkflowCapabilityRegistrationError("Capability provider registration requires a non-empty name.");
    }
    if (
      registration.sessionId !== undefined &&
      this.activeSessionId !== undefined &&
      registration.sessionId !== this.activeSessionId
    ) {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" belongs to session "${registration.sessionId}", not the current session "${this.activeSessionId}".`
      );
    }

    const version =
      registration.version === undefined
        ? 1
        : registration.version;
    if (!Number.isInteger(version) || version < 1) {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" version must be a positive integer (got ${registration.version}).`
      );
    }

    const rawFeatures = registration.features ?? [];
    if (!Array.isArray(rawFeatures)) {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" features must be an array of strings.`
      );
    }
    for (const f of rawFeatures) {
      if (typeof f !== "string" || f.trim() === "") {
        throw new WorkflowCapabilityRegistrationError(
          `Capability provider "${name}" feature entries must be non-empty strings.`
        );
      }
    }
    const features = dedupeStrings(rawFeatures);
    if (registration.status !== undefined && !isCapabilityStatus(registration.status)) {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" status must be "available", "degraded", or "unavailable".`
      );
    }
    if (registration.getStatus !== undefined && typeof registration.getStatus !== "function") {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" getStatus must be a function.`
      );
    }

    const existing = this.providers.get(name);
    if (existing && !options.replace) {
      throw new WorkflowCapabilityRegistrationError(
        `Capability provider "${name}" is already registered for this session. Unregister it first or pass { replace: true }.`
      );
    }
    if (existing) {
      this.providers.delete(name);
    }

    const normalized: CapabilityProviderRegistration = {
      ...registration,
      name,
      version,
      features,
      api: freezeHandle(registration.api),
    };

    const id = `cap-${randomUUID().slice(0, 12)}`;
    const registry = this;
    const source = options.source ?? "direct";
    // Bus-advertised providers are always attributed to the active session, so
    // they are purged when the session switches.
    const providerSessionId =
      source === "bus" ? normalized.sessionId ?? this.activeSessionId : normalized.sessionId;
    const handle: CapabilityProviderHandle = Object.freeze({
      id,
      capability: name,
      version,
      features: Object.freeze([...features]),
      sessionId: providerSessionId,
      api: normalized.api,
      dispose(): void {
        registry.unregister(name, id);
      },
    });

    this.providers.set(name, {
      id,
      registration: normalized,
      frozenApi: normalized.api,
      source,
      sessionId: providerSessionId,
      handle,
    });
    return handle;
  }

  /** Unregisters a provider by name, optionally verifying the owning handle id. */
  unregister(name: string, handleId?: string): boolean {
    const existing = this.providers.get(name);
    if (!existing) {
      return false;
    }
    if (handleId !== undefined && existing.id !== handleId) {
      return false;
    }
    this.providers.delete(name);
    return true;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Returns a point-in-time descriptor, or undefined when not registered. */
  getCapability(name: string): WorkflowCapability | undefined {
    const provider = this.providers.get(name);
    if (!provider) {
      return undefined;
    }
    return this.describe(provider);
  }

  listCapabilities(): WorkflowCapability[] {
    return Array.from(this.providers.values())
      .map((p) => this.describe(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Returns the trusted provider API handle for a capability.
   * This is intentionally separate from capability metadata so model-facing
   * context never receives provider internals.
   */
  getProviderApi<T = unknown>(name: string): T | undefined {
    return this.providers.get(name)?.frozenApi as T | undefined;
  }

  /**
   * Resolves a set of requirements against the currently registered providers.
   * `"degraded"` providers satisfy a requirement but are reported for visibility.
   */
  resolveRequirements(
    requirements: readonly (string | WorkflowCapabilityRequirement)[]
  ): CapabilityResolution {
    const normalized = normalizeCapabilityRequirements(requirements);
    const items: CapabilityResolutionItem[] = [];

    for (const req of normalized) {
      items.push(this.resolveOne(req));
    }

    const satisfied = items.filter((i) => i.satisfied).map((i) => i.name);
    const missing = items.filter((i) => !i.optional && i.status === "missing").map((i) => i.name);
    const incompatible = items.filter((i) => !i.optional && i.status === "incompatible").map((i) => i.name);
    const degraded = items.filter((i) => !i.optional && i.status === "degraded").map((i) => i.name);
    const optionalMissing = items.filter((i) => i.optional && i.status === "missing").map((i) => i.name);
    const optionalIncompatible = items
      .filter((i) => i.optional && i.status === "incompatible")
      .map((i) => i.name);
    const optionalDegraded = items.filter((i) => i.optional && i.status === "degraded").map((i) => i.name);

    return {
      ok: missing.length === 0 && incompatible.length === 0,
      items,
      satisfied,
      missing,
      incompatible,
      degraded,
      optionalMissing,
      optionalIncompatible,
      optionalDegraded,
    };
  }

  /**
   * Binds the registry to an inter-extension event bus so provider extensions
   * can advertise capabilities without holding the registry instance.
   *
   * The binding is session-scoped: it is removed by `dispose()`.
   */
  bindEventBus(events: CapabilityEventBus): () => void {
    this.assertUsable();
    this.bus = events;
    const onRegister = (data: unknown): void => {
      // Advertisements are honored only while this registry is bound to a
      // concrete session, and only when the sender proves the same, non-empty
      // session id. A shared process bus therefore cannot leak another
      // session's providers into this session.
      if (this.activeSessionId === undefined) {
        return;
      }
      const parsed = parseBusRegistration(data);
      if (!parsed || parsed.sessionId === undefined || parsed.sessionId !== this.activeSessionId) {
        return;
      }
      try {
        this.register(parsed, { replace: true, source: "bus" });
      } catch {
        // Malformed or conflicting advertisements are ignored; direct
        // registrations take precedence and must not crash the session.
      }
    };
    const onUnregister = (data: unknown): void => {
      if (this.activeSessionId === undefined) {
        return;
      }
      const parsed = parseBusUnregister(data);
      // Withdrawal must prove the same session id as the active session.
      if (!parsed || parsed.sessionId !== this.activeSessionId) {
        return;
      }
      const provider = this.providers.get(parsed.name);
      // Only ever withdraw a provider this bus registered for this session.
      if (provider && provider.source === "bus" && provider.sessionId === this.activeSessionId) {
        this.unregister(parsed.name);
      }
    };

    const subRegister = events.on(CAPABILITY_REGISTER_CHANNEL, onRegister);
    const subUnregister = events.on(CAPABILITY_UNREGISTER_CHANNEL, onUnregister);
    if (typeof subRegister === "function") this.busUnsubscribers.push(subRegister);
    if (typeof subUnregister === "function") this.busUnsubscribers.push(subUnregister);

    return () => {
      // Best-effort: the bus unsubscribers are also cleared on dispose.
      for (const unsub of this.busUnsubscribers) {
        try {
          unsub();
        } catch {
          // ignore
        }
      }
      this.busUnsubscribers = [];
      this.bus = undefined;
    };
  }

  /**
   * Disposes the registry: removes the event-bus binding and all providers.
   * Idempotent, so repeated session shutdown paths are safe.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsub of this.busUnsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.busUnsubscribers = [];
    this.bus = undefined;
    this.providers.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (this.disposed) {
      throw new WorkflowCapabilityRegistrationError("Capability registry has been disposed.");
    }
  }

  private describe(provider: InternalProvider): WorkflowCapability {
    const { status, reason } = this.resolveStatus(provider.registration);
    return {
      name: provider.registration.name,
      version: provider.registration.version ?? 1,
      features: Object.freeze([...(provider.registration.features ?? [])]),
      status,
      ...(reason ? { reason } : {}),
    };
  }

  private resolveStatus(registration: CapabilityProviderRegistration): CapabilityStatusSnapshot {
    if (registration.getStatus) {
      try {
        const resolved = registration.getStatus();
        if (typeof resolved === "string" && isCapabilityStatus(resolved)) {
          return { status: resolved };
        }
        if (
          resolved &&
          typeof resolved === "object" &&
          isCapabilityStatus((resolved as CapabilityStatusSnapshot).status)
        ) {
          return {
            status: (resolved as CapabilityStatusSnapshot).status,
            reason: (resolved as CapabilityStatusSnapshot).reason,
          };
        }
      } catch {
        return { status: "unavailable", reason: `provider status check failed for "${registration.name}"` };
      }
    }
    return { status: registration.status ?? "available", reason: registration.reason };
  }

  private resolveOne(req: WorkflowCapabilityRequirement): CapabilityResolutionItem {
    const base: CapabilityResolutionItem = {
      name: req.name,
      optional: req.optional === true,
      satisfied: false,
      status: "missing",
      ...(req.version !== undefined ? { requiredVersion: req.version } : {}),
      ...(req.features && req.features.length > 0 ? { requiredFeatures: [...req.features] } : {}),
    };

    const provider = this.providers.get(req.name);
    if (!provider) {
      return {
        ...base,
        reason: req.optional
          ? `optional capability "${req.name}" has no registered provider`
          : `no provider is registered for required capability "${req.name}"`,
      };
    }

    const capability = this.describe(provider);
    base.provider = capability;

    if (capability.status === "unavailable") {
      return {
        ...base,
        status: "missing",
        reason: capability.reason
          ? `capability "${req.name}" provider is unavailable: ${capability.reason}`
          : `capability "${req.name}" provider is unavailable`,
      };
    }

    if (req.version !== undefined && capability.version < req.version) {
      return {
        ...base,
        status: "incompatible",
        reason: `capability "${req.name}" requires version >= ${req.version} but provider version ${capability.version} is registered`,
      };
    }

    const requiredFeatures = req.features ?? [];
    if (requiredFeatures.length > 0) {
      const missingFeatures = requiredFeatures.filter((f) => !capability.features.includes(f));
      if (missingFeatures.length > 0) {
        return {
          ...base,
          status: "incompatible",
          reason: `capability "${req.name}" requires feature(s) [${missingFeatures.join(
            ", "
          )}] but provider advertises [${capability.features.join(", ") || "none"}]`,
        };
      }
    }

    if (capability.status === "degraded") {
      return {
        ...base,
        status: "degraded",
        satisfied: true,
        reason: capability.reason
          ? `capability "${req.name}" is degraded: ${capability.reason}`
          : `capability "${req.name}" is degraded`,
      };
    }

    return { ...base, status: "available", satisfied: true };
  }
}

/**
 * Builds the canonical provider registration for the pi-loop scheduler
 * capability. Availability and version come from the public pi-loop service
 * contract, never from tool names or CLI presence.
 */
export function createLoopCapabilityRegistration(options: {
  version: number;
  isAvailable: () => boolean;
  reason?: () => string | undefined;
}): CapabilityProviderRegistration {
  return {
    name: "loop",
    version: options.version,
    features: ["self-paced", "fixed", "cron", "once", "wakeup"],
    getStatus: () => {
      const available = options.isAvailable();
      return available ? "available" : { status: "unavailable", reason: options.reason?.() };
    },
  };
}

/** Factory mirroring the other pi-workflow constructors. */
export function createWorkflowCapabilityRegistry(
  options: WorkflowCapabilityRegistryOptions = {}
): WorkflowCapabilityRegistry {
  return new WorkflowCapabilityRegistry(options);
}

// ---------------------------------------------------------------------------
// Bus payload parsing
// ---------------------------------------------------------------------------

function parseBusRegistration(data: unknown): CapabilityProviderRegistration | undefined {
  if (!isRecord(data) || data.version !== CAPABILITY_BUS_VERSION) {
    return undefined;
  }
  const raw = data.provider;
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") {
    return undefined;
  }
  const status = raw.status;
  if (status !== undefined && !isCapabilityStatus(status)) {
    return undefined;
  }
  let features: string[] | undefined;
  if (raw.features !== undefined) {
    if (!Array.isArray(raw.features) || raw.features.some((f) => typeof f !== "string")) {
      return undefined;
    }
    features = raw.features as string[];
  }
  const version = raw.version;
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
    return undefined;
  }
  // The session id is carried at the top level of the bus envelope so register,
  // unregister, and request payloads share one shape. Direct registrations use
  // `provider.sessionId` (or none) instead.
  const sessionId =
    typeof data.sessionId === "string" && data.sessionId.trim() !== "" ? data.sessionId.trim() : undefined;
  return {
    name: raw.name.trim(),
    version: version as number | undefined,
    features,
    api: raw.api,
    status: status as CapabilityStatus | undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    sessionId,
  };
}

function parseBusUnregister(data: unknown): { name: string; sessionId: string } | undefined {
  if (!isRecord(data) || data.version !== CAPABILITY_BUS_VERSION) {
    return undefined;
  }
  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : undefined;
  const sessionId =
    typeof data.sessionId === "string" && data.sessionId.trim() !== "" ? data.sessionId.trim() : undefined;
  if (!name || !sessionId) {
    return undefined;
  }
  return { name, sessionId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dedupeStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function freezeHandle(api: unknown): unknown {
  if (api !== null && typeof api === "object" && !Object.isFrozen(api)) {
    try {
      Object.freeze(api);
    } catch {
      // Freezing is best-effort; the registry never exposes mutable internals.
    }
  }
  return api;
}
