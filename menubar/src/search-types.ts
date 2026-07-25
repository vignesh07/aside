import type { SessionSource } from '../../dist/types/session.js';

export interface IndexableThread {
  sessionId: string;
  source: SessionSource;
  jsonlPath: string;
  projectName: string;
  projectPath: string;
  title: string;
  gitBranch: string;
  lastEventMs: number;
}

export interface IndexableSideChatTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface IndexableSideChat {
  sessionId: string;
  source: SessionSource;
  updatedAt: string;
  turns: IndexableSideChatTurn[];
}

export type SearchMatchKind =
  | 'metadata'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'side_user'
  | 'side_assistant';

export interface SearchSnippetPart {
  text: string;
  match: boolean;
}

export interface ThreadSearchResult {
  sessionId: string;
  source: SessionSource;
  kind: SearchMatchKind;
  snippet: SearchSnippetPart[];
  score: number;
}

export type SearchIndexPhase =
  | 'starting'
  | 'indexing'
  | 'optimizing'
  | 'ready'
  | 'error';

export interface SearchIndexStatus {
  phase: SearchIndexPhase;
  indexedThreads: number;
  totalThreads: number;
  indexedBytes: number;
  totalBytes: number;
  message?: string;
}

export interface ThreadSearchService {
  syncSessions(sessions: IndexableThread[]): void;
  syncSideChats(chats: IndexableSideChat[]): void;
  search(query: string, limit?: number): Promise<ThreadSearchResult[]>;
  rebuild(): void;
  getStatus(): SearchIndexStatus;
  onStatus(listener: () => void): () => void;
  dispose(): void;
}
