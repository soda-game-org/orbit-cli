export type OrbitWebState = {
  runs: Array<Record<string, any>>
  threads: Array<Record<string, any>>
  [key: string]: any
}

export function mergeRunDelta<T extends OrbitWebState>(current: T, delta: Record<string, any>): T {
  const run = delta?.run
  if (!run?.id) return current
  const previousRun = current.runs.find((candidate) => candidate.id === run.id)
  const runs = [{ ...previousRun, ...run }, ...current.runs.filter((candidate) => candidate.id !== run.id)]
  const incomingThread = delta?.thread
  if (!incomingThread?.id) return { ...current, runs }
  const previousThread = current.threads.find((candidate) => candidate.id === incomingThread.id)
  const runIds = [...new Set([
    ...(Array.isArray(previousThread?.runIds) ? previousThread.runIds : []),
    ...(Array.isArray(incomingThread.runIds) ? incomingThread.runIds : []),
    run.id,
  ])]
  const thread = {
    ...previousThread,
    ...incomingThread,
    runIds,
    latestRunId: incomingThread.latestRunId || run.id,
    createdAt: previousThread?.createdAt || incomingThread.createdAt,
  }
  return { ...current, runs, threads: [thread, ...current.threads.filter((candidate) => candidate.id !== thread.id)] }
}
