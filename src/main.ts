import { createInterface, type Interface } from 'node:readline';
import { getAppStateStore } from './state/store.ts';
import { AppStateManager, selectMessages } from './state/AppState.ts';
import { getToolRegistry } from './tools.ts';
import { getCommandRegistry } from './commands.ts';
import { getCostTracker } from './cost-tracker.ts';
import { autoSaveSession, shouldCompact, compactMessages, generateSessionTitle } from './history.ts';
import {
  queryClaudeStream,
  buildQuerySystemPrompt,
  executeToolCalls,
  createToolResultMessage,
} from './query.ts';
import { detectShell } from './utils/shell.ts';
import type { UserMessage, AssistantMessage, TextBlock, ThinkingBlock } from './types/message.ts';
import type { CommandResult } from './types/command.ts';

export interface AppOptions {
  prompt?: string;
  model?: string;
  sessionId?: string;
  workingDir?: string;
  nonInteractive?: boolean;
  stream?: boolean;
  dangerouslyNoPermissionRequests?: boolean;
}

export interface AppInstance {
  repl: Interface;
  abort: () => void;
  submit: (input: string) => Promise<void>;
  run: () => Promise<void>;
}

const COMMAND_PREFIX = '/';
const MAX_CONSECUTIVE_TOOL_TURNS = 10;
const MAX_IDENTICAL_TOOL_CALLS = 3;

export function createApp(options: AppOptions = {}): AppInstance {
  let abortController: AbortController | null = null;
  let isRunning = false;

  const repl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '\x1b[36m> \x1b[0m',
  });

  const abort = (): void => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const submit = async (input: string): Promise<void> => {
    if (!input.trim()) return;

    const store = getAppStateStore();
    const state = store.getState();

    // Add to input history
    const inputHistory = [...state.inputHistory, input];
    store.setState({
      inputHistory,
      inputHistoryIndex: -1,
    });

    // Handle slash commands
    if (input.startsWith(COMMAND_PREFIX)) {
      const result = await handleCommand(input, store);
      if (result.exitCode !== undefined) {
        handleCommandResult(result);
      }
      return;
    }

    // Handle user message
    await processUserMessage(input, options, store);
  };

  const run = async (): Promise<void> => {
    const store = getAppStateStore();
    store.setState({ isActive: true });

    // Process initial prompt if provided
    if (options.prompt) {
      await submit(options.prompt);
    }

    // REPL loop
    if (!options.nonInteractive) {
      repl.prompt();

      repl.on('line', async (line: string) => {
        await submit(line);
        if (store.getState().isActive) {
          repl.prompt();
        }
      });

      repl.on('close', () => {
        store.setState({ isActive: false });
        process.exit(0);
      });
    }
  };

  return { repl, abort, submit, run };
}

async function handleCommand(
  input: string,
  store: ReturnType<typeof getAppStateStore>,
): Promise<CommandResult> {
  const registry = getCommandRegistry();
  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0];
  const args = parts.slice(1);
  const flags: Record<string, string | boolean> = {};

  const ctx = {
    state: store.getState(),
    args,
    flags,
    signal: new AbortController().signal,
  };

  try {
    const result = await registry.execute(cmdName, ctx);
    if (result.data) {
      console.log(result.data as string);
    }
    if (result.message) {
      console.log(result.message);
    }
    if (cmdName === 'exit' || cmdName === 'quit' || cmdName === 'q') {
      store.setState({ isActive: false });
      process.exit(0);
    }
    return result;
  } catch (err) {
    console.error(`Command error: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, message: String(err) };
  }
}

function handleCommandResult(result: CommandResult): void {
  if (result.data) {
    console.log(result.data as string);
  }
  if (result.message) {
    console.log(result.message);
  }
}

async function processUserMessage(
  input: string,
  options: AppOptions,
  store: ReturnType<typeof getAppStateStore>,
): Promise<void> {
  const state = store.getState();

  // Ensure conversation exists
  if (!state.conversation) {
    const conv = AppStateManager.createConversation(state.model);
    store.setState({ conversation: conv });
  }

  // Add user message
  const userMessage: UserMessage = {
    type: 'user',
    role: 'user',
    content: input,
    uuid: generateMessageId(),
    timestamp: Date.now(),
    sessionId: state.sessionId,
  };

  store.setState({ messages: [...state.messages, userMessage] });

  // Process with model
  await runConversationLoop(store, options, userMessage);
}

function makeConfirmFn(): (toolName: string, input: Record<string, unknown>) => Promise<boolean> {
  return (toolName, input) =>
    new Promise((resolve) => {
      const desc = input.description ?? input.command ?? input.file_path ?? '';
      const hint = desc ? ` (${String(desc).slice(0, 60)})` : '';
      process.stdout.write(`\n\x1b[33mAllow '${toolName}'${hint}? [Y/n]: \x1b[0m`);
      const { createInterface: _createInterface } = require('node:readline');
      const rl = _createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.once('line', (answer: string) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
      });
    });
}

async function runConversationLoop(
  store: ReturnType<typeof getAppStateStore>,
  options: AppOptions,
  initiatingMessage: UserMessage,
): Promise<void> {
  let state = store.getState();
  const toolRegistry = getToolRegistry();
  const costTracker = getCostTracker();
  let consecutiveToolTurns = 0;
  const toolCallFrequency = new Map<string, number>();

  store.setState({ isThinking: true, currentProgress: 'Thinking...' });

  try {
    while (consecutiveToolTurns < MAX_CONSECUTIVE_TOOL_TURNS) {
      state = store.getState();

      // Compact messages when approaching threshold
      if (shouldCompact(state.messages)) {
        console.log('\x1b[33mCompacting conversation (message limit approaching)...\x1b[0m');
        const compacted = compactMessages(state.messages);
        store.setState({ messages: compacted, currentProgress: 'Thinking...' });
        state = store.getState();
      }

      // Build system prompt
      const shell = detectShell();
      const systemPrompt = buildQuerySystemPrompt(
        toolRegistry.list(),
        state.workingDirectory,
        process.platform,
        shell.type,
        state.gitBranch ?? '',
        state.sessionId,
        state.model,
      );

      // Build messages for API
      const messages = selectMessages(state);

      // Stream query
      let assistantText = '';
      let assistantThinking = '';
      const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
      let finalUsage = { inputTokens: 0, outputTokens: 0 };

      const stream = queryClaudeStream({
        messages,
        systemPrompt,
        model: state.model,
        tools: toolRegistry.list(),
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          assistantText += event.text ?? '';
          process.stdout.write(event.text ?? '');
          state = store.getState();
        } else if (event.type === 'thinking') {
          assistantThinking += event.thinking ?? '';
          state = store.getState();
        } else if (event.type === 'tool_use' && event.toolCall) {
          toolCalls.push(event.toolCall);
          state = store.getState();
        } else if (event.type === 'usage' && event.usage) {
          finalUsage = event.usage;
        } else if (event.type === 'error') {
          console.error(`\n\x1b[31mError: ${event.error}\x1b[0m`);
        } else if (event.type === 'done') {
          if (event.usage) {
            finalUsage = event.usage;
          }
        }
      }

      // Build assistant message
      const assistantBlocks: (TextBlock | ThinkingBlock)[] = [];
      if (assistantText) {
        assistantBlocks.push({ type: 'text', text: assistantText });
      }
      if (assistantThinking) {
        assistantBlocks.push({ type: 'thinking', thinking: assistantThinking });
      }

      const assistantMessage: AssistantMessage = {
        type: 'assistant',
        role: 'assistant',
        content: assistantBlocks.length > 0 ? assistantBlocks : [{ type: 'text', text: '' }],
        uuid: generateMessageId(),
        parentUuid: initiatingMessage.uuid,
        timestamp: Date.now(),
        model: state.model,
        usage: finalUsage,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };

      // Track cost
      if (finalUsage.inputTokens > 0 || finalUsage.outputTokens > 0) {
        costTracker.recordTurn(state.model, finalUsage);
      }

      // Add assistant message
      store.setState({
        messages: [...state.messages, assistantMessage],
      });

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        break;
      }

      // Separate looping calls from normal ones.
      // Looping calls get a synthetic guidance result so the model can self-correct;
      // normal calls execute as usual. The hard turn limit remains the safety net.
      const normalCalls: typeof toolCalls = [];
      const loopGuidanceMessages: import('./types/message.ts').Message[] = [];

      for (const call of toolCalls) {
        const key = `${call.name}:${JSON.stringify(call.input)}`;
        const count = (toolCallFrequency.get(key) ?? 0) + 1;
        toolCallFrequency.set(key, count);

        if (count >= MAX_IDENTICAL_TOOL_CALLS) {
          const guidance =
            `You have called '${call.name}' ${count} times with identical input and received ` +
            `the same result each time. Calling it again will not produce a different outcome. ` +
            `Please try a different approach, use a different tool, or explain to the user why you cannot proceed.`;
          console.log(`\n\x1b[33mTool loop: '${call.name}' called ${count}x — injecting guidance.\x1b[0m`);
          loopGuidanceMessages.push(createToolResultMessage(call.callId, { content: guidance, isError: false }));
          toolCallFrequency.delete(key); // reset so a genuine retry is allowed later
        } else {
          normalCalls.push(call);
        }
      }

      // Execute tool calls
      console.log(`\n\x1b[2mExecuting ${normalCalls.length} tool call(s)...\x1b[0m`);
      store.setState({ currentProgress: `Executing tools (${normalCalls.length})...` });

      const permMode = state.permissionMode;
      const confirmFn =
        permMode === 'default' || permMode === 'acceptEdits'
          ? makeConfirmFn()
          : undefined;

      const executed = normalCalls.length > 0
        ? await executeToolCalls(
          normalCalls,
          toolRegistry.tools,
          {
            sessionId: state.sessionId,
            permissionMode: state.permissionMode,
            workingDirectory: state.workingDirectory,
            signal: new AbortController().signal,
            messages: store.getState().messages,
            confirmFn,
            onProgress: (toolName, status) => {
              if (status === 'started') {
                store.setState({ currentProgress: `Running: ${toolName}` });
              }
            },
          },
        )
        : { messages: [], functionCallOutputs: [] };

      // Add tool results (including any loop guidance) and continue loop
      store.setState({
        messages: [...store.getState().messages, ...executed.messages, ...loopGuidanceMessages],
        currentProgress: 'Thinking...',
      });

      consecutiveToolTurns++;
    }

    if (consecutiveToolTurns >= MAX_CONSECUTIVE_TOOL_TURNS) {
      console.log('\n\x1b[33mMax tool call turns reached.\x1b[0m');
    }

    // Auto-save after each turn
    const currentState = store.getState();
    const conv = currentState.conversation;
    if (conv) {
      const updatedConv = {
        ...conv,
        messages: currentState.messages,
        updatedAt: Date.now(),
        title: (conv.title && conv.title !== 'New Session')
          ? conv.title
          : generateSessionTitle(currentState.messages),
      };
      autoSaveSession(updatedConv, costTracker.getSessionCost().totalCostCents);
      store.setState({ conversation: updatedConv });
    }
  } catch (err) {
    console.error(`\n\x1b[31mQuery error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  } finally {
    store.setState({
      isThinking: false,
      currentProgress: null,
    });
  }

  console.log(); // Final newline after response
}

export async function startup(options: AppOptions): Promise<AppInstance> {
  // State is already initialized by init.ts entrypoint
  const store = getAppStateStore();

  // Apply options
  if (options.model) {
    store.setState({ model: options.model });
  }
  if (options.workingDir) {
    store.setState({ workingDirectory: options.workingDir });
  }
  if (options.dangerouslyNoPermissionRequests) {
    store.setState({ permissionMode: 'bypassPermissions' });
  }
  if (options.sessionId) {
    const { loadSession } = await import('./history.ts');
    const conv = loadSession(options.sessionId);
    if (conv) {
      store.setState({
        sessionId: conv.id,
        messages: conv.messages,
        model: conv.model,
        conversation: conv,
      });
    }
  }

  return createApp(options);
}

function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export { getAppStateStore, getToolRegistry, getCommandRegistry, getCostTracker };
