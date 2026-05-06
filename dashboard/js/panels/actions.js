/**
 * ActionsPanel — 动作时间线，对接新 Trace API (NovaActionTrace)。
 */
class ActionsPanel {
  constructor(container) {
    this.container = container;
    this.actions = [];
  }

  update(actions) {
    if (!actions || actions.length === 0) {
      this.container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无动作记录</div>';
      return;
    }
    this.actions = actions;
    this.render();
  }

  render() {
    let html = '';
    const items = this.actions.slice(0, 50);

    for (const trace of items) {
      const time = new Date(trace.createdMs).toLocaleTimeString();
      const actionType = trace.actionType || 'unknown';

      let dotClass = 'silence';
      if (trace.status === 'success') dotClass = 'send_text';
      else if (trace.status === 'failed') dotClass = 'silence';
      else if (actionType === 'proactive' || actionType === 'proactive_enqueued') dotClass = 'proactive';

      let desc = `${actionType} → ${this._shortTarget(trace.targetId)}`;
      if (trace.voice) desc += ` [${trace.voice}]`;

      html += `<div class="action-item">`;
      html += `<div class="action-dot ${dotClass}"></div>`;
      html += `<div class="action-time">${time}</div>`;
      html += `<div class="action-desc">`;
      html += `<div>${this._esc(desc)}</div>`;
      if (trace.text) {
        const preview = trace.text.length > 80 ? trace.text.slice(0, 80) + '…' : trace.text;
        html += `<div class="action-text-preview">${this._esc(preview)}</div>`;
      }
      if (trace.reasoning) {
        const reasonPreview = trace.reasoning.length > 100 ? trace.reasoning.slice(0, 100) + '…' : trace.reasoning;
        html += `<div class="action-reason">💭 ${this._esc(reasonPreview)}</div>`;
      }
      if (trace.engagementOutcome) {
        html += `<div class="action-outcome">结果: ${this._esc(trace.engagementOutcome)}</div>`;
      }
      if (trace.llmStateWritebackSummary) {
        const s = trace.llmStateWritebackSummary;
        html += `<div class="action-writeback">写回: +${s.acceptedCount}/-${s.rejectedCount}</div>`;
      }
      if (trace.error) {
        html += `<div class="action-outcome" style="color:var(--danger)">错误: ${this._esc(trace.error)}</div>`;
      }
      html += `</div></div>`;
    }

    this.container.innerHTML = html;
  }

  _shortTarget(id) {
    if (!id) return '未知';
    if (id.length <= 20) return id;
    return id.slice(0, 18) + '…';
  }

  _esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}
