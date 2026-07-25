import type { SessionSource } from '../../types/session.js';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export type AgentProvider = SessionSource | 'cursor' | 'opencode';
export type SessionSurface = 'app' | 'cli';

export interface AgentSessionRef {
  provider: AgentProvider;
  sessionId: string;
  /** Distinguishes Cursor editor conversations from Cursor Agent CLI sessions. */
  surface?: SessionSurface;
  title?: string;
  parentSessionId?: string;
  /** Provider-marked worker transcript rather than a user-owned top-level chat. */
  isInternal?: boolean;
  isSubagent?: boolean;
}

export interface HandoffTranscriptEntry {
  /** Hidden provider system/developer prompts must never be projected here. */
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: string;
}

export interface HandoffWorkspaceInput {
  cwd: string;
  projectName?: string;
  recordedBranch?: string;
  recordedModel?: string;
  recordedVersion?: string;
}

export interface CreateHandoffInput {
  source: AgentSessionRef;
  workspace: HandoffWorkspaceInput;
  objective?: string;
  currentState?: string;
  recentTranscript?: readonly HandoffTranscriptEntry[];
  relevantFiles?: readonly string[];
  nextActions?: readonly string[];
  /**
   * Aside's side-chat is a separate conversation. It is never merged unless
   * the caller deliberately supplies it here after the user opts in.
   */
  asideSideChat?: readonly HandoffTranscriptEntry[];
  maxTranscriptEntries?: number;
  maxEntryCharacters?: number;
}

export interface GitSnapshot {
  available: boolean;
  repositoryRoot?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedFiles: string[];
  error?: string;
}

export interface HandoffRedactionReport {
  fieldsChanged: number;
  truncatedEntries: number;
  omittedTranscriptEntries: number;
}

export interface HandoffBundle {
  schema: 'aside.agent-handoff';
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  createdAt: string;
  source: AgentSessionRef;
  workspace: HandoffWorkspaceInput & {
    git: GitSnapshot;
  };
  objective: string;
  currentState: string;
  recentTranscript: HandoffTranscriptEntry[];
  relevantFiles: string[];
  nextActions: string[];
  asideSideChat?: HandoffTranscriptEntry[];
  provenance: {
    generatedBy: 'Aside';
    sourceUnchanged: true;
    transcriptIsExcerpt: true;
    hiddenProviderStateIncluded: false;
  };
  redaction: HandoffRedactionReport;
}

export type CapabilityTransport =
  | 'deep-link'
  | 'cli'
  | 'open-workspace'
  | 'unavailable';

export interface AgentTargetCapability {
  provider: AgentProvider;
  installed: boolean;
  applicationPath?: string;
  executablePath?: string;
  /**
   * Exact means the destination owns the original session ID. This is only
   * valid for a session created by that same provider.
   */
  nativeResume: {
    available: boolean;
    transport: CapabilityTransport;
    note?: string;
  };
  /**
   * Creates a destination-owned session initialized from a sanitized Aside
   * handoff. `contextCarried` is false for Cursor's GUI-only fallback.
   */
  crossProviderContinue: {
    available: boolean;
    transport: CapabilityTransport;
    contextCarried: boolean;
    promptBehavior: 'prefilled' | 'submitted-after-confirmation' | 'none';
    note?: string;
  };
  richImport: {
    available: boolean;
    experimental: boolean;
    note: string;
  };
}

export interface AgentCapabilities {
  codex: AgentTargetCapability;
  claude: AgentTargetCapability;
  cursor: AgentTargetCapability;
  opencode: AgentTargetCapability;
}

export interface AgentLaunchPlan {
  optionId: AgentLaunchOptionId;
  source: AgentSessionRef;
  target: Exclude<AgentProvider, 'pi'>;
  targetSurface?: SessionSurface;
  mode: 'resume' | 'continue';
  available: boolean;
  requiresHandoff: boolean;
  requiresConfirmation: true;
  contextCarried: boolean;
  summary: string;
  warning?: string;
}

export type AgentLaunchOptionId =
  | 'resume:codex'
  | 'resume:claude'
  | 'resume:cursor-agent'
  | 'resume:opencode'
  | 'continue:codex'
  | 'continue:claude'
  | 'continue:cursor-agent'
  | 'open:cursor-project'
  | 'continue:opencode';

export type AgentLaunchOptionKind = 'resume' | 'continue' | 'open-project';

/**
 * Stable, presentation-ready actions. These map directly to the menubar's
 * Open-in IPC contract without exposing executable paths or transcript files
 * to the renderer.
 */
export interface AgentLaunchOption {
  id: AgentLaunchOptionId;
  target: Exclude<AgentProvider, 'pi'>;
  targetSurface: SessionSurface;
  label: string;
  kind: AgentLaunchOptionKind;
  available: boolean;
  detail?: string;
  unavailableReason?: string;
}

export type LaunchIntent =
  | {
      kind: 'deep-link';
      provider: AgentProvider;
      url: string;
      cwd: string;
      requiresConfirmation: true;
      promptBehavior: 'prefilled' | 'none';
      capsulePath?: string;
    }
  | {
      kind: 'cli';
      provider: AgentProvider;
      executable: string;
      args: string[];
      cwd: string;
      requiresConfirmation: true;
      promptBehavior: 'submitted-after-confirmation' | 'none';
      capsulePath?: string;
    }
  | {
      kind: 'open-workspace';
      provider: 'cursor';
      applicationPath: string;
      cwd: string;
      requiresConfirmation: true;
      promptBehavior: 'none';
      contextCarried: false;
      capsulePath?: string;
    };

export interface ConfirmedAgentLaunch {
  plan: AgentLaunchPlan;
  intent: LaunchIntent;
  /**
   * A marker the Electron main process can require before invoking its launch
   * adapter. This module intentionally never starts a process on its own.
   */
  userConfirmed: true;
}
