/**
 * StatusPanel — 显示 Nova 运行状态 + 系统性能指标。
 */
class StatusPanel {
  constructor(container) {
    this.container = container;
    this.container.innerHTML = `
      <div class="status-card"><div class="value" id="stat-online">—</div><div class="label">状态</div></div>
      <div class="status-card"><div class="value" id="stat-processed">0</div><div class="label">已处理</div></div>
      <div class="status-card"><div class="value" id="stat-sent">0</div><div class="label">已发送</div></div>
      <div class="status-card"><div class="value" id="stat-silence">0</div><div class="label">沉默</div></div>
      <div class="status-card"><div class="value" id="stat-tick">—</div><div class="label">Tick</div></div>
      <div class="status-card"><div class="value" id="stat-api">—</div><div class="label">API</div></div>
      <div class="status-card"><div class="value" id="stat-queue">0</div><div class="label">队列</div></div>
      <div class="status-card"><div class="value" id="stat-tick-interval">—</div><div class="label">Tick间隔</div></div>
      <div class="status-card"><div class="value" id="stat-cpu">—</div><div class="label">CPU 负载</div></div>
      <div class="status-card"><div class="value" id="stat-mem">—</div><div class="label">内存</div></div>
      <div class="status-card"><div class="value" id="stat-heap">—</div><div class="label">堆内存</div></div>
      <div class="status-card"><div class="value" id="stat-uptime">—</div><div class="label">运行时长</div></div>
    `;
  }

  update(status) {
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setVal('stat-online', status.online ? '● 在线' : '○ 离线');
    const onlineEl = document.getElementById('stat-online');
    if (onlineEl) onlineEl.style.color = status.online ? 'var(--success)' : 'var(--text-muted)';

    setVal('stat-processed', status.processedMessages ?? 0);
    setVal('stat-sent', status.sentActions ?? 0);
    setVal('stat-silence', status.silenceCount ?? 0);

    if (status.lastTickAt) {
      setVal('stat-tick', new Date(status.lastTickAt).toLocaleTimeString());
    } else {
      setVal('stat-tick', '—');
    }

    if (status.lastPressure) {
      setVal('stat-api', (status.lastPressure.api ?? 0).toFixed(2));
    } else {
      setVal('stat-api', '—');
    }

    setVal('stat-queue', status.queue?.pending ?? '0');

    // Task 6.7: 显示 tick 间隔（如果有）
    if (status.tickIntervalMs != null) {
      const secs = (status.tickIntervalMs / 1000).toFixed(1);
      setVal('stat-tick-interval', secs + 's');
      const intervalEl = document.getElementById('stat-tick-interval');
      if (intervalEl) {
        if (status.tickIntervalMs > 60000) intervalEl.style.color = 'var(--warning)';
        else if (status.tickIntervalMs > 300000) intervalEl.style.color = 'var(--danger)';
        else intervalEl.style.color = '';
      }
    } else {
      setVal('stat-tick-interval', '—');
    }
  }

  /** 更新系统性能指标 */
  updateSystem(sys) {
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    if (sys.loadAvg1m !== undefined) {
      const load = sys.loadAvg1m;
      setVal('stat-cpu', load.toFixed(1));
      const cpuEl = document.getElementById('stat-cpu');
      if (cpuEl) {
        const cpuCount = sys.cpus || 1;
        if (load > cpuCount * 0.8) cpuEl.style.color = 'var(--danger)';
        else if (load > cpuCount * 0.5) cpuEl.style.color = 'var(--warning)';
        else cpuEl.style.color = 'var(--success)';
      }
    }

    if (sys.memoryUsagePct !== undefined) {
      const pct = sys.memoryUsagePct;
      setVal('stat-mem', pct.toFixed(0) + '%');
      const memEl = document.getElementById('stat-mem');
      if (memEl) {
        if (pct > 80) memEl.style.color = 'var(--danger)';
        else if (pct > 60) memEl.style.color = 'var(--warning)';
        else memEl.style.color = '';
      }
    }

    if (sys.processHeapMB !== undefined) {
      setVal('stat-heap', sys.processHeapMB + ' MB');
    }

    if (sys.processUptime !== undefined) {
      const secs = sys.processUptime;
      if (secs < 3600) setVal('stat-uptime', Math.floor(secs / 60) + ' 分');
      else if (secs < 86400) setVal('stat-uptime', (secs / 3600).toFixed(1) + ' 时');
      else setVal('stat-uptime', (secs / 86400).toFixed(1) + ' 天');
    }
  }
}
