import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {
  SSHSessionConfig,
  SSHSessionInfo,
  CommandResult,
  CommandSource,
  BackgroundTask,
  SessionData,
} from './types.js';

const MAX_BUFFER_LINES = 500;

export class SSHManager {
  private sessions = new Map<string, SessionData>();

  async connect(config: SSHSessionConfig): Promise<SSHSessionInfo> {
    if (this.sessions.has(config.name)) {
      throw new Error(`Session "${config.name}" already exists`);
    }

    const client = new Client();
    const port = config.port ?? 22;

    const info: SSHSessionInfo = {
      name: config.name,
      host: config.host,
      port,
      username: config.username,
      status: 'connected',
      connectedAt: new Date().toISOString(),
    };

    await new Promise<void>((resolve, reject) => {
      const connectConfig: Record<string, unknown> = {
        host: config.host,
        port,
        username: config.username,
      };

      if (config.keyFilePath) {
        connectConfig.privateKey = this.readKeyFile(config.keyFilePath);
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase;
        }
      } else if (config.privateKey) {
        connectConfig.privateKey = config.privateKey;
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      }

      client.on('ready', () => resolve());
      client.on('error', (err: Error) => reject(err));
      client.connect(connectConfig);
    });

    const sessionData: SessionData = {
      config,
      info,
      client,
      shell: null,
      wsClients: new Set(),
      outputBuffer: [],
      commandQueue: [],
      isExecuting: false,
      backgroundTasks: new Map(),
      activeStream: null,
    };

    client.on('close', () => {
      sessionData.info.status = 'disconnected';
      sessionData.activeStream = null;
    });

    this.sessions.set(config.name, sessionData);
    return info;
  }

  async exec(
    sessionName: string,
    command: string,
    opts?: { timeout?: number; source?: CommandSource }
  ): Promise<CommandResult> {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }
    if (session.info.status !== 'connected') {
      throw new Error(`Session "${sessionName}" is disconnected`);
    }

    return new Promise<CommandResult>((resolve, reject) => {
      session.commandQueue.push({
        command,
        source: opts?.source ?? 'mcp',
        timeout: opts?.timeout,
        resolve,
        reject,
      });
      this.processQueue(sessionName);
    });
  }

  disconnect(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }

    session.info.status = 'disconnected';

    for (const ws of session.wsClients) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Session disconnected' }));
        ws.close();
      } catch {
        // ignore send errors on closing sockets
      }
    }
    session.wsClients.clear();

    if (session.activeStream) {
      try {
        session.activeStream.close();
      } catch {
        // ignore
      }
      session.activeStream = null;
    }

    session.client.destroy();
    this.sessions.delete(sessionName);
  }

  listSessions(): SSHSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  getTask(sessionName: string, taskId: string): BackgroundTask | undefined {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }
    return session.backgroundTasks.get(taskId);
  }

  cancelCommand(sessionName: string, taskId?: string): boolean {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }

    if (taskId) {
      const task = session.backgroundTasks.get(taskId);
      if (task && task.state === 'running') {
        task.state = 'cancelled';
        task.endTime = Date.now();
        return true;
      }
      return false;
    }

    if (session.activeStream) {
      try {
        session.activeStream.signal!('INT');
        return true;
      } catch {
        // signal not supported, try closing
        try {
          session.activeStream.close();
        } catch {
          // ignore
        }
        return true;
      }
    }

    return false;
  }

  addWsClient(sessionName: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found`);
    }

    session.wsClients.add(ws);

    // Replay output buffer as history
    if (session.outputBuffer.length > 0) {
      const history = session.outputBuffer.join('');
      try {
        ws.send(JSON.stringify({
          type: 'terminal_history',
          sessionName,
          data: history,
        }));
      } catch {
        // ignore send errors
      }
    }
  }

  removeWsClient(sessionName: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionName);
    if (!session) return;
    session.wsClients.delete(ws);
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  cleanup(): void {
    for (const name of Array.from(this.sessions.keys())) {
      try {
        this.disconnect(name);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // --- Private helpers ---

  private broadcastOutput(sessionName: string, data: string): void {
    const session = this.sessions.get(sessionName);
    if (!session) return;

    // Normalize line endings for xterm.js
    const normalized = data.replace(/\r?\n/g, '\r\n');

    // Buffer the output
    session.outputBuffer.push(normalized);
    while (session.outputBuffer.length > MAX_BUFFER_LINES) {
      session.outputBuffer.shift();
    }

    // Send to all connected WebSocket clients
    const message = JSON.stringify({
      type: 'terminal_output',
      sessionName,
      data: normalized,
    });

    for (const ws of session.wsClients) {
      try {
        ws.send(message);
      } catch {
        // remove dead clients
        session.wsClients.delete(ws);
      }
    }
  }

  private processQueue(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (!session || session.isExecuting || session.commandQueue.length === 0) {
      return;
    }

    session.isExecuting = true;
    const queued = session.commandQueue.shift()!;

    this.executeCommand(session, queued, sessionName).finally(() => {
      session.isExecuting = false;
      this.processQueue(sessionName);
    });
  }

  private async executeCommand(
    session: SessionData,
    queued: { command: string; source: CommandSource; timeout?: number; resolve: (r: CommandResult) => void; reject: (e: Error) => void },
    sessionName: string
  ): Promise<void> {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let backgroundTaskId: string | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        session.client.exec(queued.command, (err, stream) => {
          if (err) return reject(err);
          resolve(stream);
        });
      });

      session.activeStream = stream;

      // Set up timeout if specified
      if (queued.timeout && queued.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (resolved) return;
          resolved = true;

          // Transition to background task
          backgroundTaskId = randomUUID();
          const task: BackgroundTask = {
            taskId: backgroundTaskId,
            sessionName,
            command: queued.command,
            state: 'running',
            startTime: Date.now(),
          };
          session.backgroundTasks.set(backgroundTaskId, task);

          // Keep stream running, resolve with async marker
          queued.reject(new Error(`ASYNC_TIMEOUT:${backgroundTaskId}`));

          // Continue collecting output in background
          stream.on('close', (code: number) => {
            task.state = task.state === 'cancelled' ? 'cancelled' : 'completed';
            task.endTime = Date.now();
            task.result = {
              stdout,
              stderr,
              exitCode: code ?? -1,
            };
            session.activeStream = null;
          });
        }, queued.timeout);
      }

      stream.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.broadcastOutput(sessionName, text);
      });

      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.broadcastOutput(sessionName, text);
      });

      await new Promise<void>((resolveStream, rejectStream) => {
        stream.on('close', (code: number) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          session.activeStream = null;

          if (!resolved) {
            resolved = true;

            // If this was transitioned to a background task, update it
            if (backgroundTaskId) {
              const task = session.backgroundTasks.get(backgroundTaskId);
              if (task) {
                task.state = task.state === 'cancelled' ? 'cancelled' : 'completed';
                task.endTime = Date.now();
                task.result = { stdout, stderr, exitCode: code ?? -1 };
              }
            } else {
              queued.resolve({ stdout, stderr, exitCode: code ?? -1 });
            }
          }
          resolveStream();
        });

        stream.on('error', (err: Error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          session.activeStream = null;

          if (!resolved) {
            resolved = true;
            queued.reject(err);
          }
          rejectStream(err);
        });
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        queued.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private readKeyFile(filePath: string): string {
    const expanded = filePath.startsWith('~')
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;
    return fs.readFileSync(expanded, 'utf-8');
  }
}
