/**
 * Runs `run` over every input with at most `concurrency` executions in flight at
 * once, preserving input order in the returned results. Shared by the parallel
 * sub-agent scheduler and the tool-calling loop so both bound fan-out the same
 * way.
 */
export async function runBoundedParallel<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  run: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Map<number, TOutput>();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results.set(currentIndex, await run(inputs[currentIndex]!));
    }
  });
  await Promise.all(workers);
  return inputs.map((_, index) => {
    const result = results.get(index);
    if (result === undefined) {
      throw new Error(`Parallel worker did not produce result ${index}.`);
    }
    return result;
  });
}
