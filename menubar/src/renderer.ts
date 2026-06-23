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

let lastSelectedId: string | null = null;

function render(state: MenubarState): void {
  // Session dropdown — only rebuild when the option set changes, to avoid
  // clobbering an in-progress selection.
  const optionsKey = state.sessions.map((s) => `${s.id}:${s.status}`).join('|');
  if (sessionsEl.dataset['key'] !== optionsKey) {
    sessionsEl.dataset['key'] = optionsKey;
    sessionsEl.innerHTML = '';
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.source} · ${s.projectName} (${s.status})`;
      sessionsEl.appendChild(opt);
    }
  }
  if (state.selectedId) sessionsEl.value = state.selectedId;
  lastSelectedId = state.selectedId;

  const canChat = Boolean(state.selectedId) && !state.thinking;
  inputEl.disabled = !state.selectedId;
  sendEl.disabled = !canChat;

  // Messages.
  messagesEl.innerHTML = '';
  if (state.messages.length === 0 && !state.thinking) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.selectedId
      ? "Ask anything about the session you're watching. This chat stays on the side — the main agent never sees it."
      : 'No active sessions found yet.';
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
  if (!question || !lastSelectedId) return;
  inputEl.value = '';
  void window.aside.ask(question);
});

window.aside.onUpdate(render);
void window.aside.getState().then(render);
