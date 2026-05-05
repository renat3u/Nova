/**
 * NovaDashboard — 主控制器。
 * 初始化所有面板、管理导航、主题、全局状态。
 */
class NovaDashboard {
  constructor() {
    this.wsClient = new NovaWSClient(`ws://${location.host}`);
    this.apiClient = new NovaApiClient();
    // userId 由服务端 session_init 消息分配，不从 localStorage 读取
    this.userId = null;
    this.username = localStorage.getItem('nova_username') || '';
    this.theme = localStorage.getItem('nova_theme') || 'light';
    this._panels = {};
  }

  async init() {
    this.applyTheme();
    this.initNavigation();
    this.initPanels();
    this.connectWS();
    this.startPolling();
  }

  applyTheme() {
    document.documentElement.setAttribute('data-theme', this.theme);
    document.getElementById('btn-theme').textContent = this.theme === 'dark' ? '☀' : '🌙';
    const select = document.getElementById('setting-theme');
    if (select) select.value = this.theme;
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nova_theme', this.theme);
    this.applyTheme();
  }

  // ── 导航 ────────────────────────────────────────────────────────────────

  initNavigation() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panelName = btn.dataset.panel;
        this.showPanel(panelName);
      });
    });

    document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-settings-nav').addEventListener('click', () => this.showPanel('settings'));

    // 新会话按钮
    const newSessionBtn = document.getElementById('btn-new-session');
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', () => this.resetSession());
    }
  }

  async resetSession() {
    if (!confirm('确定要开始新会话吗？\n\n这会删除当前所有记忆和对话历史，以全新身份与 Nova 重新开始。')) {
      return;
    }

    try {
      const res = await this.apiClient.resetSession();
      if (res.code === 0) {
        this.userId = res.data.userId;
        this.username = res.data.username;
        document.getElementById('setting-userid').textContent = this.userId;
        document.getElementById('setting-username').value = this.username;
        localStorage.removeItem('nova_username');
        // 清空前端聊天记录
        this._panels.chat.clearMessages();
        this._panels.logs.clear();
        // 重连 WS（使用新 userId）
        this.reconnectWS();
      } else {
        alert('重置失败: ' + (res.message || '未知错误'));
      }
    } catch (err) {
      alert('重置失败: ' + (err.message || String(err)));
    }
  }

  showPanel(name) {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));

    const navBtn = document.querySelector(`.nav-btn[data-panel="${name}"]`);
    if (navBtn) navBtn.classList.add('active');

    const panel = document.getElementById(`panel-${name}`);
    if (panel) panel.classList.add('active');

    if (name === 'dashboard' && this._panels.pressure) {
      setTimeout(() => this._panels.pressure.resize(), 100);
    }
  }

  // ── 面板 ────────────────────────────────────────────────────────────────

  initPanels() {
    this._panels.status = new StatusPanel(document.getElementById('status-bar'));
    this._panels.pressure = new PressurePanel(
      document.getElementById('pressure-params'),
      document.getElementById('chart-pressure-timeline'),
      document.querySelector('.time-range-selector'),
    );
    this._panels.traces = new TracesPanel(
      document.getElementById('trace-list'),
      this.apiClient,
    );
    this._panels.actions = new ActionsPanel(
      document.getElementById('action-timeline'),
    );
    this._panels.logs = new LogPanel(
      document.getElementById('log-output'),
      this.apiClient,
    );
    this._panels.chat = new ChatPanel(
      document.getElementById('chat-messages'),
      document.getElementById('chat-input'),
      document.getElementById('btn-send'),
      document.getElementById('btn-clear-chat'),
      this,
    );
    this._panels.settings = new SettingsPanel(this);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  connectWS() {
    // 只传 username（如果用户设了），userId 由服务端分配
    const params = [];
    if (this.username) params.push(`username=${encodeURIComponent(this.username)}`);
    this.wsClient.url = `ws://${location.host}${params.length ? '?' + params.join('&') : ''}`;
    this.wsClient.connect();

    this.wsClient.on('session_init', (msg) => {
      this.userId = msg.userId;
      if (!this.username) {
        this.username = msg.username;
      }
      // 更新设置面板
      document.getElementById('setting-userid').textContent = this.userId;
      document.getElementById('setting-username').value = this.username;
    });

    this.wsClient.on('nova_reply', (msg) => {
      this._panels.chat.addNovaMessage(msg.text, msg.actionId);
    });

    this.wsClient.on('nova_silence', (msg) => {
      this._panels.chat.addSystemMessage(`[沉默] ${msg.reason}`);
    });

    this.wsClient.on('nova_thinking', (msg) => {
      this._panels.chat.setThinking(msg.active);
    });

    this.wsClient.on('pressure_snapshot', (msg) => {
      this._panels.pressure.updateRealtime(msg.data);
    });

    this.wsClient.on('status_update', (msg) => {
      this._panels.status.update(msg.data);
      this.updateTopbarStatus(msg.data);
    });

    this.wsClient.on('error', (msg) => {
      console.error('WS 错误:', msg.message);
    });
  }

  reconnectWS() {
    // 重连时带上当前用户名
    const params = [];
    if (this.username) params.push(`username=${encodeURIComponent(this.username)}`);
    this.wsClient.url = `ws://${location.host}${params.length ? '?' + params.join('&') : ''}`;
    this.wsClient.reconnect();
  }

  updateTopbarStatus(status) {
    const el = document.getElementById('topbar-status');
    if (status.online) {
      el.innerHTML = '<span class="status-indicator online"></span> 在线';
    } else {
      el.innerHTML = '<span class="status-indicator offline"></span> 离线';
    }
  }

  // ── 轮询 ────────────────────────────────────────────────────────────────

  startPolling() {
    this._pollInterval = setInterval(() => {
      this.pollData();
    }, 5000);
    this.pollData();
  }

  async pollData() {
    try {
      const statusRes = await this.apiClient.getStatus();
      if (statusRes.code === 0) {
        this._panels.status.update(statusRes.data);
        this.updateTopbarStatus(statusRes.data);
      }

      const pressureRes = await this.apiClient.getPressure(200);
      if (pressureRes.code === 0) {
        this._panels.pressure.updateHistory(pressureRes.data);
      }

      const tracesRes = await this.apiClient.getTickTraces(50);
      if (tracesRes.code === 0) {
        this._panels.traces.update(tracesRes.data);
      }

      const actionsRes = await this.apiClient.getActions(100);
      if (actionsRes.code === 0) {
        this._panels.actions.update(actionsRes.data);
      }

      // 系统性能
      const sysRes = await this.apiClient.getSystem();
      if (sysRes.code === 0) {
        this._panels.status.updateSystem(sysRes.data);
      }

      if (this._panels.logs) {
        this._panels.logs.fetch();
      }
    } catch (err) {
      console.warn('轮询失败:', err);
    }
  }

  // ── 用户身份 ────────────────────────────────────────────────────────────

  updateUsername(name) {
    this.username = name;
    localStorage.setItem('nova_username', name);
    this.reconnectWS();
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.novaApp = new NovaDashboard();
  window.novaApp.init().catch(console.error);
});
