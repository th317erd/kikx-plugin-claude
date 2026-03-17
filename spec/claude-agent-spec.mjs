'use strict';

import { describe, it, before } from 'node:test';
import assert                    from 'node:assert/strict';

import { setup }                          from '../index.mjs';
import { AgentInterface, PluginInterface } from './helpers/agent-interface-stub.mjs';

// =============================================================================
// Helpers
// =============================================================================

function getClaudeAgent() {
  let registered = {};
  let context    = {
    getProperty: () => null,
    setProperty: () => {},
  };

  setup({
    context,
    AgentInterface,
    registerAgentType: (id, AgentClass) => { registered[id] = AgentClass; },
  });

  return registered.claude;
}

function createMockEvents(overrides = {}) {
  let {
    text       = '<p>Hello, world!</p>',
    toolCalls  = [],
    thinking   = null,
    inputTokens  = 100,
    outputTokens = 42,
  } = overrides;

  let events = [];

  events.push({
    type:    'message_start',
    message: {
      id:    'msg_mock_123',
      type:  'message',
      role:  'assistant',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  let index = 0;

  if (thinking) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  if (text) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  for (let tc of toolCalls) {
    events.push({
      type:          'content_block_start',
      index,
      content_block: { type: 'tool_use', id: tc.id || `toolu_${index}`, name: tc.name },
    });

    events.push({
      type:  'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input || {}) },
    });

    events.push({ type: 'content_block_stop', index });
    index++;
  }

  events.push({
    type:  'message_delta',
    delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: outputTokens },
  });

  events.push({ type: 'message_stop' });

  return events;
}

function createTestableAgent(ClaudeAgent, mockEvents) {
  let agent = new ClaudeAgent(null);

  agent._apiCalls = [];

  agent._createClient = function () {
    return { messages: { stream: () => {} } };
  };

  agent._mockEvents   = mockEvents || [];
  agent._createStream = async function* (_client, systemPrompt, messages, options) {
    this._apiCalls.push({ systemPrompt, messages, options });

    let events = Array.isArray(this._mockEvents[0]) && Array.isArray(this._mockEvents[0])
      ? (this._mockEvents.shift() || [])
      : this._mockEvents;

    for (let event of events)
      yield event;
  };

  return agent;
}

function createMultiTurnAgent(ClaudeAgent, eventSets) {
  let agent = new ClaudeAgent(null);

  agent._apiCalls  = [];
  agent._callIndex = 0;

  agent._createClient = function () {
    return { messages: { stream: () => {} } };
  };

  agent._createStream = async function* (_client, systemPrompt, messages, options) {
    this._apiCalls.push({ systemPrompt, messages, options });
    let events = eventSets[this._callIndex++] || [];

    for (let event of events)
      yield event;
  };

  return agent;
}

function createMockAgent(overrides = {}) {
  return {
    id:              'agent-001',
    name:            'test-claude',
    pluginID:        'claude-agent',
    encryptedAPIKey: 'mock-encrypted-key',
    instructions:    'Be helpful and concise.',
    model:           'claude-sonnet-4-20250514',
    ...overrides,
  };
}

// =============================================================================
// Static Metadata
// =============================================================================

describe('ClaudeAgent - static metadata', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should have pluginId set to "claude-agent"', () => {
    assert.equal(ClaudeAgent.pluginId, 'claude-agent');
  });

  it('should have featureName set to "chat"', () => {
    assert.equal(ClaudeAgent.featureName, 'chat');
  });

  it('should have displayName set to "Claude"', () => {
    assert.equal(ClaudeAgent.displayName, 'Claude');
  });

  it('should have description set correctly', () => {
    assert.equal(ClaudeAgent.description, 'Anthropic Claude AI agent');
  });

  it('should have agentType set to "claude"', () => {
    assert.equal(ClaudeAgent.agentType, 'claude');
  });
});

// =============================================================================
// Class Hierarchy
// =============================================================================

describe('ClaudeAgent - class hierarchy', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should extend AgentInterface', () => {
    assert.ok(ClaudeAgent.prototype instanceof AgentInterface);
  });

  it('should extend PluginInterface (transitively)', () => {
    assert.ok(ClaudeAgent.prototype instanceof PluginInterface);
  });

  it('should create an instance with context', () => {
    let ctx      = { type: 'test' };
    let instance = new ClaudeAgent(ctx);
    assert.ok(instance instanceof ClaudeAgent);
    assert.equal(instance._context, ctx);
  });
});

// =============================================================================
// getCapabilities()
// =============================================================================

describe('ClaudeAgent - getCapabilities()', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should return correct capabilities', () => {
    let instance = new ClaudeAgent(null);

    assert.deepEqual(instance.getCapabilities(), {
      streaming:  true,
      toolCalls:  true,
      reflection: true,
      images:     false,
    });
  });
});

// =============================================================================
// getSystemPrompt()
// =============================================================================

describe('ClaudeAgent - getSystemPrompt()', () => {
  let ClaudeAgent;
  let instance;

  before(() => {
    ClaudeAgent = getClaudeAgent();
    instance    = new ClaudeAgent(null);
  });

  it('should include HTML output instruction', () => {
    let prompt = instance.getSystemPrompt({}, null);
    assert.ok(prompt.includes('Output your responses in HTML format'));
    assert.ok(prompt.includes('Do not use markdown'));
  });

  it('should include base helpful assistant instruction', () => {
    let prompt = instance.getSystemPrompt({}, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
  });

  it('should append agent instructions when present', () => {
    let prompt = instance.getSystemPrompt({ instructions: 'Always speak like a pirate.' }, null);
    assert.ok(prompt.includes('Always speak like a pirate.'));
    assert.ok(prompt.includes('HTML format'));
  });

  it('should handle null agent gracefully', () => {
    let prompt = instance.getSystemPrompt(null, null);
    assert.ok(prompt.includes('You are a helpful assistant.'));
  });
});

// =============================================================================
// validateConfig()
// =============================================================================

describe('ClaudeAgent - validateConfig()', () => {
  let ClaudeAgent;
  let instance;

  before(() => {
    ClaudeAgent = getClaudeAgent();
    instance    = new ClaudeAgent(null);
  });

  it('should return valid for complete agent config', () => {
    assert.deepEqual(instance.validateConfig(createMockAgent()), { valid: true });
  });

  it('should require encryptedAPIKey', () => {
    let result = instance.validateConfig(createMockAgent({ encryptedAPIKey: null }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('encryptedAPIKey')));
  });

  it('should call super.validateConfig (check name)', () => {
    let result = instance.validateConfig({ pluginID: 'claude-agent', encryptedAPIKey: 'key' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('name')));
  });

  it('should fail for null agent', () => {
    let result = instance.validateConfig(null);
    assert.equal(result.valid, false);
  });
});

// =============================================================================
// assembleMessages()
// =============================================================================

describe('ClaudeAgent - assembleMessages()', () => {
  let ClaudeAgent;
  let instance;

  before(() => {
    ClaudeAgent = getClaudeAgent();
    instance    = new ClaudeAgent(null);
  });

  it('should convert user message frames to Anthropic format', () => {
    let messages = [{
      type: 'message', content: { html: '<p>Hello</p>' }, authorType: 'user', authorID: 'user-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, '<p>Hello</p>');
  });

  it('should convert agent message frames to assistant role', () => {
    let messages = [{
      type: 'message', content: { html: '<p>Hi there</p>' }, authorType: 'agent', authorID: 'agent-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result[0].role, 'assistant');
  });

  it('should skip reflection frames', () => {
    let messages = [{
      type: 'reflection', content: { text: 'thinking...' }, hidden: true, authorType: 'agent', authorID: 'agent-1',
    }];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 0);
  });

  it('should handle null messages', () => {
    assert.deepEqual(instance.assembleMessages(null, ''), []);
  });

  it('should merge consecutive same-role messages', () => {
    let messages = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'How are you?' },
    ];

    let result = instance.assembleMessages(messages, '');
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('Hello'));
    assert.ok(result[0].content.includes('How are you?'));
  });
});

// =============================================================================
// Generator — text content
// =============================================================================

describe('ClaudeAgent - generator (text content)', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should yield a message block from text content', async () => {
    let events = createMockEvents({ text: '<p>Hello, world!</p>' });
    let agent  = createTestableAgent(ClaudeAgent, events);

    let generator = await agent.execute({
      messages: [], agent: createMockAgent(), session: {}, context: null, apiKey: 'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'message');
    assert.equal(first.value.content.html, '<p>Hello, world!</p>');
  });

  it('should yield a done block with usage stats', async () => {
    let events = createMockEvents({ text: '<p>Done</p>', inputTokens: 200, outputTokens: 50 });
    let agent  = createTestableAgent(ClaudeAgent, events);

    let generator = await agent.execute({
      messages: [], agent: createMockAgent(), session: {}, context: null, apiKey: 'sk-test-key',
    });

    await generator.next();
    let done = await generator.next();
    assert.equal(done.value.type, 'done');
    assert.equal(done.value.content.usage.inputTokens, 200);
    assert.equal(done.value.content.usage.outputTokens, 50);
  });
});

// =============================================================================
// Generator — tool calls
// =============================================================================

describe('ClaudeAgent - generator (tool calls)', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should yield a tool-call block from tool_use content', async () => {
    let events = createMockEvents({
      text: null, toolCalls: [{ id: 'toolu_abc', name: 'bash', input: { command: 'echo hi' } }],
    });

    let agent     = createTestableAgent(ClaudeAgent, events);
    let generator = await agent.execute({
      messages: [], agent: createMockAgent(), session: {}, context: null, apiKey: 'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'tool-call');
    assert.equal(first.value.content.toolName, 'bash');
    assert.equal(first.value.content.toolUseId, 'toolu_abc');
  });

  it('should handle tool result passed back into generator', async () => {
    let firstEvents  = createMockEvents({
      text: null, toolCalls: [{ id: 'toolu_001', name: 'bash', input: { command: 'ls' } }],
    });
    let secondEvents = createMockEvents({ text: '<p>Here are your files.</p>' });

    let agent     = createMultiTurnAgent(ClaudeAgent, [firstEvents, secondEvents]);
    let generator = await agent.execute({
      messages: [], agent: createMockAgent(), session: {}, context: null, apiKey: 'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'tool-call');

    let second = await generator.next({
      type: 'tool-result', content: { output: 'file.txt\nREADME.md', toolUseId: 'toolu_001' },
    });

    assert.equal(second.value.type, 'message');
    assert.equal(second.value.content.html, '<p>Here are your files.</p>');
  });
});

// =============================================================================
// Generator — reflection
// =============================================================================

describe('ClaudeAgent - generator (reflection)', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should yield reflection block from thinking content', async () => {
    let events = createMockEvents({ thinking: 'Let me think...', text: '<p>42</p>' });
    let agent  = createTestableAgent(ClaudeAgent, events);

    let generator = await agent.execute({
      messages: [], agent: createMockAgent(), session: {}, context: null, apiKey: 'sk-test-key',
    });

    let first = await generator.next();
    assert.equal(first.value.type, 'reflection');
    assert.equal(first.value.hidden, true);

    let second = await generator.next();
    assert.equal(second.value.type, 'message');
  });
});

// =============================================================================
// Generator — error handling
// =============================================================================

describe('ClaudeAgent - generator (error handling)', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  it('should throw when no API key is available', async () => {
    let agent = new ClaudeAgent(null);

    let generator = await agent.execute({
      messages: [], agent: createMockAgent({ encryptedAPIKey: null }), session: {}, context: null,
    });

    await assert.rejects(() => generator.next(), { message: /No API key available/ });
  });
});

// =============================================================================
// setup() function
// =============================================================================

describe('ClaudeAgent - setup() function', () => {
  it('should export a setup function', () => {
    assert.equal(typeof setup, 'function');
  });

  it('should register ClaudeAgent via registerAgentType', () => {
    let registered = {};
    let context    = {
      getProperty: () => null,
      setProperty: () => {},
    };

    let teardown = setup({
      context,
      AgentInterface,
      registerAgentType: (id, AgentClass) => { registered[id] = AgentClass; },
    });

    assert.ok(registered.claude);
    assert.equal(typeof teardown, 'function');
  });

  it('should throw when AgentInterface is not provided', () => {
    let context = { getProperty: () => null, setProperty: () => {} };
    assert.throws(
      () => setup({ context, registerAgentType: () => {} }),
      { message: /requires AgentInterface/ },
    );
  });

  it('should return a teardown function', () => {
    let registered = {};
    let context    = {
      getProperty: () => null,
      setProperty: () => {},
    };

    let teardown = setup({
      context,
      AgentInterface,
      registerAgentType: (id, AgentClass) => { registered[id] = AgentClass; },
    });

    assert.equal(typeof teardown, 'function');
  });
});
