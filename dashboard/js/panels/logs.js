/**
 * LogPanel — 显示 Nova 运行日志（对应 NapCat 的 log.txt）。
 * 定时拉取 /api/logs，终端风格渲染，按级别着色。
 */
class LogPanel {
  constructor(container, apiClient) {
    this.container = container;
    this.apiClient = apiClient;
    this.maxLines = 500;
    this.allLines = [];
    this.autoScroll = true;
    this._lastContent = '';  // 用于判断是否有新内容

    this.bindClear();
  }

  bindClear() {
    const btn = document.getElementById('btn-clear-log');
    if (btn) {
      btn.addEventListener('click', () => {
        this.allLines = [];
        this._lastContent = '';
        this.container.innerHTML = '<div class="chat-empty">等待日志输出...</div>';
      });
    }

    const checkbox = document.getElementById('setting-autoscroll-log');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        this.autoScroll = checkbox.checked;
        localStorage.setItem('nova_autoscroll_log', checkbox.checked.toString());
      });
      const saved = localStorage.getItem('nova_autoscroll_log');
      if (saved !== null) {
        checkbox.checked = saved === 'true';
        this.autoScroll = saved === 'true';
      }
    }
  }

  async fetch() {
    try {
      const res = await this.apiClient._get('/api/logs', { limit: 300 });
      if (res.code === 0 && Array.isArray(res.data)) {
        this.update(res.data);
      }
    } catch (err) {
      // 端点尚未就绪
    }
  }

  update(lines) {
    if (lines.length === 0) return;

    // 用最后一条的时间戳+消息做指纹，相同则跳过
    const last = lines[lines.length - 1];
    const fingerprint = `${last?.ts ?? ''}|${last?.message ?? ''}`;
    if (fingerprint === this._lastContent && lines.length === this.allLines.length) {
      return; // 没有新内容
    }
    this._lastContent = fingerprint;

    this.allLines = lines.slice(-this.maxLines);
    this.render();
  }

  render() {
    if (this.allLines.length === 0) {
      this.container.innerHTML = '<div class="chat-empty">等待日志输出...</div>';
      return;
    }

    const wasAtBottom = this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 20;

    let html = '';
    for (const line of this.allLines) {
      const level = line.level ?? 'debug';
      const ts = line.ts ? new Date(line.ts).toLocaleTimeString() : '';
      const msg = this._esc(line.message ?? '');
      let argsStr = '';
      if (line.args && line.args.length > 0) {
        argsStr = ' ' + line.args.map((a) => {
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        }).join(' ');
      }

      html += `<div class="log-line ${level}">`;
      html += `<span class="log-ts">${ts}</span>`;
      html += `<span class="log-level">[${level.toUpperCase()}]</span>`;
      html += `<span class="log-msg">${msg}</span>`;
      if (argsStr) html += `<span class="log-args">${this._esc(argsStr)}</span>`;
      html += `</div>`;
    }

    this.container.innerHTML = html;

    // 如果之前在底部，保持在底部
    if (wasAtBottom || this.autoScroll) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  clear() {
    this.allLines = [];
    this._lastContent = '';
    this.container.innerHTML = '<div class="chat-empty">等待日志输出...</div>';
  }

  _esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}
