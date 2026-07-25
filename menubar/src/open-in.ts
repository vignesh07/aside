import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  confirmAgentLaunch,
  createHandoffBundle,
  detectAgentCapabilities,
  listAgentLaunchOptions,
  planAgentLaunchOption,
  readHandoffTranscript,
} from '../../dist/core/handoff/index.js';
import type {
  AgentCapabilities,
  AgentLaunchOptionId,
  AgentSessionRef,
  CapsuleOptions,
  LaunchIntent,
} from '../../dist/core/handoff/index.js';
import type { ChatTurn } from '../../dist/types/chat.js';
import type { TrackedSession } from '../../dist/types/session.js';

export type OpenInTarget = 'codex' | 'claude' | 'cursor' | 'opencode';
export type OpenInOptionKind = 'resume' | 'continue' | 'open-project' | 'import';

export interface OpenInOption {
  id: string;
  target: OpenInTarget;
  label: string;
  available: boolean;
  kind: OpenInOptionKind;
  detail?: string;
  unavailableReason?: string;
}

export interface OpenInOptionsState {
  threadId: string;
  source: TrackedSession['source'];
  title?: string;
  projectPath?: string;
  options: OpenInOption[];
  defaultIncludeSideChat: boolean;
}

export interface OpenInThreadRequest {
  threadId: string;
  optionId: string;
  includeSideChat: boolean;
}

export interface OpenInResult {
  ok: boolean;
  message?: string;
}

export interface OpenInSessionContext {
  session: TrackedSession;
  sideChat: ChatTurn[];
}

export interface OpenInLaunchHost {
  execute(intent: LaunchIntent): Promise<void>;
}

export interface OpenInControllerOptions {
  detectCapabilities?: () => Promise<AgentCapabilities>;
  capsule?: CapsuleOptions;
}

type SessionResolver = (threadId: string) => OpenInSessionContext | null;

const OPTION_IDS = new Set<AgentLaunchOptionId>([
  'resume:codex',
  'resume:claude',
  'resume:cursor-agent',
  'resume:opencode',
  'continue:codex',
  'continue:claude',
  'continue:cursor-agent',
  'open:cursor-project',
  'continue:opencode',
]);

const PROVIDER_STORE_PARTS = [
  ['.codex', 'sessions'],
  ['.claude', 'projects'],
  ['.pi', 'agent', 'sessions'],
] as const;

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A transcript directory is not a project. Only launch from a real, absolute,
 * recorded cwd and reject known provider-owned session stores.
 */
export function launchWorkspaceForSession(
  session: TrackedSession,
  home = os.homedir(),
): string | null {
  const raw = session.cwd.trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  const candidate = path.resolve(raw);
  try {
    if (!fs.statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  if (
    PROVIDER_STORE_PARTS.some((parts) =>
      isInside(candidate, path.join(home, ...parts)),
    )
  ) {
    return null;
  }
  return candidate;
}

function sourceRef(session: TrackedSession): AgentSessionRef {
  return {
    provider: session.source,
    sessionId: session.id,
    ...(session.title ? { title: session.title } : {}),
    ...(session.parentSessionId
      ? { parentSessionId: session.parentSessionId }
      : {}),
    ...(session.isInternal ? { isSubagent: true } : {}),
  };
}

function sideChatEntries(turns: ChatTurn[]) {
  return turns.map((turn) => ({
    role: turn.role,
    text: turn.content,
    timestamp: turn.timestamp.toISOString(),
  }));
}

function asOptionId(value: string): AgentLaunchOptionId | null {
  return OPTION_IDS.has(value as AgentLaunchOptionId)
    ? (value as AgentLaunchOptionId)
    : null;
}

function launchMessage(intent: LaunchIntent, mode: 'resume' | 'continue'): string {
  const display = {
    codex: 'Codex',
    claude: 'Claude Code',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    pi: 'Pi',
  }[intent.provider];
  if (intent.kind === 'open-workspace') {
    return 'Opened the project in Cursor. No conversation was transferred.';
  }
  if (mode === 'resume') return `Opened the original thread in ${display}.`;
  if (intent.promptBehavior === 'prefilled') {
    return `Opened ${display} with the handoff ready to review and send.`;
  }
  return `Started a new ${display} session with the private handoff.`;
}

/**
 * Capability-aware Open-in orchestration.
 *
 * All sensitive state remains here in Electron main. The renderer receives
 * only presentation-ready actions and sends back one stable option id.
 */
export class OpenInController {
  private readonly detectCapabilities: () => Promise<AgentCapabilities>;
  private readonly capsule?: CapsuleOptions;

  constructor(
    private readonly resolveSession: SessionResolver,
    private readonly host: OpenInLaunchHost,
    options: OpenInControllerOptions = {},
  ) {
    this.detectCapabilities =
      options.detectCapabilities ?? (() => detectAgentCapabilities());
    this.capsule = options.capsule;
  }

  async getOptions(threadId: string): Promise<OpenInOptionsState> {
    const context = this.resolveSession(threadId);
    if (!context) throw new Error('That thread is no longer available.');
    const { session } = context;
    const capabilities = await this.detectCapabilities();
    const workspace = launchWorkspaceForSession(session);
    const workspaceError =
      'Aside could not verify the original project folder for this thread.';
    const options = listAgentLaunchOptions({
      source: sourceRef(session),
      capabilities,
    }).map((option): OpenInOption => ({
      id: option.id,
      target: option.target,
      label: option.label,
      kind: option.kind,
      available: option.available && Boolean(workspace),
      ...(option.detail ? { detail: option.detail } : {}),
      ...(!workspace
        ? { unavailableReason: workspaceError }
        : option.unavailableReason
          ? { unavailableReason: option.unavailableReason }
          : {}),
    }));

    return {
      threadId,
      source: session.source,
      ...(session.title ? { title: session.title } : {}),
      ...(workspace ? { projectPath: workspace } : {}),
      options,
      // Side chat is a separate conversation and must be deliberately opted in.
      defaultIncludeSideChat: false,
    };
  }

  async open(request: OpenInThreadRequest): Promise<OpenInResult> {
    const context = this.resolveSession(request.threadId);
    if (!context) return { ok: false, message: 'That thread is no longer available.' };
    const optionId = asOptionId(request.optionId);
    if (!optionId) return { ok: false, message: 'That destination is not supported.' };
    const workspace = launchWorkspaceForSession(context.session);
    if (!workspace) {
      return {
        ok: false,
        message: 'Aside could not verify the original project folder.',
      };
    }

    const capabilities = await this.detectCapabilities();
    const source = sourceRef(context.session);
    const listed = listAgentLaunchOptions({ source, capabilities });
    const option = listed.find((candidate) => candidate.id === optionId);
    if (!option?.available) {
      return {
        ok: false,
        message:
          option?.unavailableReason ??
          'That destination is no longer available.',
      };
    }
    const plan = planAgentLaunchOption({ source, optionId, capabilities });

    const recentTranscript = plan.requiresHandoff
      ? readHandoffTranscript(
          context.session.source,
          context.session.jsonlPath,
        )
      : [];
    const handoff = plan.requiresHandoff
      ? await createHandoffBundle({
          source,
          workspace: {
            cwd: workspace,
            projectName: context.session.projectName,
            recordedBranch: context.session.gitBranch,
            recordedModel: context.session.model,
            recordedVersion: context.session.version,
          },
          ...(context.session.title
            ? { objective: context.session.title }
            : {}),
          ...(context.session.currentActivity
            ? { currentState: context.session.currentActivity }
            : {}),
          recentTranscript,
          ...(request.includeSideChat
            ? { asideSideChat: sideChatEntries(context.sideChat) }
            : {}),
        })
      : undefined;

    const confirmed = await confirmAgentLaunch({
      plan,
      capabilities,
      cwd: workspace,
      ...(handoff ? { handoff } : {}),
      userConfirmed: true,
      ...(this.capsule ? { capsule: this.capsule } : {}),
    });
    try {
      await this.host.execute(confirmed.intent);
    } catch (error) {
      if (confirmed.intent.capsulePath) {
        await fs.promises
          .unlink(confirmed.intent.capsulePath)
          .catch(() => undefined);
      }
      throw error;
    }
    return {
      ok: true,
      message: launchMessage(confirmed.intent, plan.mode),
    };
  }
}
