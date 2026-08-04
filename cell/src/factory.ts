import { Cell, type CellConfig } from './cell.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { Guardrails } from './guardrails.js';
import { HumanInTheLoop } from './hitl.js';
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';
import { type ServerContext } from './server.js';

export interface FactoryOptions {
  basePath: string;
  verificationCommands?: [string, string[]][];
  maxRetries?: number;
  llm?: CellConfig['llm'];
  shellAllowList?: string[];
}

const defaultVerificationCommands: [string, string[]][] = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build']],
  ['npm', ['test']],
];

function budgetFromEnv(basePath: string) {
  return new BudgetTracker({
    basePath,
    tokenLimit: Number(process.env.CELL_TOKEN_LIMIT ?? '0'),
    costLimit: Number(process.env.CELL_COST_LIMIT ?? '0'),
    elapsedMsLimit: Number(process.env.CELL_RUNTIME_LIMIT_MS ?? '0'),
    costPer1kTokens: Number(process.env.CELL_COST_PER_1K_TOKENS ?? '0.002'),
  });
}

function buildServices(basePath: string) {
  const budget = budgetFromEnv(basePath);
  const observability = new Observability({ basePath });
  const guardrails = new Guardrails({
    workspacePath: basePath,
    defaultAllowList: ['npm', 'node', 'echo', 'ls'],
    requireApprovalForDestructive: true,
    approvedDestructive: new Set<string>(),
    observability,
  });
  const hitl = new HumanInTheLoop({ basePath });
  const memoryStore = new MemoryStore({ basePath });
  const retrieval = new RetrievalEngine({ topK: 5 });
  return { budget, observability, guardrails, hitl, memoryStore, retrieval };
}

function buildCell(
  options: FactoryOptions,
  services: ReturnType<typeof buildServices>,
): Cell {
  const { basePath, verificationCommands = defaultVerificationCommands, maxRetries = 3, llm, shellAllowList } = options;
  return new Cell({
    basePath,
    verificationCommands,
    maxRetries,
    llm,
    budget: services.budget,
    observability: services.observability,
    guardrailsInstance: services.guardrails,
    hitl: services.hitl,
    memoryStore: services.memoryStore,
    retrieval: services.retrieval,
    shellAllowList,
  });
}

function buildContext(
  options: FactoryOptions,
  services: ReturnType<typeof buildServices>,
  cell: Cell,
): ServerContext {
  return {
    cell,
    basePath: options.basePath,
    budget: services.budget,
    observability: services.observability,
    guardrails: services.guardrails,
    hitl: services.hitl,
    memoryStore: services.memoryStore,
    verificationCommands: options.verificationCommands ?? defaultVerificationCommands,
  };
}

/**
 * Build a cell and shared HTTP context for **lit factory** mode:
 * humans remain in the loop, destructive actions require explicit approval,
 * and every mission is answerable.
 */
export function createLitFactoryContext(options: FactoryOptions): ServerContext {
  const services = buildServices(options.basePath);
  const cell = buildCell(options, services);
  return buildContext(options, services, cell);
}

/**
 * Build a cell and shared HTTP context for **dark factory** mode:
 * the cell runs without human approval gates, but it still enforces
 * verification, budgets, guardrails (with destructive actions auto-approved),
 * and Git-backed memory.
 *
 * Use this only in fully automated, observable, recoverable pipelines.
 */
export function createDarkFactoryContext(options: FactoryOptions): ServerContext {
  const basePath = options.basePath;
  const budget = budgetFromEnv(basePath);
  const observability = new Observability({ basePath });
  const guardrails = new Guardrails({
    workspacePath: basePath,
    defaultAllowList: ['npm', 'node', 'echo', 'ls', 'git', 'docker', 'rm', 'cp', 'mv'],
    requireApprovalForDestructive: false,
    approvedDestructive: new Set<string>(['*']),
    observability,
  });
  const hitl = new HumanInTheLoop({
    basePath,
    requireApprovalForTools: [],
    requireApprovalForInput: [],
    requireApprovalForProtectedFiles: false,
    protectedPatterns: [],
  });
  const memoryStore = new MemoryStore({ basePath });
  const retrieval = new RetrievalEngine({ topK: 5 });
  const services = { budget, observability, guardrails, hitl, memoryStore, retrieval };
  const cell = buildCell(options, services);
  return buildContext(options, services, cell);
}
