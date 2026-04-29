import type {
  NapCatPluginContext,
  PluginConfigSchema,
  PluginConfigUIController,
  PluginModule,
} from './types';
import { buildConfigSchema } from './config';
import { handleMessage } from './handlers/message-handler';
import { registerApiRoutes } from './services/api-service';
import { novaPluginState } from './state';
import type { NovaPluginConfig } from './types';

export let plugin_config_ui: PluginConfigSchema = [];

export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
  try {
    plugin_config_ui = buildConfigSchema(ctx);
    registerApiRoutes(ctx);
    await novaPluginState.init(ctx);
    ctx.logger.info('Nova initialized');
  } catch (error) {
    ctx.logger.error('Nova initialization failed:', error);
    throw error;
  }
};

export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
  try {
    await novaPluginState.cleanup();
    ctx.logger.info('Nova cleaned up');
  } catch (error) {
    ctx.logger.warn('Nova cleanup failed:', error);
  }
};

export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
  try {
    if (event.post_type !== 'message') return;
    if (!novaPluginState.config.enabled) return;
    await handleMessage(ctx, event);
  } catch (error) {
    ctx.logger.error('Nova message bridge failed:', error);
  }
};

export const plugin_onevent: PluginModule['plugin_onevent'] = async () => {
  return undefined;
};

export const plugin_get_config: PluginModule<never, NovaPluginConfig>['plugin_get_config'] = async () => {
  return novaPluginState.config;
};

export const plugin_set_config: PluginModule<never, NovaPluginConfig>['plugin_set_config'] = async (ctx, config) => {
  novaPluginState.replaceConfig(config);
  ctx.logger.info('Nova config updated');
};

export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
  ctx: NapCatPluginContext,
  _ui: PluginConfigUIController,
  key: string,
  value: unknown,
  _currentConfig: Record<string, unknown>,
) => {
  novaPluginState.updateConfig({ [key]: parseReactiveConfigValue(key, value) });
  ctx.logger.debug(`Nova config field updated: ${key}`);
};

function parseReactiveConfigValue(key: string, value: unknown): unknown {
  if (key !== 'enabledGroups' || typeof value !== 'string') return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
