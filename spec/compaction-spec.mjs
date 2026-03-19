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

// =============================================================================
// shouldCompact()
// =============================================================================

describe('ClaudeAgent - shouldCompact()', () => {
  let ClaudeAgent;
  let instance;

  before(() => {
    ClaudeAgent = getClaudeAgent();
    instance    = new ClaudeAgent(null);
  });

  it('should return compact: false when below 80% threshold', () => {
    let result = instance.shouldCompact({ estimatedTokens: 70000, contextWindow: 100000 });
    assert.equal(result.compact, false);
    assert.equal(result.reason, '');
  });

  it('should return compact: true at exactly 80% threshold', () => {
    // 80% of 100000 = 80000
    let result = instance.shouldCompact({ estimatedTokens: 80000, contextWindow: 100000 });
    assert.equal(result.compact, true);
    assert.ok(result.reason.includes('80000'));
    assert.ok(result.reason.includes('threshold'));
  });

  it('should return compact: true above 80% threshold', () => {
    let result = instance.shouldCompact({ estimatedTokens: 95000, contextWindow: 100000 });
    assert.equal(result.compact, true);
    assert.ok(result.reason.includes('95000'));
    assert.ok(result.reason.includes('threshold'));
  });

  it('should return compact: false when contextWindow is missing', () => {
    let result = instance.shouldCompact({ estimatedTokens: 50000 });
    assert.equal(result.compact, false);
    assert.equal(result.reason, '');
  });

  it('should return compact: false when contextWindow is 0', () => {
    let result = instance.shouldCompact({ estimatedTokens: 50000, contextWindow: 0 });
    assert.equal(result.compact, false);
    assert.equal(result.reason, '');
  });

  it('should return compact: false when estimatedTokens is missing', () => {
    let result = instance.shouldCompact({ contextWindow: 100000 });
    assert.equal(result.compact, false);
    assert.equal(result.reason, '');
  });

  it('should return compact: false when estimatedTokens is 0', () => {
    let result = instance.shouldCompact({ estimatedTokens: 0, contextWindow: 100000 });
    assert.equal(result.compact, false);
    assert.equal(result.reason, '');
  });
});

// =============================================================================
// getMaxCompactionTokens()
// =============================================================================

describe('ClaudeAgent - getMaxCompactionTokens()', () => {
  let ClaudeAgent;
  let instance;

  before(() => {
    ClaudeAgent = getClaudeAgent();
    instance    = new ClaudeAgent(null);
  });

  it('should return 30% of contextWindow', () => {
    let result = instance.getMaxCompactionTokens({ contextWindow: 100000 });
    assert.equal(result, 30000);
  });

  it('should return 30% of contextWindow (non-round number)', () => {
    // 30% of 200000 = 60000
    let result = instance.getMaxCompactionTokens({ contextWindow: 200000 });
    assert.equal(result, 60000);
  });

  it('should floor the result', () => {
    // 30% of 33333 = 9999.9 → floor to 9999
    let result = instance.getMaxCompactionTokens({ contextWindow: 33333 });
    assert.equal(result, 9999);
  });

  it('should return 8000 when contextWindow is missing', () => {
    let result = instance.getMaxCompactionTokens({});
    assert.equal(result, 8000);
  });

  it('should return 8000 when contextWindow is 0', () => {
    let result = instance.getMaxCompactionTokens({ contextWindow: 0 });
    assert.equal(result, 8000);
  });
});

// =============================================================================
// _createSingleTurn()
// =============================================================================

describe('ClaudeAgent - _createSingleTurn()', () => {
  let ClaudeAgent;

  before(() => { ClaudeAgent = getClaudeAgent(); });

  function createMockInstance(mockResponse) {
    let instance    = new ClaudeAgent(null);
    let capturedReq = null;

    instance._createClient = function (_apiKey) {
      return {
        messages: {
          create: async (params) => {
            capturedReq = params;
            return mockResponse;
          },
        },
      };
    };

    return { instance, getCapturedReq: () => capturedReq };
  }

  it('should call Anthropic client with correct model and messages', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'compacted summary' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    let messages = [{ role: 'user', content: 'compact this conversation' }];
    await instance._createSingleTurn(messages, { apiKey: 'sk-test', model: 'claude-sonnet-4-20250514' });

    let req = getCapturedReq();
    assert.equal(req.model, 'claude-sonnet-4-20250514');
    assert.deepEqual(req.messages, messages);
  });

  it('should return text from response', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'compacted summary here' }],
    };

    let { instance } = createMockInstance(mockResponse);

    let result = await instance._createSingleTurn(
      [{ role: 'user', content: 'compact this' }],
      { apiKey: 'sk-test' },
    );

    assert.equal(result, 'compacted summary here');
  });

  it('should pass maxTokens to API call', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'ok' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test', maxTokens: 4000 },
    );

    let req = getCapturedReq();
    assert.equal(req.max_tokens, 4000);
  });

  it('should default maxTokens to 8000 when not provided', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'ok' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test' },
    );

    let req = getCapturedReq();
    assert.equal(req.max_tokens, 8000);
  });

  it('should pass systemPrompt to API call', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'ok' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test', systemPrompt: 'You are a compactor agent.' },
    );

    let req = getCapturedReq();
    assert.equal(req.system, 'You are a compactor agent.');
  });

  it('should pass system as undefined when systemPrompt not provided', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'ok' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test' },
    );

    let req = getCapturedReq();
    assert.equal(req.system, undefined);
  });

  it('should use DEFAULT_MODEL when model not provided', async () => {
    let mockResponse = {
      content: [{ type: 'text', text: 'ok' }],
    };

    let { instance, getCapturedReq } = createMockInstance(mockResponse);

    await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test' },
    );

    let req = getCapturedReq();
    assert.equal(req.model, 'claude-sonnet-4-20250514');
  });

  it('should return empty string if no text block in response', async () => {
    let mockResponse = {
      content: [{ type: 'tool_use', id: 'toolu_123', name: 'test', input: {} }],
    };

    let { instance } = createMockInstance(mockResponse);

    let result = await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test' },
    );

    assert.equal(result, '');
  });

  it('should return empty string if response content is empty', async () => {
    let mockResponse = { content: [] };

    let { instance } = createMockInstance(mockResponse);

    let result = await instance._createSingleTurn(
      [{ role: 'user', content: 'test' }],
      { apiKey: 'sk-test' },
    );

    assert.equal(result, '');
  });

  it('should throw if API call fails (let caller handle)', async () => {
    let instance = new ClaudeAgent(null);

    instance._createClient = function () {
      return {
        messages: {
          create: async () => { throw new Error('API rate limited'); },
        },
      };
    };

    await assert.rejects(
      () => instance._createSingleTurn(
        [{ role: 'user', content: 'test' }],
        { apiKey: 'sk-test' },
      ),
      { message: 'API rate limited' },
    );
  });

  it('should throw if apiKey is not provided', async () => {
    let instance = new ClaudeAgent(null);

    await assert.rejects(
      () => instance._createSingleTurn(
        [{ role: 'user', content: 'test' }],
        {},
      ),
      { message: /apiKey is required/ },
    );
  });

  it('should find the text block even among mixed content blocks', async () => {
    let mockResponse = {
      content: [
        { type: 'thinking', thinking: 'hmm...' },
        { type: 'text', text: 'the actual summary' },
      ],
    };

    let { instance } = createMockInstance(mockResponse);

    let result = await instance._createSingleTurn(
      [{ role: 'user', content: 'compact this' }],
      { apiKey: 'sk-test' },
    );

    assert.equal(result, 'the actual summary');
  });
});
