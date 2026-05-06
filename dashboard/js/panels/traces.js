/**
 * TracesPanel — 决策追溯列表，可展开查看详情。
 * 展示完整的 tick 审议链路：压力→欲望→声部→候选→门控→决策代理。
 */
class TracesPanel {
  constructor(container, apiClient) {
    this.container = container;
    this.apiClient = apiClient;
    this.traces = [];
    this.expandedTick = null;
  }

  update(traces) {
    if (!traces || traces.length === 0) {
      this.container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无决策记录</div>';
      return;
    }
    this.traces = traces;
    this.render();
  }

  /** 将实时 trace 插入列表头部（WS 推送）。 */
  prependTrace(trace) {
    if (!trace) return;
    // 避免重复
    const exists = this.traces.some((t) => t.tick === trace.tick && t.reason === trace.reason);
    if (exists) return;
    this.traces.unshift(trace);
    if (this.traces.length > 100) this.traces = this.traces.slice(0, 100);
    this.render();
  }

  render() {
    let html = '';
    for (const trace of this.traces.slice(0, 30)) {
      const isExpanded = this.expandedTick === trace.tick;
      const reasonClass = trace.reason === 'message' ? 'message' : 'scheduled';
      const reasonLabel = trace.reason === 'message' ? '消息' : '定时';
      const voice = trace.selectedVoice ?? '?';
      const decision = trace.decisionAgent?.action ?? trace.gateVerdict ?? '?';
      const confidence = trace.decisionAgent?.confidence;

      html += `<div class="trace-item${isExpanded ? ' expanded' : ''}" data-tick="${trace.tick}">`;
      html += `<div class="trace-summary">`;
      html += `<span class="tick-num">#${trace.tick}</span>`;
      html += `<span class="reason-badge ${reasonClass}">${reasonLabel}</span>`;
      html += ` <span>声部: ${voice}</span>`;
      html += ` <span>→ ${decision}</span>`;
      if (confidence !== undefined) {
        html += ` <span style="color:var(--text-muted)">(${(confidence * 100).toFixed(0)}%)</span>`;
      }
      html += `</div>`;

      if (isExpanded) {
        html += `<div class="trace-detail">`;

        // 决策来源标识
        if (trace.decisionAgent) {
          html += `<p><strong>决策来源:</strong> <span style="color:var(--accent)">Decision Agent (LLM)</span></p>`;
        } else {
          html += `<p><strong>决策来源:</strong> <span style="color:var(--text-muted)">Algorithmic Gateway</span></p>`;
        }

        html += `<p><strong>原因:</strong> ${this._esc(trace.decisionAgent?.reason ?? trace.silenceReason ?? trace.gateVerdict ?? '—')}</p>`;
        if (trace.api !== undefined) {
          html += `<p><strong>API:</strong> ${trace.api.toFixed(3)} (峰值: ${(trace.apiPeak ?? 0).toFixed(3)})</p>`;
        }
        if (trace.voiceProbabilities) {
          const probs = Object.entries(trace.voiceProbabilities)
            .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
            .join(', ');
          html += `<p><strong>声部概率:</strong> ${probs}</p>`;
        }
        if (trace.desires && trace.desires.length > 0) {
          html += `<p><strong>欲望 (${trace.desires.length}):</strong> ${trace.desires.map((d) => `${d.type}(${d.urgency})`).join(', ')}</p>`;
        }
        if (trace.candidates && trace.candidates.length > 0) {
          html += `<p><strong>候选 (${trace.candidates.length}):</strong></p><ul>`;
          for (const c of trace.candidates.slice(0, 10)) {
            html += `<li>${c.action} → ${c.targetId ?? '无'} — 分: ${c.selectionScore?.toFixed(4) ?? c.netValue?.toFixed(4) ?? '?'} ${c.bottleneck ? `[${c.bottleneck}]` : ''}</li>`;
          }
          html += `</ul>`;
        }
        if (trace.selectedCandidate) {
          html += `<p><strong>选中:</strong> ${trace.selectedCandidate.action} → ${trace.selectedCandidate.targetId ?? '无'}</p>`;
        }

        // 算法门控审计（Task 4.3）
        if (trace.algorithmicGateAudit && trace.algorithmicGateAudit.length > 0) {
          html += `<p><strong>算法门控审计:</strong></p><ul>`;
          for (const gate of trace.algorithmicGateAudit) {
            const icon = gate.allow ? '✓' : '✗';
            html += `<li>${icon} ${gate.reason} (level: ${gate.level})</li>`;
          }
          html += `</ul>`;
        }

        // 门控判决
        if (trace.gateReasons && trace.gateReasons.length > 0) {
          html += `<p><strong>门控原因:</strong> ${trace.gateReasons.join(', ')}</p>`;
        }

        if (trace.decisionAgent) {
          html += `<p><strong>决策代理:</strong> ${trace.decisionAgent.action ?? '?'} @ ${trace.decisionAgent.model ?? '?'}</p>`;
          if (trace.decisionAgent.tags && trace.decisionAgent.tags.length > 0) {
            html += `<p><strong>标签:</strong> ${trace.decisionAgent.tags.join(', ')}</p>`;
          }
          if (trace.decisionAgent.error) {
            html += `<p style="color:var(--danger)"><strong>错误:</strong> ${this._esc(trace.decisionAgent.error)}</p>`;
          }
        }
        html += `</div>`;
      }

      html += `</div>`;
    }

    this.container.innerHTML = html;

    this.container.querySelectorAll('.trace-item').forEach((el) => {
      el.addEventListener('click', () => {
        const tick = parseInt(el.dataset.tick, 10);
        this.expandedTick = this.expandedTick === tick ? null : tick;
        this.render();
      });
    });
  }

  _esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}
