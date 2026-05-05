/**
 * NovaWSClient — WebSocket 连接管理，支持自动重连。
 */
class NovaWSClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this._currentDelay = 1000;
    this._intentionalClose = false;
  }

  connect() {
    this._intentionalClose = false;

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.warn('WS 连接失败:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._currentDelay = this.reconnectDelay;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const handler = this.handlers.get(msg.type);
        if (handler) {
          handler(msg);
        }
      } catch (err) {
        console.warn('WS 消息解析失败:', err);
      }
    };

    this.ws.onclose = () => {
      if (!this._intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose 会紧随其后触发
    };
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  off(type) {
    this.handlers.delete(type);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close() {
    this._intentionalClose = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  reconnect() {
    this.close();
    this._currentDelay = this.reconnectDelay;
    this.connect();
  }

  scheduleReconnect() {
    const delay = this._currentDelay;
    this._currentDelay = Math.min(this._currentDelay * 1.5, this.maxReconnectDelay);
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
