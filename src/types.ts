import type { WebSocket } from 'ws';
import type { Client, ClientChannel } from 'ssh2';

export interface SSHSessionConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  keyFilePath?: string;
  passphrase?: string;
}

export interface SSHSessionInfo {
  name: string;
  host: string;
  port: number;
  username: string;
  status: 'connected' | 'disconnected';
  connectedAt: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandSource = 'mcp' | 'browser';
export type TaskState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTask {
  taskId: string;
  sessionName: string;
  command: string;
  state: TaskState;
  startTime: number;
  endTime?: number;
  result?: CommandResult;
  error?: string;
}

export interface QueuedCommand {
  command: string;
  source: CommandSource;
  timeout?: number;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
}

export interface SessionData {
  config: SSHSessionConfig;
  info: SSHSessionInfo;
  client: Client;
  shell: ClientChannel | null;
  wsClients: Set<WebSocket>;
  outputBuffer: string[];
  commandQueue: QueuedCommand[];
  isExecuting: boolean;
  backgroundTasks: Map<string, BackgroundTask>;
  activeStream: ClientChannel | null;
}
