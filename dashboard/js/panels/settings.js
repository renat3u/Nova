/**
 * SettingsPanel — 用户身份、外观、数据管理。
 */
class SettingsPanel {
  constructor(app) {
    this.app = app;

    // 初始值（userId 收到 session_init 后由 app.js 更新）
    document.getElementById('setting-userid').textContent = app.userId || '等待分配...';
    document.getElementById('setting-theme').value = app.theme;
    document.getElementById('setting-timestamps').checked = localStorage.getItem('nova_show_timestamps') !== 'false';
    document.getElementById('setting-autoscroll').checked = localStorage.getItem('nova_autoscroll') !== 'false';

    // log 自动滚动默认开启
    const logScroll = localStorage.getItem('nova_autoscroll_log');
    document.getElementById('setting-autoscroll-log').checked = logScroll !== 'false';

    this.bindEvents();
  }

  bindEvents() {
    const usernameInput = document.getElementById('setting-username');
    usernameInput.addEventListener('change', () => {
      const name = usernameInput.value.trim();
      if (name && name !== this.app.username) {
        this.app.updateUsername(name);
      }
    });
    usernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        usernameInput.blur();
      }
    });

    document.getElementById('setting-theme').addEventListener('change', (e) => {
      const newTheme = e.target.value;
      if (newTheme !== this.app.theme) {
        this.app.toggleTheme();
      }
    });

    document.getElementById('setting-timestamps').addEventListener('change', (e) => {
      localStorage.setItem('nova_show_timestamps', e.target.checked.toString());
    });

    document.getElementById('setting-autoscroll').addEventListener('change', (e) => {
      localStorage.setItem('nova_autoscroll', e.target.checked.toString());
    });

    document.getElementById('setting-autoscroll-log').addEventListener('change', (e) => {
      localStorage.setItem('nova_autoscroll_log', e.target.checked.toString());
    });

    document.getElementById('btn-clear-history').addEventListener('click', () => {
      if (confirm('确定删除所有聊天记录？')) {
        this.app._panels.chat.clearMessages();
      }
    });
  }
}
