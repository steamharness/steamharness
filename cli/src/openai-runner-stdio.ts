export interface OpenAIRunnerWritable {
  write: (...args: unknown[]) => unknown;
}

export type OpenAIProtocolLineWriter = (line: string) => void;

export function isolateOpenAIRunnerStdout(
  stdout: OpenAIRunnerWritable = process.stdout as unknown as OpenAIRunnerWritable,
  stderr: OpenAIRunnerWritable = process.stderr as unknown as OpenAIRunnerWritable,
): OpenAIProtocolLineWriter {
  const protocolWrite = stdout.write.bind(stdout);
  stdout.write = (...args: unknown[]) => stderr.write(...args);
  return (line: string) => {
    protocolWrite(line);
  };
}
