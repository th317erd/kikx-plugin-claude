'use strict';

// =============================================================================
// kikx-plugin-claude — Anthropic Claude API integration (SDK version)
// =============================================================================
// Implements AgentInterface using the official @anthropic-ai/sdk.
//
// Yield protocol:
//   { type: 'message',    content: { html } }
//   { type: 'tool-call',  content: { toolName, arguments, toolUseId } }
//   { type: 'reflection', content: { text }, hidden: true }
//   { type: 'done',       content: { usage: { inputTokens, outputTokens } } }
//
// Two-channel architecture:
//   1. Structured tool calls → server orchestration (tool_use blocks)
//   2. Inline HTML           → user display (text blocks)
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL           = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS      = 16000;
const DEFAULT_THINKING_BUDGET = 10000;

const HTML_INSTRUCTION = [
  'Output your responses in HTML format.',
  'Use standard HTML tags for formatting (p, strong, em, code, pre, ul, ol, li, h1-h6, table, etc).',
  'Do not use markdown.',
].join(' ');

// Claude API tool names must match [a-zA-Z0-9_-]{1,64} — no colons.
// Our tool names use pluginId:featureName convention, so we encode/decode.
function encodeToolName(name) {
  return name.replace(/:/g, '__');
}

function decodeToolName(name) {
  return name.replace(/__/g, ':');
}

// =============================================================================
// Plugin setup() — registers ClaudeAgent with the plugin registry
// =============================================================================

export function setup(pluginContext) {
  let { context, AgentInterface, registerAgentType } = pluginContext;

  if (!AgentInterface)
    throw new Error('kikx-plugin-claude requires AgentInterface in plugin context');

  class ClaudeAgent extends AgentInterface {
    // Static metadata
    static pluginId    = 'claude-agent';
    static featureName = 'chat';
    static displayName = 'Claude';
    static description = 'Anthropic Claude AI agent';
    static agentType   = 'claude';
    static serviceType = 'anthropic';

    // ---------------------------------------------------------------------------
    // Capabilities
    // ---------------------------------------------------------------------------

    getCapabilities() {
      return {
        streaming:  true,
        toolCalls:  true,
        reflection: true,
        images:     false,
      };
    }

    // ---------------------------------------------------------------------------
    // System prompt — HTML output instruction + agent instructions
    // ---------------------------------------------------------------------------

    getSystemPrompt(agent, _context) {
      let parts = [];

      parts.push('You are a helpful assistant.');
      parts.push(HTML_INSTRUCTION);

      if (agent && agent.instructions)
        parts.push(agent.instructions);

      return parts.join('\n\n');
    }

    // ---------------------------------------------------------------------------
    // Message assembly — convert internal frames to Anthropic format
    // ---------------------------------------------------------------------------

    assembleMessages(messages, _systemPrompt) {
      if (!messages || messages.length === 0)
        return [];

      let assembled = [];

      for (let msg of messages) {
        let converted = this._convertMessage(msg);

        if (converted)
          assembled.push(converted);
      }

      return this._enforceAlternation(assembled);
    }

    _convertMessage(msg) {
      if (msg.role)
        return { role: msg.role, content: msg.content };

      switch (msg.type) {
        case 'message':
          return {
            role:    (msg.authorType === 'agent') ? 'assistant' : 'user',
            content: (msg.content && msg.content.html) || (msg.content && msg.content.text) || '',
          };

        case 'tool-call':
          return {
            role:    'assistant',
            content: [{
              type:  'tool_use',
              id:    (msg.content && (msg.content.toolUseID || msg.content.toolUseId)) || `tool_${Date.now()}`,
              name:  encodeToolName(msg.content && msg.content.toolName || ''),
              input: (msg.content && msg.content.arguments) || {},
            }],
          };

        case 'tool-result': {
          let output     = (msg.content && msg.content.output) || '';
          let resultText = (typeof output === 'string') ? output : JSON.stringify(output);

          return {
            role:    'user',
            content: [{
              type:        'tool_result',
              tool_use_id: (msg.content && (msg.content.toolUseID || msg.content.toolUseId)) || '',
              content:     resultText,
            }],
          };
        }

        case 'reflection':
          return null;

        default:
          return null;
      }
    }

    _enforceAlternation(messages) {
      if (messages.length <= 1)
        return messages;

      let result = [messages[0]];

      for (let i = 1; i < messages.length; i++) {
        let current  = messages[i];
        let previous = result[result.length - 1];

        if (current.role === previous.role) {
          if (typeof previous.content === 'string' && typeof current.content === 'string') {
            previous.content = previous.content + '\n\n' + current.content;
          } else {
            let prevArray = Array.isArray(previous.content)
              ? previous.content
              : [{ type: 'text', text: previous.content }];

            let currArray = Array.isArray(current.content)
              ? current.content
              : [{ type: 'text', text: current.content }];

            previous.content = prevArray.concat(currArray);
          }
        } else {
          result.push(current);
        }
      }

      return result;
    }

    // ---------------------------------------------------------------------------
    // Config validation
    // ---------------------------------------------------------------------------

    validateConfig(agent) {
      let baseResult = super.validateConfig(agent);

      if (!baseResult.valid)
        return baseResult;

      let errors = [];

      if (!agent.encryptedAPIKey)
        errors.push('Agent must have an encryptedAPIKey');

      if (errors.length > 0)
        return { valid: false, errors };

      return { valid: true };
    }

    // ---------------------------------------------------------------------------
    // Generator — main workhorse (SDK-based)
    // ---------------------------------------------------------------------------

    async *_createGenerator(params) {
      let { messages: rawMessages, agent, session, context: executionContext } = params;

      // Resolve API key — check params, then agent (pre-decrypted by controller),
      // then fall back to decrypting encryptedAPIKey
      let apiKey = params.apiKey || (agent && agent.apiKey);

      if (!apiKey && agent && agent.encryptedAPIKey && executionContext) {
        let keystore = executionContext.getProperty
          ? executionContext.getProperty('keystore')
          : (executionContext.keystore || null);

        if (keystore) {
          let decrypted = keystore.decrypt(
            (typeof agent.encryptedAPIKey === 'string')
              ? JSON.parse(agent.encryptedAPIKey)
              : agent.encryptedAPIKey,
          );

          apiKey = decrypted.toString('utf8');
        }
      }

      if (!apiKey)
        throw new Error('No API key available — provide apiKey in params or encrypted key on agent');

      let systemPrompt = this.getSystemPrompt(agent, executionContext);
      let apiMessages  = this.assembleMessages(rawMessages, systemPrompt);

      let model          = (agent && agent.model) || DEFAULT_MODEL;
      let maxTokens      = (agent && agent.maxTokens) || DEFAULT_MAX_TOKENS;
      let thinkingBudget = (agent && agent.thinkingBudget) || DEFAULT_THINKING_BUDGET;

      // Build tool definitions from the plugin registry
      let tools = this._buildToolDefinitions(executionContext);

      let client = this._createClient(apiKey);

      let totalInputTokens              = 0;
      let totalOutputTokens             = 0;
      let totalCacheReadInputTokens     = 0;
      let totalCacheCreationInputTokens = 0;

      while (true) {
        let pendingToolCalls = [];
        let hadToolCalls     = false;

        let stream = await this._createStream(client, systemPrompt, apiMessages, { model, maxTokens, tools, thinkingBudget });

        let currentBlocks = new Map();

        for await (let event of stream) {
          if (event.type === 'message_start') {
            if (event.message && event.message.usage) {
              totalInputTokens              += event.message.usage.input_tokens || 0;
              totalCacheReadInputTokens     += event.message.usage.cache_read_input_tokens || 0;
              totalCacheCreationInputTokens += event.message.usage.cache_creation_input_tokens || 0;
            }

            // Yield partial usage so interrupted interactions still report tokens
            yield {
              type:    'usage',
              content: {
                usage: {
                  inputTokens:              totalInputTokens,
                  outputTokens:             totalOutputTokens,
                  cacheReadInputTokens:     totalCacheReadInputTokens,
                  cacheCreationInputTokens: totalCacheCreationInputTokens,
                },
              },
            };

            continue;
          }

          if (event.type === 'content_block_start') {
            let block = event.content_block || {};
            let entry = { type: block.type, data: '' };

            if (block.type === 'tool_use') {
              entry.id   = block.id;
              entry.name = decodeToolName(block.name);
            }

            currentBlocks.set(event.index, entry);
            continue;
          }

          if (event.type === 'content_block_delta') {
            let block = currentBlocks.get(event.index);

            if (!block)
              continue;

            let delta = event.delta || {};

            if (delta.type === 'text_delta') {
              block.data += delta.text || '';

              yield {
                type:       'delta',
                content:    { text: delta.text || '' },
                authorType: 'agent',
                authorID:   (agent && agent.id) || null,
              };
            } else if (delta.type === 'input_json_delta') {
              block.data += delta.partial_json || '';
            } else if (delta.type === 'thinking_delta') {
              block.data += delta.thinking || '';

              yield {
                type:       'reflection-delta',
                content:    { text: delta.thinking || '' },
                authorType: 'agent',
                authorID:   (agent && agent.id) || null,
              };
            }

            continue;
          }

          if (event.type === 'content_block_stop') {
            let block = currentBlocks.get(event.index);

            if (!block)
              continue;

            if (block.type === 'text') {
              yield {
                type:       'message',
                content:    { html: block.data },
                authorType: 'agent',
                authorID:   (agent && agent.id) || null,
              };
            } else if (block.type === 'tool_use') {
              hadToolCalls = true;

              let toolArguments = {};

              try {
                if (block.data)
                  toolArguments = JSON.parse(block.data);
              } catch (_e) {
                toolArguments = { _raw: block.data };
              }

              let toolCall = {
                type:       'tool-call',
                content:    {
                  toolName:  block.name,
                  arguments: toolArguments,
                  toolUseId: block.id,
                },
                authorType: 'agent',
                authorID:   (agent && agent.id) || null,
              };

              pendingToolCalls.push(toolCall);

              let result = yield toolCall;

              if (result)
                pendingToolCalls[pendingToolCalls.length - 1].result = result;
            } else if (block.type === 'thinking') {
              yield {
                type:       'reflection',
                content:    { text: block.data },
                hidden:     true,
                authorType: 'agent',
                authorID:   (agent && agent.id) || null,
              };
            }

            currentBlocks.delete(event.index);
            continue;
          }

          if (event.type === 'message_delta') {
            if (event.usage)
              totalOutputTokens += event.usage.output_tokens || 0;

            // Yield updated usage with output tokens
            yield {
              type:    'usage',
              content: {
                usage: {
                  inputTokens:              totalInputTokens,
                  outputTokens:             totalOutputTokens,
                  cacheReadInputTokens:     totalCacheReadInputTokens,
                  cacheCreationInputTokens: totalCacheCreationInputTokens,
                },
              },
            };

            continue;
          }
        }

        if (hadToolCalls && pendingToolCalls.length > 0) {
          let toolUseBlocks = pendingToolCalls.map((tc) => ({
            type:  'tool_use',
            id:    tc.content.toolUseId,
            name:  encodeToolName(tc.content.toolName),
            input: tc.content.arguments,
          }));

          apiMessages.push({ role: 'assistant', content: toolUseBlocks });

          let toolResultBlocks = pendingToolCalls.map((tc) => {
            let output = (tc.result && tc.result.content && tc.result.content.output) || '';
            let content = (typeof output === 'string') ? output : JSON.stringify(output);

            return {
              type:        'tool_result',
              tool_use_id: tc.content.toolUseId,
              content,
            };
          });

          apiMessages.push({ role: 'user', content: toolResultBlocks });

          continue;
        }

        break;
      }

      yield {
        type:    'done',
        content: {
          usage: {
            inputTokens:              totalInputTokens,
            outputTokens:             totalOutputTokens,
            cacheReadInputTokens:     totalCacheReadInputTokens,
            cacheCreationInputTokens: totalCacheCreationInputTokens,
          },
        },
      };
    }

    // ---------------------------------------------------------------------------
    // Build tool definitions from plugin registry for the Claude API
    // ---------------------------------------------------------------------------

    _buildToolDefinitions(executionContext) {
      if (!executionContext || !executionContext.getProperty)
        return [];

      let registry = executionContext.getProperty('pluginRegistry');
      if (!registry)
        return [];

      let tools     = registry.getTools();
      let apiTools  = [];

      for (let [name, ToolClass] of tools) {
        let schema = ToolClass.inputSchema || {
          type:       'object',
          properties: {},
        };

        apiTools.push({
          name:         encodeToolName(name),
          description:  ToolClass.description || name,
          input_schema: schema,
        });
      }

      return apiTools;
    }

    // ---------------------------------------------------------------------------
    // SDK Client Factory (overridable for testing)
    // ---------------------------------------------------------------------------

    _createClient(apiKey) {
      return new Anthropic({ apiKey });
    }

    // ---------------------------------------------------------------------------
    // SDK Stream Factory (overridable for testing)
    // ---------------------------------------------------------------------------

    async *_createStream(client, systemPrompt, messages, options = {}) {
      let { model, maxTokens, tools, thinkingBudget } = options;

      let effectiveMaxTokens = maxTokens || DEFAULT_MAX_TOKENS;
      let effectiveBudget    = thinkingBudget || DEFAULT_THINKING_BUDGET;

      // budget_tokens must be less than max_tokens
      if (effectiveBudget >= effectiveMaxTokens)
        effectiveBudget = Math.floor(effectiveMaxTokens * 0.6);

      let requestParams = {
        model:      model || DEFAULT_MODEL,
        max_tokens: effectiveMaxTokens,
        thinking:   { type: 'enabled', budget_tokens: effectiveBudget },
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      };

      if (tools && tools.length > 0)
        requestParams.tools = tools;

      let stream = client.messages.stream(requestParams);

      for await (let event of stream)
        yield event;
    }
  }

  registerAgentType('claude', ClaudeAgent);

  return () => {};  // teardown
}
