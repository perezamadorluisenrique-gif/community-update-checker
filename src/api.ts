/**
 * The extension API other plugins reach through
 * `app.plugins.getPlugin('update-radar').api`, or through the workspace event
 * `update-radar:api-ready` (fired once the layout is ready, with the API as its
 * argument).
 *
 * It is small on purpose: a plugin can look at the last check, run code before
 * Update Radar installs something (and stop it), hold an update back with its
 * own rule, add actions to a plugin's row, and hear when a check or an install
 * finished. `apiVersion` only goes up on a breaking change.
 *
 * This file imports nothing, so a plugin can copy the types as they are.
 */

/** Removes what it was returned for. Safe to call more than once, and after Update Radar unloads. */
export type Disposer = () => void;

export type UpdateStateName = 'update' | 'blocked' | 'ignored' | 'snoozed' | 'held' | 'waiting' | 'current' | 'none';

/** One installed plugin as the last check saw it. A copy: changing it changes nothing. */
export interface ReportSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** GitHub `owner/name`, or '' when the plugin is not from the community directory. */
  readonly repo: string;
  /** 'none' when no manifest was read (not listed, or the request failed). */
  readonly state: UpdateStateName;
  /** The newest version found, or '' when none was read. */
  readonly available: string;
  /** For state 'held': who holds it and why. */
  readonly heldBy: Hold | null;
}

/** What is about to be installed. */
export interface InstallIntent {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  /** The installed version. */
  readonly from: string;
  /** The version that will be installed. */
  readonly to: string;
  /** 'update' installs a newer release; 'earlier' goes back to an older one. */
  readonly kind: 'update' | 'earlier';
  /** How many installs this run has: more than 1 means "Update all". */
  readonly bulk: number;
}

/** Returned by a `beforeInstall` handler to stop the install. */
export interface Veto {
  readonly veto: true;
  /** Shown to the user in the notice that says nothing was installed. */
  readonly reason: string;
}

/** Runs before each install, one handler after the other, and may be async. Takes at most 20 seconds; a handler that throws or times out does not block the install. */
export type BeforeInstallHandler = (intent: InstallIntent) => Veto | void | Promise<Veto | void>;

export interface CheckedEvent {
  readonly reports: readonly ReportSummary[];
  /** True when the user asked for the check. */
  readonly manual: boolean;
}

export interface InstalledEvent {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'update' | 'earlier';
}

export interface UpdateRadarEvents {
  /** After every check that produced a list. */
  checked: CheckedEvent;
  /** After a plugin was installed (updated or put back to an earlier version). */
  installed: InstalledEvent;
}

/** What a hold provider is asked about: one plugin with a newer release that is on offer or waiting. */
export interface HoldQuery {
  readonly id: string;
  readonly name: string;
  readonly installed: string;
  readonly available: string;
  /** When Update Radar first saw `available` (ms epoch). */
  readonly firstSeen: number;
  readonly now: number;
}

/** Returned by a hold provider: the update is listed under "Held by rules" and not offered. */
export interface Hold {
  /** Who holds it; shown beside the label. */
  readonly owner: string;
  readonly label: string;
}

/** Called synchronously while the list is built. Keep it cheap, and do not write. */
export type HoldProvider = (query: HoldQuery) => Hold | null;

/** A plugin's row, for `rowActions`. */
export interface RowInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly repo: string;
  readonly state: UpdateStateName;
}

export interface RowAction {
  readonly label: string;
  /** A Lucide icon name. */
  readonly icon?: string;
  run(): void | Promise<void>;
}

/** Called each time a row's menu is opened. */
export type RowActionsProvider = (row: RowInfo) => readonly RowAction[];

/** A GitHub release of a plugin. */
export interface ReleaseNotes {
  /** Markdown; empty when the author wrote none. */
  readonly body: string;
  /** ISO date, or '' when unknown. */
  readonly published: string;
  readonly url: string;
}

export interface UpdateRadarApiV1 {
  readonly apiVersion: 1;
  /** The last check, a copy. Empty before the first check. */
  reports(): readonly ReportSummary[];
  /** Listens for an event. Listeners are not awaited and a failing one affects nobody else. */
  on<E extends keyof UpdateRadarEvents>(event: E, listener: (payload: UpdateRadarEvents[E]) => void | Promise<void>): Disposer;
  /** Runs `handler` before every install. Registering an id again replaces it. */
  beforeInstall(id: string, handler: BeforeInstallHandler): Disposer;
  /** Adds entries to the menu of every plugin row. Registering an id again replaces it. */
  rowActions(id: string, provider: RowActionsProvider): Disposer;
  /** Holds updates back. Registering an id again replaces it. Call `refresh()` after your rules change. */
  holds(id: string, provider: HoldProvider): Disposer;
  /** The GitHub release `version` of `repo` (cached), or null. */
  release(repo: string, version: string): Promise<ReleaseNotes | null>;
  /** Skips exactly that version of the plugin, as the "Ignore this version" button does. */
  ignore(id: string, version: string): Promise<void>;
  /** True while a check or an install is running. */
  busy(): boolean;
  /** Draws the list again from the last check, with your holds applied. No network. */
  refresh(): void;
}

export const API_VERSION = 1;

/** Longest a `beforeInstall` handler may take before Update Radar goes on without it. */
export const BEFORE_INSTALL_TIMEOUT_MS = 20_000;

/** The timer calls the registry uses, passed in so Obsidian's code can use `window` timers and the tests Node's. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** What the registry needs from Update Radar to build the object other plugins get. */
export interface ApiHost {
  reports(): readonly ReportSummary[];
  release(repo: string, version: string): Promise<ReleaseNotes | null>;
  ignore(id: string, version: string): Promise<void>;
  busy(): boolean;
  refresh(): void;
}

export interface Extensions {
  on: UpdateRadarApiV1['on'];
  beforeInstall: UpdateRadarApiV1['beforeInstall'];
  rowActions: UpdateRadarApiV1['rowActions'];
  holds: UpdateRadarApiV1['holds'];
  emit<E extends keyof UpdateRadarEvents>(event: E, payload: UpdateRadarEvents[E]): void;
  /**
   * Runs the handlers in the order they were registered, one at a time. The first
   * veto wins and stops the rest. Resolves to the veto and who registered it, or null.
   */
  runBefore(intent: InstallIntent): Promise<{ owner: string; reason: string } | null>;
  /** The hold on a plugin, or null. The first provider that returns one wins; one that throws counts as none. */
  holdFor(query: HoldQuery): Hold | null;
  /** The entries for a row's menu, from every provider. A provider that throws adds nothing. */
  actionsFor(row: RowInfo): RowAction[];
  /** True when some provider could add entries to a row. */
  hasRowActions(): boolean;
  /** Drops every handler and listener. Later registrations do nothing. */
  close(): void;
  /** The frozen object other plugins get. */
  api(host: ApiHost): UpdateRadarApiV1;
}

type Listener = (payload: unknown) => void | Promise<void>;

const NO_OP: Disposer = () => {};

function requireId(id: unknown, what: string): void {
  if (typeof id !== 'string' || id === '') throw new TypeError(`update-radar: ${what} needs a non-empty id`);
}

function requireFunction(fn: unknown, what: string): void {
  if (typeof fn !== 'function') throw new TypeError(`update-radar: ${what} needs a function`);
}

const isVeto = (value: unknown): value is Veto => typeof value === 'object' && value !== null && (value as Partial<Veto>).veto === true;

const copy = <T extends object>(value: T): T => Object.freeze({ ...value });

/**
 * The registry behind `api`: pure, so it is tested without Obsidian. `log`
 * receives errors extensions throw; `timers` runs the cap, `timeoutMs`, for one
 * `beforeInstall` handler.
 */
export function createExtensions(log: (message: string, error: unknown) => void, timers: Timers, timeoutMs: number = BEFORE_INSTALL_TIMEOUT_MS): Extensions {
  const before = new Map<string, BeforeInstallHandler>();
  const rows = new Map<string, RowActionsProvider>();
  const holdProviders = new Map<string, HoldProvider>();
  const listeners = new Map<string, Set<Listener>>();
  const logged = new Set<string>();
  let closed = false;

  const logOnce = (key: string, message: string, error: unknown) => {
    if (logged.has(key)) return;
    logged.add(key);
    log(message, error);
  };

  const register = <T>(map: Map<string, T>, id: string, value: T): Disposer => {
    map.set(id, value);
    return () => {
      if (map.get(id) === value) map.delete(id);
    };
  };

  const on: Extensions['on'] = (event, listener) => {
    requireFunction(listener, 'on');
    if (closed) return NO_OP;
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    const entry: Listener = listener;
    set.add(entry);
    return () => {
      listeners.get(event)?.delete(entry);
    };
  };

  const beforeInstall: Extensions['beforeInstall'] = (id, handler) => {
    requireId(id, 'beforeInstall');
    requireFunction(handler, 'beforeInstall');
    return closed ? NO_OP : register(before, id, handler);
  };

  const rowActions: Extensions['rowActions'] = (id, provider) => {
    requireId(id, 'rowActions');
    requireFunction(provider, 'rowActions');
    return closed ? NO_OP : register(rows, id, provider);
  };

  const holds: Extensions['holds'] = (id, provider) => {
    requireId(id, 'holds');
    requireFunction(provider, 'holds');
    return closed ? NO_OP : register(holdProviders, id, provider);
  };

  /** One handler, capped at `timeoutMs`; never rejects. */
  const runOne = async (id: string, handler: BeforeInstallHandler, intent: InstallIntent): Promise<Veto | null> => {
    let timer: unknown;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = timers.set(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => handler(intent)), timeout]);
      if (outcome === 'timeout') {
        log(`update-radar: extension "${id}" took more than ${Math.round(timeoutMs / 1000)} s before an install; going on without it`, null);
        return null;
      }
      return isVeto(outcome) ? outcome : null;
    } catch (error) {
      log(`update-radar: extension "${id}" failed before an install`, error);
      return null;
    } finally {
      if (timer !== undefined) timers.clear(timer);
    }
  };

  const runBefore: Extensions['runBefore'] = async (intent) => {
    for (const [id, handler] of [...before]) {
      const veto = await runOne(id, handler, intent);
      if (veto) return { owner: id, reason: typeof veto.reason === 'string' ? veto.reason : '' };
    }
    return null;
  };

  const holdFor: Extensions['holdFor'] = (query) => {
    for (const [id, provider] of holdProviders) {
      let hold: Hold | null | undefined;
      try {
        hold = provider(query);
      } catch (error) {
        logOnce(`hold:${id}`, `update-radar: extension "${id}" failed while holding an update`, error);
        continue;
      }
      if (hold !== null && hold !== undefined) {
        const h = hold as Partial<Hold>;
        return { owner: typeof h.owner === 'string' && h.owner !== '' ? h.owner : id, label: typeof h.label === 'string' ? h.label : '' };
      }
    }
    return null;
  };

  const actionsFor: Extensions['actionsFor'] = (row) => {
    const out: RowAction[] = [];
    for (const [id, provider] of rows) {
      try {
        for (const action of provider(copy(row)) ?? []) {
          if (action && typeof action.label === 'string' && action.label !== '' && typeof action.run === 'function') out.push(action);
        }
      } catch (error) {
        logOnce(`row:${id}`, `update-radar: extension "${id}" failed while listing row actions`, error);
      }
    }
    return out;
  };

  const emit: Extensions['emit'] = (event, payload) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      const failed = (error: unknown) => log(`update-radar: a "${event}" listener failed`, error);
      try {
        const result = listener(payload);
        if (result && typeof result.then === 'function') result.then(undefined, failed);
      } catch (error) {
        failed(error);
      }
    }
  };

  return {
    on,
    beforeInstall,
    rowActions,
    holds,
    emit,
    runBefore,
    holdFor,
    actionsFor,
    hasRowActions: () => rows.size > 0,
    close() {
      closed = true;
      before.clear();
      rows.clear();
      holdProviders.clear();
      listeners.clear();
    },
    api: (host) => {
      const api: UpdateRadarApiV1 = {
        apiVersion: API_VERSION,
        reports: () => (closed ? [] : host.reports()),
        on,
        beforeInstall,
        rowActions,
        holds,
        release: (repo, version) => (closed ? Promise.resolve(null) : host.release(repo, version)),
        ignore: (id, version) => (closed ? Promise.resolve() : host.ignore(id, version)),
        busy: () => (closed ? false : host.busy()),
        refresh: () => {
          if (!closed) host.refresh();
        },
      };
      return Object.freeze(api);
    },
  };
}
