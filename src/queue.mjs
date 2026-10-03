export function mergeJob(queue, job) {
  const included = new Set(job.operation === 'pack' ? job.includeIds : [job.id]);
  const { status, progress, result, error } = job;
  return queue.map((file) =>
    included.has(file.id) ? { ...file, status, progress, result, error } : file,
  );
}
