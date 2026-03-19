'use strict';

// =============================================================================
// Minimal stubs for PluginInterface + AgentInterface
// =============================================================================
// These implement the minimum contract needed by ClaudeAgent to extend
// AgentInterface without depending on the host framework.
// =============================================================================

export class PluginInterface {
  constructor(context) {
    this._context = context || null;
  }
}

export class AgentInterface extends PluginInterface {
  // Static metadata — subclasses MUST override
  static pluginId     = null;
  static featureName  = null;
  static displayName  = null;
  static description  = null;
  static agentType    = null;

  // Model registry stubs — override in plugins
  static getModels() { return []; }
  // eslint-disable-next-line no-unused-vars
  estimateTokens(text, _options) { return Math.ceil((text || '').length / 4); }

  async execute(params) {
    return this._createGenerator(params);
  }

  async *_createGenerator(_params) {
    throw new Error(`${this.constructor.name}._createGenerator() not implemented`);
  }

  getSystemPrompt(agent, _context) {
    let parts = [];

    parts.push('You are a helpful assistant.');

    if (agent && agent.instructions)
      parts.push(agent.instructions);

    return parts.join('\n\n');
  }

  assembleMessages(messages, _systemPrompt) {
    return messages;
  }

  validateConfig(agent) {
    let errors = [];

    if (!agent || !agent.name)
      errors.push('Agent must have a name');

    if (!agent || !agent.pluginID)
      errors.push('Agent must have a pluginID');

    if (errors.length > 0)
      return { valid: false, errors };

    return { valid: true };
  }

  getCapabilities() {
    return {
      streaming:  false,
      toolCalls:  false,
      reflection: false,
      images:     false,
    };
  }
}
