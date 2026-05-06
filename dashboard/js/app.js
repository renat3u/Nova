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
    // 初始获取压力覆盖状态（延迟确保 apiClient 就绪）
    setTimeout(() => this._panels.pressure?.fetchOverrides(this.apiClient), 500);
    // 加载配置并同步设置面板
    setTimeout(() => this._loadConfigToSettings(), 800);
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

    // 启动 Core 按钮
    const startCoreBtn = document.getElementById('btn-start-core');
    if (startCoreBtn) {
      startCoreBtn.addEventListener('click', async () => {
        try {
          const res = await this.apiClient.startCore();
          if (res.code === 0 && res.data.started) {
            this._panels.chat?.addSystemMessage('[系统] Core 已启动');
          }
        } catch (err) {
          alert('启动失败: ' + (err.message || String(err)));
        }
      });
    }

    // 停止 Core 按钮
    const stopCoreBtn = document.getElementById('btn-stop-core');
    if (stopCoreBtn) {
      stopCoreBtn.addEventListener('click', async () => {
        if (!confirm('确定要停止 Core 吗？不会清除数据，可以随时重新启动。')) return;
        try {
          const res = await this.apiClient.stopCore();
          if (res.code === 0 && res.data.stopped) {
            this._panels.chat?.addSystemMessage('[系统] Core 已停止');
          }
        } catch (err) {
          alert('停止失败: ' + (err.message || String(err)));
        }
      });
    }

    // 自动停止 tick 输入框
    const autoStopInput = document.getElementById('input-auto-stop-tick');
    if (autoStopInput) {
      autoStopInput.addEventListener('change', async () => {
        const value = Math.max(0, parseInt(autoStopInput.value, 10) || 0);
        autoStopInput.value = value;
        try {
          await this.apiClient.updateConfig({ autoStopAfterTick: value });
        } catch (err) {
          console.warn('更新自动停止配置失败:', err);
        }
      });
    }

    // 重置压力覆盖按钮
    const resetKappasBtn = document.getElementById('btn-reset-kappas');
    if (resetKappasBtn) {
      resetKappasBtn.addEventListener('click', async () => {
        if (!confirm('确定重置所有压力值为自动计算吗？')) return;
        try {
          const resetPatch = { p1: null, p2: null, p3: null, p4: null, p5: null, p6: null, p7: null, p8: null };
          const res = await this.apiClient.updatePressureOverrides(resetPatch);
          if (res && res.code === 0) {
            await this._panels.pressure?.fetchOverrides(this.apiClient);
          }
        } catch (err) {
          console.warn('重置压力覆盖失败:', err);
        }
      });
    }
  }

  async _loadConfigToSettings() {
    try {
      const res = await this.apiClient.getConfig();
      if (res.code === 0 && res.data) {
        // 同步 proactive 开关
        const proactiveCheckbox = document.getElementById('setting-proactive');
        if (proactiveCheckbox) {
          proactiveCheckbox.checked = res.data.proactiveEnabled === true;
          proactiveCheckbox.addEventListener('change', async () => {
            try {
              await this.apiClient.updateConfig({ proactiveEnabled: proactiveCheckbox.checked });
            } catch (err) {
              console.warn('更新 proactive 配置失败:', err);
            }
          });
        }
        // 同步 autoStopAfterTick
        const autoStopInput = document.getElementById('input-auto-stop-tick');
        if (autoStopInput && res.data.autoStopAfterTick != null) {
          autoStopInput.value = res.data.autoStopAfterTick;
        }
      }
    } catch (err) {
      console.warn('加载配置失败:', err);
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
        // 重新加载压力覆盖（reset 会重建 runtime）
        setTimeout(() => this._panels.pressure?.fetchOverrides(this.apiClient), 1000);
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
      this._updateCoreButtonStates(msg.data);
    });

    this.wsClient.on('tick_trace', (msg) => {
      // 将实时 trace 插入已有列表的最前面
      if (msg.data && this._panels.traces) {
        this._panels.traces.prependTrace(msg.data);
      }
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

  _updateCoreButtonStates(status) {
    const startBtn = document.getElementById('btn-start-core');
    const stopBtn = document.getElementById('btn-stop-core');
    if (startBtn) startBtn.disabled = status.online;
    if (stopBtn) stopBtn.disabled = !status.online;
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
        this._updateCoreButtonStates(statusRes.data);
      }

      const pressureRes = await this.apiClient.getPressure(200);
      if (pressureRes.code === 0) {
        this._panels.pressure.updateHistory(pressureRes.data);
      }

      const tracesRes = await this.apiClient.getTickTraces(50);
      if (tracesRes.code === 0) {
        this._panels.traces.update(tracesRes.data);
      }

      // Task 4: 使用新 trace API 获取动作追溯
      const actionTracesRes = await this.apiClient.getActionTraces(100);
      if (actionTracesRes.code === 0) {
        this._panels.actions.update(actionTracesRes.data);
      }

      // Task 4: 获取 deliberation 摘要
      const delibRes = await this.apiClient.getDeliberationTraces(50);
      if (delibRes.code === 0 && delibRes.data) {
        this._renderDeliberations(delibRes.data);
      }

      // 系统性能
      const sysRes = await this.apiClient.getSystem();
      if (sysRes.code === 0) {
        this._panels.status.updateSystem(sysRes.data);
      }

      // Task 3: 自动停止倒计时
      try {
        const autoStopRes = await this.apiClient.getAutoStop();
        if (autoStopRes.code === 0) {
          const d = autoStopRes.data;
          const statusEl = document.getElementById('auto-stop-status');
          if (statusEl) {
            if (d.autoStopAfterTick > 0 && d.currentTick > 0) {
              statusEl.textContent = `(${d.remaining} tick 后停止)`;
            } else if (d.autoStopAfterTick > 0 && d.currentTick === 0) {
              statusEl.textContent = '(等待启动…)';
            } else {
              statusEl.textContent = '';
            }
          }
        }
      } catch { /* ignore */ }

      // 定期刷新压力覆盖状态（频率低，每 30s 一次）
      if (this._pollCount == null) this._pollCount = 0;
      this._pollCount++;
      if (this._pollCount % 6 === 0) {
        await this._panels.pressure?.fetchOverrides(this.apiClient);
      }

      if (this._panels.logs) {
        this._panels.logs.fetch();
      }
    } catch (err) {
      console.warn('轮询失败:', err);
    }
  }

  _renderDeliberations(data) {
    const container = document.getElementById('deliberation-list');
    if (!container) return;
    let html = '';
    for (const d of data.slice(0, 20)) {
      const actionOrSilence = d.actionSummary ?? d.silenceSummary ?? '—';
      const actionClass = d.actionSummary ? 'delib-action' : 'delib-silence';
      const memoryTag = d.memoryWritten ? ' <span class="delib-memory">M</span>' : '';
      const moodTag = d.selfMoodBefore != null && d.selfMoodAfter != null
        ? ` <span class="delib-mood">${d.selfMoodBefore.toFixed(2)}→${d.selfMoodAfter.toFixed(2)}</span>`
        : '';
      const afterward = d.afterward ? ` [${d.afterward}]` : '';

      html += `<div class="deliberation-item">`;
      html += `<span class="delib-tick">#${d.tick}</span>`;
      html += `<span class="${actionClass}">${this._escHtml(actionOrSilence)}</span>`;
      html += `${memoryTag}${moodTag}${afterward}`;
      html += `</div>`;
    }
    if (html === '') {
      html = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无审议记录</div>';
    }
    container.innerHTML = html;
  }

  _escHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
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
