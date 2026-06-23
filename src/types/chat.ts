/** A single turn in the side chat (not the watched session). */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Set on an assistant turn that failed, so the UI can surface the error. */
  error?: boolean;
}
