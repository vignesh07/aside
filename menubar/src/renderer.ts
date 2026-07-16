// Renderer for the menubar dropdown. Runs in the browser context and talks to
// the main process only through the `window.aside` bridge from preload.cjs.

import type { MenubarState } from './backend.js';

interface AsideBridge {
  getState(): Promise<MenubarState>;
  selectSession(id: string): Promise<void>;
  ask(question: string): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  onUpdate(callback: (state: MenubarState) => void): () => void;
}

declare global {
  interface Window {
    aside: AsideBridge;
  }
}

const sessionsEl = document.getElementById('sessions') as HTMLSelectElement;
const messagesEl = document.getElementById('messages') as HTMLDivElement;
const formEl = document.getElementById('composer') as HTMLFormElement;
const inputEl = document.getElementById('input') as HTMLInputElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;

/** Human duration for roster labels: "4s", "12m", "3h", "2d". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function render(state: MenubarState): void {
  // Session dropdown — a focus lens, not a chat scope. Only rebuilt when the
  // labels actually change, to avoid clobbering an open dropdown. Idle time is
  // in the key because it's in the label.
  const optionsKey = state.sessions
    .map((s) => `${s.id}:${s.status}:${formatDuration(s.idleForMs)}`)
    .join('|');
  if (sessionsEl.dataset['key'] !== optionsKey) {
    sessionsEl.dataset['key'] = optionsKey;
    sessionsEl.innerHTML = '';
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.source} · ${s.projectName} — ${s.status}, quiet ${formatDuration(s.idleForMs)}`;
      sessionsEl.appendChild(opt);
    }
  }
  if (state.focusId) sessionsEl.value = state.focusId;

  // The chat is never gated on a selection: "nothing is running" is a valid
  // answer to a valid question.
  inputEl.disabled = false;
  sendEl.disabled = state.thinking;

  // Messages.
  messagesEl.innerHTML = '';
  if (state.messages.length === 0 && !state.thinking) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      state.sessions.length > 0
        ? `Watching ${state.sessions.length} agent session${state.sessions.length === 1 ? '' : 's'}. Ask "what's running?", "why did it do that?", "is anything stuck?" — they never see this chat.`
        : 'No agent sessions found yet. aside will pick them up as they start.';
    messagesEl.appendChild(empty);
  }
  for (const turn of state.messages) {
    const div = document.createElement('div');
    div.className = `turn ${turn.role}${turn.error ? ' error' : ''}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = turn.role === 'user' ? 'you' : 'aside';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = turn.content;
    div.append(who, body);
    messagesEl.appendChild(div);
  }
  if (state.thinking) {
    const t = document.createElement('div');
    t.className = 'thinking';
    t.textContent = 'aside is thinking…';
    messagesEl.appendChild(t);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

sessionsEl.addEventListener('change', () => {
  void window.aside.selectSession(sessionsEl.value);
});

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = inputEl.value.trim();
  if (!question) return;
  inputEl.value = '';
  void window.aside.ask(question);
});

window.aside.onUpdate(render);
void window.aside.getState().then(render);
