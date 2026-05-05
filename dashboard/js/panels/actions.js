/**
 * ActionsPanel — 动作与沉默时间线。
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

    for (const action of items) {
      const time = new Date(action.createdMs).toLocaleTimeString();
      const actionType = action.actionType || 'unknown';
      let dotClass = 'silence';
      let desc = actionType;

      if (actionType === 'send_text') {
        dotClass = 'send_text';
        desc = `发送 → ${this._shortTarget(action.targetId)}`;
      } else if (actionType === 'proactive_enqueued') {
        dotClass = 'proactive';
        desc = '主动消息入队';
      } else if (actionType === 'silence' || actionType === 'observe' || actionType === 'cool_down' || actionType === 'wait_reply') {
        dotClass = 'silence';
        desc = `${actionType} → ${this._shortTarget(action.targetId)}`;
      }

      html += `<div class="action-item">`;
      html += `<div class="action-dot ${dotClass}"></div>`;
      html += `<div class="action-time">${time}</div>`;
      html += `<div class="action-desc">`;
      html += `<div>${this._esc(desc)}</div>`;
      if (action.text) {
        html += `<div class="action-text-preview">${this._esc(action.text.slice(0, 80))}${action.text.length > 80 ? '…' : ''}</div>`;
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
