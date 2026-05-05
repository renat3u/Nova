/**
 * ChatPanel — 聊天界面：气泡、输入、打字动画、localStorage 持久化、沉默系统消息。
 */
class ChatPanel {
  constructor(msgContainer, inputEl, sendBtn, clearBtn, app) {
    this.msgContainer = msgContainer;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    this.clearBtn = clearBtn;
    this.app = app;
    this.messages = [];
    this.thinking = false;
    this.thinkingEl = null;

    this.loadMessages();
    this.bindEvents();
  }

  bindEvents() {
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.clearBtn.addEventListener('click', () => {
      if (confirm('确定要清除所有聊天记录吗？')) {
        this.clearMessages();
      }
    });
  }

  sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    if (!this.app.wsClient.isConnected) {
      this.addSystemMessage('[系统] 未连接，正在重连...');
      this.app.reconnectWS();
      return;
    }

    this.addMessage('user', text);
    this.inputEl.value = '';

    this.app.wsClient.send({ type: 'chat_message', text });
  }

  addMessage(sender, text) {
    const msg = { sender, text, time: Date.now() };
    this.messages.push(msg);
    this.saveMessages();
    this.renderMessage(msg);
    this.scrollToBottom();
  }

  addNovaMessage(text, actionId) {
    this.removeThinking();
    this.addMessage('nova', text);
  }

  addSystemMessage(text) {
    this.renderMessage({ sender: 'system', text, time: Date.now() });
    this.scrollToBottom();
  }

  setThinking(active) {
    if (active && !this.thinking) {
      this.thinking = true;
      this.showThinking();
    } else if (!active && this.thinking) {
      this.thinking = false;
      this.removeThinking();
    }
  }

  showThinking() {
    if (this.thinkingEl) return;
    this.thinkingEl = document.createElement('div');
    this.thinkingEl.className = 'msg nova';
    this.thinkingEl.innerHTML = `
      <span class="msg-sender">Nova</span>
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
    `;
    this.msgContainer.appendChild(this.thinkingEl);
    this.scrollToBottom();
  }

  removeThinking() {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
    this.thinking = false;
  }

  renderMessage(msg) {
    const emptyEl = this.msgContainer.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    const el = document.createElement('div');
    el.className = `msg ${msg.sender}`;

    const time = new Date(msg.time).toLocaleTimeString();

    if (msg.sender === 'system') {
      el.innerHTML = `<div class="msg-bubble">${this._esc(msg.text)}</div>`;
    } else if (msg.sender === 'user') {
      el.innerHTML = `
        <div class="msg-bubble">${this._esc(msg.text)}</div>
        ${this._showTimestamps() ? `<div class="msg-time">${time}</div>` : ''}
      `;
    } else {
      el.innerHTML = `
        <span class="msg-sender">Nova</span>
        <div class="msg-bubble">${this._esc(msg.text)}</div>
        ${this._showTimestamps() ? `<div class="msg-time">${time}</div>` : ''}
      `;
    }

    this.msgContainer.appendChild(el);
  }

  renderAll() {
    this.msgContainer.innerHTML = '';
    if (this.messages.length === 0) {
      this.msgContainer.innerHTML = '<div class="chat-empty">开始和 Nova 聊天吧...</div>';
      return;
    }
    for (const msg of this.messages) {
      this.renderMessage(msg);
    }
    this.scrollToBottom();
  }

  scrollToBottom() {
    if (!this._autoScrollEnabled()) return;
    requestAnimationFrame(() => {
      this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
    });
  }

  clearMessages() {
    this.messages = [];
    this.removeThinking();
    this.saveMessages();
    this.msgContainer.innerHTML = '<div class="chat-empty">开始和 Nova 聊天吧...</div>';
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  loadMessages() {
    try {
      const raw = localStorage.getItem('nova_chat_messages');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.messages = parsed.filter((m) => m.sender && m.text && m.time);
        }
      }
    } catch {
      this.messages = [];
    }
    this.renderAll();
  }

  saveMessages() {
    try {
      const toSave = this.messages.slice(-200);
      localStorage.setItem('nova_chat_messages', JSON.stringify(toSave));
    } catch {
      // localStorage 满或不可用
    }
  }

  _showTimestamps() {
    return localStorage.getItem('nova_show_timestamps') !== 'false';
  }

  _autoScrollEnabled() {
    return localStorage.getItem('nova_autoscroll') !== 'false';
  }

  _esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}
